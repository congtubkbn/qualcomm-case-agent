# 0004. Revive password autofill on session expiry — OTP always stays manual

Date: 2026-08-28
Status: Accepted

## Context

`qualcomm-case-agent` authenticates against Okta SSO with email OTP (6-digit code, ~5 min expiry,
delivered to a Samsung mailbox Claude cannot read). When the persistent Chrome session lapses,
`run_case.mjs` halts with `auth-required` and a human completes the entire Okta flow by hand.

This is the second time this decision has been revisited:

- Commit `b64de47` ("migrate to persistent manual login, remove DPAPI auth", 2026-07-29) deleted
  `okta_login.ps1` and `capture_password.ps1` — a working DPAPI-based password autofill (OTP was
  already manual-only then) — on the reasoning that persistent-profile session reuse (~30 day
  "Keep me signed in") made `auth-required` rare enough that the automation wasn't worth
  maintaining. A PRD since deleted from the repo (superseded by GitHub issues) listed "no password
  autofill/DPAPI" as a Definition of Done.
- On 2026-08-22 the user asked to revive it, was reminded of this history, and declined.

Neither prior removal was a security-incident response — no compromise or account-lockout event is
recorded. The stated reason was "obsolete given session persistence." Session persistence has not
eliminated `auth-required` in practice (it recurred this session, prompting this ADR), so the
tradeoff is being struck differently this time: the manual re-login only saves the OTP step, and
that step already requires a human. Automating the surrounding username/password steps costs no
extra manual toil to remove and shortens a real recurring interruption.

## Decision

Password autofill (not "auto-login" — OTP always stays human) is reintroduced, rebuilt to match
the current architecture rather than restored verbatim:

- **Mechanism**: a new page script (`login_fill.js`) executed via `CdpClient.eval()` /
  `browser.mjs`, matching the established page-script pattern (`readiness.js`, `expand_step.js`) —
  not a revival of `okta_login.ps1`'s `agent-browser` CLI approach.
- **Trigger**: the first `AUTH` state detected inside `fast_landing.mjs` in a given `run_case.mjs`
  invocation attempts autofill; a second `AUTH` sighting in the same run does not re-trigger a
  fresh fill attempt (see retry limit below).
- **Secret**: reuses the existing DPAPI-protected `data/.secrets/qid.bin` (`CurrentUser` scope,
  git-ignored) rather than forcing a fresh capture up front. `capture_password.ps1` is restored to
  produce/replace this file.
- **Retry limit**: up to 3 retries when a fill attempt fails for a technical reason (DOM not yet
  ready, click didn't register) — never a resubmission of the same password after Okta has
  explicitly rejected it. A rejected password immediately deletes `qid.bin` and reports a status
  asking the user to recapture; it is never retried blindly, since resubmitting an unchanged wrong
  password only spends attempts against Okta's account-lockout threshold for zero chance of a
  different outcome.
- **OTP handoff**: once past the password step, the run polls (bounded to ~5 minutes, matching the
  OTP's own expiry) for the human to enter the OTP directly in the visible Chrome window, then
  resumes capture automatically in the same invocation — no second command needed. If the window
  elapses without success, the run reports a new `otp-timeout` status, distinct from
  `auth-required`, so the caller knows the password step already succeeded and only OTP entry
  remains.
- **Never** log or echo the password or OTP anywhere (console, diagnostics, verdict JSON).

## Considered Options

- **Restore `okta_login.ps1`/`agent-browser` verbatim.** Rejected: reintroduces a dependency the
  codebase has been moving away from for in-page automation (native CDP eval is the established
  pattern post-port-conflict-fix); the old script's DOM assumptions were last confirmed 2026-06 and
  are unverified against the current Okta UI.
- **Unlimited or fixed-count retries applied uniformly to any fill failure, including a rejected
  password.** Rejected: retrying an unchanged, already-rejected password against Okta has zero
  chance of succeeding and only accumulates failed-login attempts toward a possible lockout.
- **Reuse the `auth-required` status for the OTP-timeout case.** Rejected: collapses two different
  situations (nothing has been attempted yet vs. password already succeeded, only OTP remains) into
  one signal, forcing the caller to re-explain the full manual login flow when only the OTP step is
  actually outstanding.

## Consequences

- `qualcomm-case-summary` and `qualcomm-case-overview` both delegate case capture to
  `run_case.mjs`/`captureCase` and need no changes of their own to benefit.
- SKILL.md's verdict table gains a new `otp-timeout` row; callers must branch on it distinctly from
  `auth-required`.
- A future reader tempted to remove this again should read this ADR's Context section first — the
  Definition of Done this reverses was reasoned, not accidental, and reversing it here is likewise
  a considered tradeoff, not a default to flip back without cause.
