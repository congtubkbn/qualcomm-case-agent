# Qualcomm Case Management Agent — Troubleshooting & Recovery Guide

Authoritative runbook for resolving pipeline blockers when `scripts/run_case.mjs` returns a non-zero exit or non-success verdict (`auth-required`, `blocked`, `not-found`, `busy`, `port-conflict`).

---

## Verdict Routing & Actions

| Exit | Verdict `status` | Root Cause | Action |
|------|------------------|------------|--------|
| 2 | `otp-timeout` | Password autofilled OK; the ~5min OTP window elapsed before the human entered the code | → **Recovery 1 (enter OTP now, then re-run — no need to redo the password step)** |
| 3 | `auth-required` | Okta SSO session expired (no stored secret, or stored password was rejected) | → **Recovery 1 (Okta Re-auth: autofill-first, manual fallback)** |
| 4 | `not-found` | Case does not exist or account lacks access | → **Recovery 2 (Case Not Found / Authorization)** |
| 5 | `blocked` | Feed expansion stuck / DOM unrendered | → **Recovery 3 (Stuck Page / DOM Recovery)** |
| 6 | `busy` | Lock file `data/.capture.lock` is held | → **Recovery 4 (Lock Contention)** |
| 7 | `port-conflict` | CDP port held by a process that isn't our Chrome | → **Recovery 5 (Port Conflict)** |
| 1 | `error` / CDP Refused | Chrome crashed or port 9773 unreachable | → **Recovery 0 (Chrome / CDP Port Reset)** |

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

1. **`otp-timeout` (exit 2) — password already succeeded, only OTP is outstanding**:
   - The stored secret was autofilled and Okta accepted it; the run waited ~5 min for the OTP and
     timed out.
   - Switch to the Chrome window on port 9773 (it's still on the OTP screen), retrieve the 6-digit
     MFA OTP from Samsung email, and submit it.
   - Re-run `node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>` — no need to
     redo the password step.
2. **`auth-required` with `reason: password-rejected` — stored secret is stale**:
   - Okta rejected the autofilled password; `qid.bin` was deleted automatically (never retried
     unchanged, to avoid spending attempts against Okta's lockout threshold).
   - Sign in fully by hand in the visible Chrome window (password + OTP).
   - Recapture the secret so future runs autofill again:
     `powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/capture_password.ps1"`.
3. **`auth-required` with the default reason ("Okta session lapsed...") — no stored secret at all**:
   - Autofill was skipped entirely (first run, or secret never captured).
   - Sign in fully by hand in the visible Chrome window: enter credentials on
     `account.qualcomm.com`, retrieve the MFA OTP from Samsung email (expires ~5 min), submit, and
     confirm navigation lands on `support.qualcomm.com`.
   - Optionally run `capture_password.ps1` afterward so the next lapse can autofill.
4. **Resume execution** (all cases): run
   `node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>`. New session cookies
   persist automatically in `data/chrome-profile/`.

See [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md) and
`references/login-flow.md` for the full mechanism.

---

## Recovery 2: Case Not Found / Authorization (`not-found`)

Triggered when Global Search returns no results for the case number.

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

1. Wait ~30 seconds and retry once.
2. If a previous run crashed or terminated uncleanly leaving a stale lock:
   - Check if the process recorded in `data/.capture.lock` is still active.
   - Delete `data/.capture.lock` if stale and re-run.

---

## Recovery 5: Port Conflict (`port-conflict`)

Triggered when the CDP port answers, but the process behind it is NOT this project's Chrome — an
unrelated tool (e.g. one that scans CDP debug ports looking for something to attach to) got there
first. `ensureChrome()` refuses to reuse or drive that connection; it never auto-kills the foreign
process, since it could be an unrelated, legitimate one.

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
