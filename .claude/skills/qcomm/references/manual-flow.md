# Qualcomm Case Management Agent — Troubleshooting & Recovery Guide

Authoritative runbook for resolving pipeline blockers when `scripts/run_case.mjs` returns a non-zero exit or non-success verdict (`error`, `otp-timeout`, `auth-required`, `not-found`, `blocked`, `busy`, `port-conflict`).

---

## Recovery Index

For the authoritative JSON verdict table and exit code contract, see [`SKILL.md`](../SKILL.md#step-3--branch-on-json-verdict). Use this index to route directly to the applicable recovery procedure:

| Verdict `status` | Exit | Meaning | Recovery Procedure |
|------------------|------|---------|-------------------|
| `error` | 1 | Unconfigured credentials or CDP connection error | [Recovery for `error` (Exit 1)](#recovery-for-error-exit-1--credentials--cdp-reset) |
| `otp-timeout` | 2 | Password accepted; OTP window elapsed | [Recovery for `otp-timeout` (Exit 2)](#recovery-for-otp-timeout-exit-2--email-otp-entry) |
| `auth-required` | 3 | Okta SSO session lapsed / secret rejected | [Recovery for `auth-required` (Exit 3)](#recovery-for-auth-required-exit-3--okta-sign-in--credential-recapture) |
| `not-found` | 4 | Case does not exist or unviewable | [Recovery for `not-found` (Exit 4)](#recovery-for-not-found-exit-4--case-verification) |
| `blocked` | 5 | Expansion / extraction stuck | [Recovery for `blocked` (Exit 5)](#recovery-for-blocked-exit-5--stuck-page--incomplete-expansion) |
| `busy` | 6 | Capture lock held by another process | [Recovery for `busy` (Exit 6)](#recovery-for-busy-exit-6--lock-contention) |
| `port-conflict` | 7 | CDP port 9773 held by non-project process | [Recovery for `port-conflict` (Exit 7)](#recovery-for-port-conflict-exit-7--port-conflict) |

---

## Recovery for `error` (Exit 1) — Credentials / CDP Reset

Triggered when pre-flight checks fail (missing username or secret file) or when the CDP connection is refused (`ECONNREFUSED` on port 9773).

### Automated Handling
- `run_case.mjs` validates credential presence before browser launch and fails fast with code 1 without mutating profile state.

### Human-Only Recovery Steps
1. **If credentials are unconfigured or missing**:
   ```bash
   npm run setup:credentials
   ```
   Provide the Qualcomm ID username and password to store the encrypted DPAPI secret (`data/.secrets/qid.bin`).
2. **If CDP port 9773 is refused / unresponsive**:
   - Terminate stale instances and restart CDP:
     ```bash
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qcomm/scripts/recover_chrome.ps1"
     ```
   - Verify CDP readiness:
     ```bash
     curl -s http://127.0.0.1:9773/json/version
     ```
     *Expected result*: HTTP 200 with JSON payload containing `webSocketDebuggerUrl`.
3. **Retry capture**:
   ```bash
   node ".claude/skills/qcomm/scripts/run_case.mjs" <CODE>
   ```

---

## Recovery for `otp-timeout` (Exit 2) — Email OTP Entry

Triggered when the stored password was successfully accepted by Okta, but the user did not enter the 6-digit email MFA OTP within the ~5 minute window.

### Automated Handling
- `fastLandOnCase()` automatically autofills credentials via `login_fill.js` over CDP.
- Okta accepts the password and navigates to the MFA challenge.
- `fast_landing.mjs` automatically polls every 2 seconds for up to 5 minutes waiting for human OTP entry.

### Human-Only Recovery Steps
1. Switch to the open, visible Chrome window on port 9773 (still displaying the Okta OTP prompt).
2. Retrieve the 6-digit MFA OTP from your email inbox (the agent cannot access private email).
3. Submit the 6-digit OTP directly into Chrome.
4. Re-run capture:
   ```bash
   node ".claude/skills/qcomm/scripts/run_case.mjs" <CODE>
   ```
   *Note*: The password step already succeeded. A fresh Okta session is picked up immediately without restarting password entry.

See [`login-flow.md`](login-flow.md) and [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md) for full authentication architecture.

---

## Recovery for `auth-required` (Exit 3) — Okta Sign-In / Credential Recapture

Triggered when the stored password is rejected by Okta (password changed or stale secret), when autofill retries are exhausted, or when an unfamiliar Okta challenge requires direct interaction.

### Automated Handling
- If Okta rejects the password, `fast_landing.mjs` immediately clears `data/.secrets/qid.bin` to protect against account lockout (never blindly retries a rejected password).

### Human-Only Recovery Steps
1. **If password was rejected (`reason: password-rejected`)**:
   - Sign in manually in the visible Chrome window on port 9773 (password + email OTP).
   - Recapture the new password into DPAPI storage so future runs autofill automatically:
     ```bash
     npm run setup:credentials
     ```
2. **If challenge or unexpected DOM prompted `auth-required`**:
   - Complete sign-in or resolve challenge in the open Chrome window on port 9773 until the browser lands on `support.qualcomm.com`.
3. **Resume capture**:
   ```bash
   node ".claude/skills/qcomm/scripts/run_case.mjs" <CODE>
   ```
   Session cookies persist automatically in `data/chrome-profile/`.

---

## Recovery for `not-found` (Exit 4) — Case Verification

Triggered when global portal search returns no matching case records for the requested identifier.

### Automated Handling
- Fast landing searches the portal and confirms no matching case link exists.

### Human-Only Recovery Steps
1. **Verify case code format**: Must be exactly 8 digits (e.g. `08460319`).
2. **Check account permissions**: Ensure the logged-in Qualcomm account has view authorization for this specific case.
3. If the code was mistyped, re-run with the correct code. If the code is correct but unviewable, report access limitation to the user and STOP.

---

## Recovery for `blocked` (Exit 5) — Stuck Page / Incomplete Expansion

Triggered when the portal DOM fails to hydrate or the feed expansion loop hits stuck limits.

### Automated Handling
- `run_case.mjs` executes stuck retry grace rounds (`STUCK_RETRY_ROUNDS`). If marked `retryable: true` in the verdict, the agent may retry once automatically.

### Human-Only Recovery Steps
1. **Inspect diagnostic evidence**:
   - Check `reason` and `evidence` in the JSON stdout verdict.
   - Inspect diagnostic screenshots at `data/cases/<CODE>/capture.png` or `probe.png`.
2. **Force full re-pagination**:
   ```bash
   node ".claude/skills/qcomm/scripts/run_case.mjs" <CODE> --mode full
   ```
3. If portal UI has changed, inspect `.claude/skills/qcomm/scripts/expand_step.js` or `extract_case.js`.

---

## Recovery for `busy` (Exit 6) — Lock Contention

Triggered when `data/.capture.lock` is held by another capture process.

### Automated Handling in `lock.mjs`
- **Same-case-code auto-wait**: If the lock is held for the *same* case code, `acquireLockOrWaitForSameCode` polls automatically every 3 seconds for up to 60 seconds. `status: busy` is only returned after this auto-wait budget expires.
- **Stale-lock auto-reclaim**: `acquireLock` checks process liveness (`pidAlive`) and 30-minute staleness (`STALE_MS`). Dead or expired locks are reclaimed automatically without manual file deletion.

### Human-Only Recovery Steps
1. **Different-case-code lock holder**: If another capture is processing a *different* case code, wait 30–60 seconds for it to complete, then re-run.
2. **Hung / zombie process**: If a process is still registered by the OS as alive but permanently unresponsive:
   - Identify PID from the `busy` verdict JSON or `data/.capture.lock`.
   - Terminate hung process:
     ```powershell
     Stop-Process -Id <PID> -Force
     ```
   - Remove stale lock file:
     ```powershell
     Remove-Item "data/.capture.lock" -Force
     ```
   - Re-run capture.

---

## Recovery for `port-conflict` (Exit 7) — Port Conflict

Triggered when CDP port 9773 is active, but the process attached to it does not match this project's dedicated Chrome profile (e.g. an external tool scanned and attached to the port). The pipeline never auto-kills foreign processes.

### Automated Handling
- `ensureChrome()` verifies `--user-data-dir` match before connecting and halts safely with exit code 7 to protect foreign processes and prevent profile contamination.

### Human-Only Recovery Steps
1. **Diagnose foreign process (read-only)**:
   ```bash
   powershell -ExecutionPolicy Bypass -File ".claude/skills/qcomm/scripts/recover_chrome.ps1"
   ```
   This outputs the PID and command line of the process holding port 9773.
2. **Free the port manually** (after confirming it is safe to terminate):
   ```powershell
   Stop-Process -Id <PID> -Force
   ```
3. **Retry capture**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
   ```
   If Okta session state was reset, proceed to [Recovery for `auth-required` (Exit 3)](#recovery-for-auth-required-exit-3--okta-sign-in--credential-recapture).
