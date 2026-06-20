# Qualcomm Support portal login flow (Okta + email OTP) — reference

Authoritative steps + failure handling for **PHASE 1** of the Qualcomm Case Management Agent.
agent-browser verbs are confirmed for **v0.27.x**; defer to the loaded `agent-browser` skill if the
installed version differs.

## Identities & facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | `the.thoi@samsung.com` — login id only, **never** the password |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| MFA | **Email OTP** — 6-digit code emailed to the Samsung mailbox. **Expires ~5 min.** |
| Who enters secrets | The **user**, in the browser window. Claude never types the password or OTP. |
| Session store | `data/chrome-profile/` — persistent Chrome profile (cookies/tokens). Git-ignored. |

## Why a persistent profile is the mechanism

Qualcomm ID enforces email OTP, so a stored password could not fully automate login anyway. The
real "don't re-enter" mechanism is the **persistent Chrome profile**: launch agent-browser with the
SAME `--profile` directory every run. After ONE manual sign-in, the profile keeps the cookies/tokens
and the browser refreshes them on its own, so later runs skip both the password and the OTP until the
session expires. There is **no separate save step** — the profile persists automatically (unlike a
`--state` JSON snapshot, which must be re-saved).

## Profile-first launch

```bash
P="data/chrome-profile"
agent-browser --headed --profile "$P" open "https://support.qualcomm.com"
agent-browser snapshot -c
```

- `--profile "$P"` (a directory path) → a persistent custom profile. Cookies/tokens live in `$P`
  and are reused on every run. Created automatically on first use.
- `--headed` → the window is visible so the user can sign in when the session has lapsed.
- Always use the SAME `$P`. Do not use incognito or a fresh profile per run.

## Decision tree

1. **Dashboard renders** (snapshot shows case list / dashboard chrome) → session valid. Continue.
   No password, no OTP.
2. **Redirected to `account.qualcomm.com`** → session lapsed, fresh login needed:
   - STOP and ask the user to, in the open browser: (a) enter the Qualcomm ID password, (b) wait for
     the 6-digit code in their Samsung mailbox, (c) **paste the OTP into the page**.
   - Wait for them, then `agent-browser snapshot -c` to confirm the dashboard loaded.
   - The profile stores the new session automatically — **nothing else to do**. Re-login on expiry is
     expected and accepted; do **not** send any notification.
3. **Email unavailable** (mailbox not reachable) → a fresh login **cannot complete** (OTP is
   required). If the profile session is also expired, authentication is impossible right now —
   **report this plainly and STOP. Do not loop or retry.** A still-valid profile bypasses OTP, so
   this only bites after the session expires.
4. **OTP expired / stale code screen** (~5 min) → the user requests a fresh code from the page;
   a new email is sent. Re-paste the new code. Do not reuse an old code.

## Profile reset

If login behaves oddly (password change, corrupted profile), delete the profile and sign in once more:

```bash
rm -rf "data/chrome-profile"
# then one fresh headed login recreates it
```

## Single-instance note

A persistent profile directory can be opened by only ONE browser at a time (Chrome locks the
user-data-dir). Keep a single agent-browser instance using the profile; close it
(`agent-browser close --all`) before launching another against the same `$P`.

## Browser launch hangs in a non-TTY / sandboxed shell (verified)

agent-browser uses a **bundled Playwright Chromium** (`ms-playwright/chromium-*`, exe named
`chrome.exe` but NOT system Google Chrome). Any command that starts the browser daemon — `open`,
`doctor` — **blocks with no output** when run from a redirected/non-interactive automation shell
(observed: the command never returns and must be killed). The headless renderer tree spawns but the
driver never gets a usable handle.

**Implication:** run the browser-launching steps (first headed SSO login, and ideally each
`--profile open`) in a **real terminal window** with a TTY, not through a piped/automation shell.
Once a profile session exists on disk, non-launching commands (version, file ops) are fine anywhere.

## Windows "Input redirection is not supported"

Cause: a console app inherits a redirected stdin in a non-interactive/automation shell and blocks
waiting for keyboard input.

- agent-browser auto-denies confirmation prompts when stdin is not a TTY — **do not** pass
  `--confirm-interactive` from the automation shell.
- Run one-time interactive setup in a REAL terminal window: `agent-browser install`, and the very
  first SSO login if you prefer doing it outside the agent.
- If a specific command still waits on stdin, feed it empty input: `cmd < /dev/null` (bash) /
  `cmd < NUL` (cmd.exe); in PowerShell launch GUI apps with `Start-Process`, not the `&` call
  operator (which inherits the redirected handle).
