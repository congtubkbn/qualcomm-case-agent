# Qualcomm Support Portal Authentication Guide (Okta SSO + Email OTP)

Authoritative reference for authentication, session lifecycle, and credential management in the Qualcomm Case Management Agent.

## Identities & Key Facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | Configured in `data/.secrets/qid.user` |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| Password | Autofilled automatically from a DPAPI-protected secret (`data/.secrets/qid.bin`) when the session lapses. See [ADR 0004](../../../../docs/adr/0004-revive-password-autofill-otp-stays-manual.md). |
| MFA | **Email OTP** — 6-digit code emailed to the user's mailbox, which Claude/agent cannot read. **Expires in ~5 min. Always entered manually by the user**, directly in the visible Chrome window. |
| Browser | **Real Google Chrome** on CDP `9773` (launched detached via `scripts/connect_chrome.ps1`) with persistent `--user-data-dir`. |
| Session store | `data/chrome-profile/` — Chrome persistent profile (cookies/tokens). Git-ignored. Isolated from personal browser instances. |

---

## Session Reuse Model

Authentication relies on **Persistent Chrome Profile Session Reuse**:
1. Chrome starts with `--user-data-dir=data/chrome-profile` attached to CDP port `9773`.
2. Authenticated session cookies and security tokens remain persisted across runs.
3. While the Okta session is active, all case captures and searches execute autonomously with **zero credentials or OTP required**.

---

## Automated Autofill & Human OTP Flow

When an Okta session lapses, the portal redirects to `account.qualcomm.com`. `fastLandOnCase()` detects the `AUTH` state and coordinates automated autofill and manual OTP handoff:

### Automated Background Handling
1. **Password Autofill**: `login_fill.js` (evaluated via `CdpClient.eval()`) fills username and password fields from the DPAPI-protected secret at `data/.secrets/qid.bin`, retrying up to 3 times for transient DOM readiness.
2. **OTP Polling Loop**: Once Okta accepts the password and presents the OTP challenge, `handleAuth()` automatically enters a 2-second polling loop for up to 5 minutes (matching OTP expiration). As soon as the human enters the OTP and navigation completes, capture resumes automatically without re-invoking the command.
3. **Account Lockout Protection**: If Okta rejects the stored password (`reason: password-rejected`), `data/.secrets/qid.bin` is deleted immediately and never retried blindly, preventing account lockout.

### Human-Only Actions
1. **OTP Submission**: Retrieve the 6-digit MFA OTP from your private email inbox and submit it directly into the open Chrome window on port 9773.
2. **Credential Setup / Recapture**:
   - On first setup, or when the Qualcomm password is changed:
     ```bash
     npm run setup:credentials
     ```
     This executes `scripts/setup/capture_credentials.ps1` to store the encrypted DPAPI secret.
3. **Manual Login Fallback**: If an unfamiliar challenge or captcha appears, complete sign-in in the open Chrome window until reaching `support.qualcomm.com`.

---

## Exit Statuses & Recovery Routing

Authentication events map directly to the JSON verdict table defined in [`SKILL.md`](../SKILL.md#step-3--branch-on-json-verdict):

- **`otp-timeout` (Exit 2)**: Password was accepted, but human did not submit OTP within the 5-minute timeout window.
  - *Action*: Enter the OTP in the open Chrome window, then re-run `node ".claude/skills/qcomm/scripts/run_case.mjs" <CODE>`. The password step does not need to be repeated.
- **`auth-required` (Exit 3)**: Password rejected, retry limit exhausted, or challenge unhandled.
  - *Action*: Sign in manually in Chrome, run `npm run setup:credentials` to refresh DPAPI secret, and re-run capture.
- **`error` (Exit 1)**: Credentials unconfigured before launch.
  - *Action*: Run `npm run setup:credentials` to configure username and password.

See [`manual-flow.md`](manual-flow.md) for full recovery procedures.

---

## Port Conflict & Profile Recovery

### Port Conflict (`port-conflict`, Exit 7)
If a non-project process attaches to CDP port 9773, `ensureChrome()` detects the mismatched `--user-data-dir` and halts with exit code 7 to protect foreign processes. Follow [`manual-flow.md#recovery-for-port-conflict-exit-7--port-conflict`](manual-flow.md#recovery-for-port-conflict-exit-7--port-conflict) to inspect and free the port.

### Profile Reset
If the Chrome profile becomes corrupted:
```powershell
# Terminate Chrome instances using CDP 9773 and remove the profile directory
powershell -ExecutionPolicy Bypass -File ".claude/skills/qcomm/scripts/recover_chrome.ps1"
Remove-Item -Recurse -Force "data/chrome-profile"
```
Re-running capture will launch a fresh profile ready for sign-in.
