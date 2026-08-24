# Qualcomm Support Portal Authentication Guide (Okta SSO + Email OTP)

Authoritative reference for authentication and session management in the Qualcomm Case Management Agent.

## Identities & Key Facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | `the.thoi@samsung.com` |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| MFA | **Email OTP** — 6-digit code emailed to the Samsung mailbox. **Expires ~5 min.** Always entered manually by user. |
| Browser | **Real Google Chrome** on CDP `9773` (launched detached via `scripts/connect_chrome.ps1`) with persistent `--user-data-dir`. |
| Session store | `data/chrome-profile/` — Chrome persistent profile (cookies/tokens). Git-ignored. Isolated from personal browser instances. |

## Session Reuse Model

Authentication relies entirely on **Persistent Chrome Profile Session Reuse**:
1. Chrome starts with `--user-data-dir=data/chrome-profile` attached to CDP port `9773`.
2. All authenticated session cookies and security tokens remain persisted across runs.
3. As long as the Okta session is active, all case captures and searches proceed silently with **zero credentials or OTP required**.

## When the Session Expires (`auth-required`)

When an Okta session lapses or requires re-authentication, the portal redirects to `account.qualcomm.com`:
1. `run_case.mjs` detects the redirection and halts immediately with exit code `3` and JSON verdict:
   ```json
   {"status": "auth-required", "reason": "session-lapsed", "code": "<CODE>"}
   ```
2. **User Manual Login**:
   - The user opens/switches to the visible Chrome window connected on port 9773.
   - Signs in with password on `account.qualcomm.com`.
   - Checks Samsung email inbox for the 6-digit MFA OTP and enters it into Chrome.
   - Waits until the Qualcomm Support dashboard (`support.qualcomm.com`) loads successfully.
3. **Resume Capture**:
   - The user or agent re-runs `node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs <CODE>`.
   - The new session tokens are automatically persisted in `data/chrome-profile/`.

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
