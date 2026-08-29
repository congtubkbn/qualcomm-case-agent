# Qualcomm Case Management Agent — Troubleshooting & Recovery Guide

Authoritative runbook for resolving pipeline blockers when `scripts/run_case.mjs` returns a non-zero exit or non-success verdict (`otp-timeout`, `auth-required`, `blocked`, `not-found`, `busy`, `port-conflict`).

---

## Verdict Routing & Actions

| Exit | Verdict `status` | Root Cause | Action |
|------|------------------|------------|--------|
| 2 | `otp-timeout` | Password autofilled OK; the ~5min OTP window elapsed before the human entered the code | → **Recovery 1 (enter OTP now, then re-run — no need to redo the password step)** |
| 3 | `auth-required` | Okta SSO session expired (stored password was rejected, or autofill exhausted retries / AUTH re-encountered) | → **Recovery 1 (Okta Re-auth: autofill-first, manual fallback)** |
| 4 | `not-found` | Case does not exist or account lacks access | → **Recovery 2 (Case Not Found / Authorization)** |
| 5 | `blocked` | Feed expansion stuck / DOM unrendered (or CDP connection unavailable) | → **Recovery 3 (Stuck Page / DOM Recovery)**, or **Recovery 0** if reason indicates CDP connection unavailable |
| 6 | `busy` | Lock file `data/.capture.lock` is held by an active capture | → **Recovery 4 (Lock Contention)** |
| 7 | `port-conflict` | CDP port held by a process that isn't our Chrome | → **Recovery 5 (Port Conflict)** |
| 1 | `error` / CDP Refused | Chrome crashed, port 9773 unreachable, or credentials unconfigured (`npm run setup:credentials`) | → **Recovery 0 (Chrome / CDP Port Reset)** or configure credentials |

---

## Recovery 0: Chrome & CDP Port 9773 Reset

Triggered when CDP connection is refused (`ECONNREFUSED` on port 9773) or Chrome processes become unresponsive.

1. **Kill stale Chrome instances and reset port 9773**:
   ```bash
   powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1"
   ```
2. **Verify CDP readiness**:
   ```bash
   curl -s http://127.0.0.1:9773/json/version
   ```
   *Expected result*: HTTP 200 with JSON payload containing `webSocketDebuggerUrl`.
3. **Retry capture**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
   ```

---

## Recovery 1: Okta Session Re-Authentication (`otp-timeout` / `auth-required`)

Triggered when the saved session in `data/chrome-profile/` has lapsed and Qualcomm redirects to `account.qualcomm.com`. As of ADR 0004, `run_case.mjs` attempts password autofill first (via
`login_fill.js` over `CdpClient.eval()` — not the retired `okta_login.ps1`/`agent-browser`
mechanism) and only falls all the way back to a fully manual walkthrough when that's not possible.

> [!NOTE]
> `run_case.mjs`'s CLI entry point performs a pre-flight credential check (`run_case.mjs:634-644`). If no stored secret (`data/.secrets/qid.bin`) or username exists at all, the process exits early with code 1 (`status: error`) prompting to run `npm run setup:credentials` before ever touching the browser. Consequently, `auth-required` (exit 3) today only arises from `fast_landing.mjs`'s in-browser execution paths after a secret is present and autofill was attempted.

1. **`otp-timeout` (exit 2) — password already succeeded, only OTP is outstanding (genuinely manual)**:
   - The stored secret was autofilled and Okta accepted it; the run waited ~5 min for the OTP and
     timed out.
   - Switch to the Chrome window on port 9773 (it's still on the OTP screen), retrieve the 6-digit
     MFA OTP from your email, and submit it.
   - Re-run `node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>` — no need to
     redo the password step.
2. **`auth-required` with `reason: password-rejected` — stored secret is stale (genuinely manual)**:
   - Okta rejected the autofilled password; `qid.bin` was deleted automatically (never retried
     unchanged, to avoid spending attempts against Okta's lockout threshold).
   - Sign in fully by hand in the visible Chrome window (password + OTP).
   - Recapture the credentials so future runs autofill again by running:
     `npm run setup:credentials`.
3. **`auth-required` with default reason ("Okta session lapsed...") — retry exhaustion or AUTH re-encounter (genuinely manual fallback)**:
   - Autofill was attempted but exhausted its retry limit (e.g. 3 attempts without a definitive outcome due to unexpected DOM or unfamiliar Okta challenge), or `AUTH` state was re-encountered a second time in the same run after autofill had already run.
   - Sign in or resolve the challenge fully by hand in the visible Chrome window on port 9773 (password + OTP as needed), and confirm navigation lands on `support.qualcomm.com`.
4. **Resume execution** (all cases): run
   `node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>`. New session cookies
   persist automatically in `data/chrome-profile/`.

See [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md) and
`references/login-flow.md` for the full mechanism.

---

## Recovery 2: Case Not Found / Authorization (`not-found`)

Triggered when Global Search returns no results for the case number. This is genuinely manual.

1. **Verify case code format**: Must be exactly 8 digits (e.g. `08460319`).
2. **Check account permissions**: Ensure the logged-in Qualcomm account has view privileges for this case.
3. If code is incorrect, re-run with valid code. If code is correct but unsearchable, report access limitation to user and STOP.

---

## Recovery 3: Stuck Page / Incomplete Expansion (`blocked`)

Triggered when the page DOM fails to hydrate or the feed expansion loop hits stuck limits.

1. **Inspect verdict evidence**:
   - Check `reason` and `evidence` in the JSON stdout.
   - Check diagnostic screenshot saved at `data/cases/<CODE>/capture.png` or `probe.png`.
2. **Force full re-pagination**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE> --mode full
   ```
