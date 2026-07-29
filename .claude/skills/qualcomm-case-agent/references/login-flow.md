# Qualcomm Support portal login flow (Okta + email OTP) — reference

Authoritative steps for **PHASE 1** of the Qualcomm Case Management Agent.

## Identities & facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | `the.thoi@samsung.com` — login id only |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| MFA | **Email OTP** — 6-digit code emailed to the Samsung mailbox. **Expires ~5 min.** Always human-pasted. |
| Browser | **real Google Chrome** on CDP `9222` (launched detached via `scripts/connect_chrome.ps1`), attached with `agent-browser connect 9222`. NOT the bundled Chromium. |
| Session store | `data/chrome-profile/` — Chrome `--user-data-dir` (cookies/tokens). Git-ignored. Separate instance — the user's personal Chrome is never touched. |

## Single-layer auth model (Session Reuse)

The authentication relies entirely on **Session reuse (primary, silent)**.
We launch real Chrome with the SAME `--user-data-dir` every run, then attach (`agent-browser connect 9222`). A valid profile loads the dashboard with **no password and no OTP**. This is the real "don't ask again" mechanism.

Cookie saving is now fully persistent, so password autofill and DPAPI injection are obsolete and have been removed.

## Attach-to-real-Chrome launch

```bash
# 1) Launch real Chrome detached on CDP 9222 with the persistent profile (idempotent helper).
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
# 2) Attach agent-browser to it (auto-denies prompts on non-TTY stdin; no redirect needed).
agent-browser connect 9222
# 3) Drive the tab.
agent-browser open "https://support.qualcomm.com"
agent-browser snapshot -c
```

- `--user-data-dir` (a directory path) → persistent profile. Cookies/tokens live there and are reused on every run. Created automatically on first use.
- Real Chrome is OS-trusted and stable. The window is visible so the user can log in when the session has lapsed.
- Always use the SAME `--user-data-dir`. Do not use incognito or a fresh dir per run.

## When the session expires

If `run_case.mjs` reports `{"status": "auth-required"}`, it means the session has lapsed and Okta requires re-authentication.
Because we no longer store passwords via DPAPI, **the entire login process is done MANUALLY by the user** in the visible Chrome window:
1. The user enters their password.
2. The user requests and enters the email OTP.
3. The user confirms they are back on `support.qualcomm.com`.
4. The agent can then re-run `run_case.mjs` to continue the capture.

## Profile reset

If login behaves oddly (corrupted profile), delete the profile and sign in once more:

```bash
rm -rf "data/chrome-profile"
# then one fresh headed login recreates it
```
