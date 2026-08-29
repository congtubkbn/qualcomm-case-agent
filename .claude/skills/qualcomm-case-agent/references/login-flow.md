# Qualcomm Support Portal Authentication Guide (Okta SSO + Email OTP)

Authoritative reference for authentication and session management in the Qualcomm Case Management Agent.

## Identities & Key Facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | Configured in `data/.secrets/qid.user` |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| Password | Autofilled automatically from a DPAPI-protected secret (`data/.secrets/qid.bin`) when the session lapses. See [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md). |
| MFA | **Email OTP** — 6-digit code emailed to the user's mailbox, which Claude cannot read. **Expires ~5 min. Always entered manually by the user**, directly in the visible Chrome window. |
| Browser | **Real Google Chrome** on CDP `9773` (launched detached via `scripts/connect_chrome.ps1`) with persistent `--user-data-dir`. |
| Session store | `data/chrome-profile/` — Chrome persistent profile (cookies/tokens). Git-ignored. Isolated from personal browser instances. |

## Session Reuse Model

Authentication relies entirely on **Persistent Chrome Profile Session Reuse**:
1. Chrome starts with `--user-data-dir=data/chrome-profile` attached to CDP port `9773`.
2. All authenticated session cookies and security tokens remain persisted across runs.
3. As long as the Okta session is active, all case captures and searches proceed silently with **zero credentials or OTP required**.

## When the Session Expires: Automatic Password Autofill + OTP-Wait (ADR 0004)

When an Okta session lapses, the portal redirects to `account.qualcomm.com`. `fastLandOnCase()`
detects that `AUTH` state on the *first* sighting per run and attempts autofill automatically —
this is not a fully manual flow:

1. **Password autofill**: `login_fill.js` (run via `CdpClient.eval()`, the same page-script
   pattern as `readiness.js`/`expand_step.js`) fills the username/password fields from the
   DPAPI-protected secret at `data/.secrets/qid.bin`, retrying up to 3 times for transient
   failures (DOM not ready yet, a click that didn't register).
2. **OTP handoff — the human's only remaining step**: once Okta accepts the password and asks for
   the OTP, `run_case.mjs` polls for up to ~5 minutes (matching the OTP's own expiry) while the
   human retrieves the 6-digit code from the mailbox and enters it directly into the
   visible Chrome window on port 9773. As soon as Okta accepts it, the same invocation resumes
   capture automatically — **no second command needed**.
3. **If the OTP window elapses** before the human enters the code, the run reports:
   ```json
   {"status": "otp-timeout", "reason": "Password accepted, but OTP verification was not completed within the timeout window", "code": "<CODE>"}
   ```
   exit code `2`. The password step already succeeded — enter the OTP now in the still-open
   Chrome window, then simply re-run the command; a fresh Okta session will pick it up (no need to
   restart the login from the password step).
4. **If the stored password is rejected by Okta** (account password changed, secret stale), the
   secret at `data/.secrets/qid.bin` is deleted immediately — it is never retried unchanged, since
   that only spends attempts against Okta's lockout threshold for zero chance of a different
   outcome — and the run falls back to `auth-required`:
   ```json
   {"status": "auth-required", "reason": "password-rejected", "code": "<CODE>"}
   ```
   The user must sign in fully by hand in the visible Chrome window (password + OTP), then run
   `scripts/setup/capture_password.ps1` to recapture a fresh secret so future runs autofill again.
5. **If there is no stored secret at all** (first run, or after a manual recapture hasn't happened
   yet), autofill is skipped and the run reports plain `auth-required` with the default reason
   *"Okta session lapsed — sign in once in the persistent Chrome profile (email OTP is
   human-only)"* — sign in fully by hand as above.
6. **Resume Capture**: after any of the above, re-run
   `node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs <CODE>`. New session tokens
   persist automatically in `data/chrome-profile/`.

See [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md) for the
full rationale, including why OTP always stays human (Claude cannot read the user's mailbox) and
why a rejected password is never retried blindly.

## Port Conflict (`port-conflict`)

If a different, unrelated tool scans CDP ports and attaches to this Chrome first, `ensureChrome()`
detects the mismatched `--user-data-dir` and halts with exit code `7` and status `port-conflict`
rather than silently letting the wrong process act on our profile. Run `recover_chrome.ps1` — it
reports the PID and command line of whatever holds the port (never auto-killed) so you can free it
by hand, then re-run the capture.

## Profile Recovery / Reset

If the profile becomes corrupted or stuck in an unrecoverable state:
```bash
# Terminate Chrome instances using CDP 9773 and remove the profile directory
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1"
rm -rf "data/chrome-profile"
```
Re-running `scripts/connect_chrome.ps1` will create a clean profile ready for a fresh manual sign-in.