3. If portal UI has changed, inspect `.claude/skills/qualcomm-case-agent/scripts/expand_step.js` or `extract_case.js`.

---

## Recovery 4: Lock Contention (`busy`)

Triggered when another process holds `data/.capture.lock`.

### Automated Handling in `lock.mjs`

A maintainer does **not** need to manually intervene for the following scenarios:

1. **Same-case-code wait/retry**: If the lock is held by another process capturing the *same* case code, `acquireLockOrWaitForSameCode` (`lock.mjs:62-78`) automatically polls every 3 seconds for up to 60 seconds. By the time `status: busy` is returned, this auto-wait budget has already been exhausted.
2. **Stale-lock reclaim**: If a previous run crashed or terminated uncleanly, `acquireLock` (`lock.mjs:29-41`) automatically checks lock freshness on every attempt. A lock is only fresh if its age is `< 30 minutes` (`STALE_MS`) **and** the recorded PID is still alive (`pidAlive(holder.pid)`). If the PID is dead or the lock is >30 min old, `lock.mjs` automatically reclaims and overwrites the lock on the very next run. You do not need to delete `data/.capture.lock` by hand for dead or aged-out processes.

### Genuinely Manual Steps

Manual intervention is only needed in two situations:

1. **Different-case-code lock holder**: If the active capture is running on a *different* case code, `acquireLockOrWaitForSameCode` fails fast and returns `busy` immediately (no auto-wait) so unrelated callers are not blocked. Wait ~30–60 seconds for the other capture to complete, then re-run.
2. **Hung / zombie process**: If a previous capture process is still running according to the OS (`pidAlive` is true) but permanently hung or unresponsive (and under the 30-minute staleness threshold):
   - Check the holder PID in the `busy` verdict JSON or in `data/.capture.lock`.
   - Terminate the hung process:
     ```powershell
     Stop-Process -Id <PID> -Force
     ```
   - Delete the lock file:
     ```powershell
     Remove-Item "data/.capture.lock" -Force
     ```
   - Re-run the capture command.

---

## Recovery 5: Port Conflict (`port-conflict`)

Triggered when the CDP port answers, but the process behind it is NOT this project's Chrome — an
unrelated tool (e.g. one that scans CDP debug ports looking for something to attach to) got there
first. `ensureChrome()` refuses to reuse or drive that connection; it never auto-kills the foreign
process, since it could be an unrelated, legitimate one. This is a deliberate, permanently manual boundary.

1. **Diagnose** (read-only):
   ```bash
   powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1"
   ```
   This prints the PID and command line of whatever holds the port.
2. **Free the port manually**, once you've confirmed it's safe:
   ```powershell
   Stop-Process -Id <PID> -Force
   ```
3. **Retry capture**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
   ```
   If the Okta session was lost in the process, this surfaces as `auth-required` — follow
   **Recovery 1** to sign in again.
