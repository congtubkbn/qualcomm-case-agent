# Qualcomm Support portal login flow (Okta + email OTP) — reference

Authoritative steps + failure handling for **PHASE 1** of the Qualcomm Case Management Agent.
agent-browser verbs are confirmed for **v0.27.x**; defer to the loaded `agent-browser` skill if the
installed version differs.

## Identities & facts

| Item | Value |
|------|-------|
| Qualcomm ID (login) | `the.thoi@samsung.com` — login id only |
| Auth provider | Okta OAuth at `account.qualcomm.com` → redirects to `support.qualcomm.com` |
| MFA | **Email OTP** — 6-digit code emailed to the Samsung mailbox. **Expires ~5 min.** Always human-pasted (Claude cannot read the mailbox). |
| Password store | `data/.secrets/qid.bin` — DPAPI ProtectedData (CurrentUser). Git-ignored. |
| Session store | `data/chrome-profile/` — persistent Chrome profile (cookies/tokens). Git-ignored. |

## Two-layer auth model

1. **Session reuse (primary, silent).** Launch with the SAME `--profile` every run. A valid profile
   loads the dashboard with **no password and no OTP**. This is the real "don't ask again" mechanism.
2. **Password autofill (only on forced re-login).** When the session has expired and Okta appears,
   the stored DPAPI password auto-fills the password field via the agent-browser auth vault used as a
   transient conduit. The human still pastes the **email OTP** — a stored password cannot bypass MFA.

The password is captured ONCE by the user in their own terminal (never the chat) and DPAPI-encrypted.
Thereafter the agent decrypts and uses it without prompting, **unless the password is wrong**.

## Profile-first launch

```bash
P="data/chrome-profile"
agent-browser --headed --profile "$P" open "https://support.qualcomm.com"
agent-browser snapshot -c
```

- `--profile "$P"` (a directory path) → persistent custom profile. Cookies/tokens live in `$P` and
  are reused on every run. Created automatically on first use.
- `--headed` → the window is visible so the user can paste the OTP when the session has lapsed.
- Always use the SAME `$P`. Do not use incognito or a fresh profile per run.

## DPAPI password store (`data/.secrets/qid.bin`)

True Windows DPAPI, `CurrentUser` scope — the ciphertext only decrypts for this Windows user on this
machine. Built into .NET; no module install. Git-ignored.

### First-time capture — USER runs this in a REAL terminal (password never enters the chat)

Hand the user this snippet; they run it once in their own PowerShell window. Claude does NOT run it
and never sees the value:

```powershell
Add-Type -AssemblyName System.Security
$dir = "data\.secrets"; New-Item -ItemType Directory -Force $dir | Out-Null
$sec = Read-Host "Qualcomm ID password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$enc = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($pw), $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes("$dir\qid.bin", $enc)
$pw = $null
Write-Host "Saved data\.secrets\qid.bin (DPAPI, CurrentUser)."
```

Run from the workspace root (the access-qualcomm folder) so `data\.secrets\qid.bin` lands correctly.

### Forced-login conduit — Claude runs this (no echo, transient vault entry)

When Okta appears and `qid.bin` exists, decrypt and drive the agent-browser auth vault as a
short-lived conduit. The plaintext stays inside the PowerShell→stdin pipe; the only visible output is
agent-browser's status line:

```powershell
Add-Type -AssemblyName System.Security
$enc = [IO.File]::ReadAllBytes("data\.secrets\qid.bin")
$pw  = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect($enc, $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser))
$pw | agent-browser auth save qualcomm `
  --url "https://account.qualcomm.com/" `
  --username "the.thoi@samsung.com" --password-stdin
$pw = $null
agent-browser auth login qualcomm      # waits for the form, fills, submits
agent-browser auth delete qualcomm     # remove the transient entry immediately
```

- `--password-stdin` keeps the password off argv and out of the transcript.
- `auth login` waits for the login form, fills username + password, and submits.
- `auth delete` runs right after so no durable plaintext-keyed copy survives in
  `~/.agent-browser/auth/`. The only durable secret is the DPAPI `qid.bin`.
- Okta's selectors: confirm `--url` and, if Okta uses a two-step (username → Next → password) form,
  add `--username-selector` / `--password-selector` (discover via `agent-browser snapshot -i`) or fall
  back to a manual snapshot-driven fill. Record the confirmed values here on first real login.
- **stdin caveat (verify on first login):** PowerShell `$pw | …` may append a newline and re-encode
  (PS 5.1 native pipe is ASCII by default). If the password is rejected despite being correct, ensure
  no trailing CR/LF and UTF-8: e.g. `[Console]::OutputEncoding=[Text.Encoding]::UTF8` and pipe with
  `Write-Host -NoNewline`, or use `cmd /c "echo|set /p=$pw"`. Confirm the working form and record it.

## Decision tree

1. **Dashboard renders** (snapshot shows case list / dashboard chrome) → session valid. Continue.
   No password, no OTP, no DPAPI read.
2. **Redirected to `account.qualcomm.com`** → session lapsed, fresh login needed:
   - `qid.bin` exists → run the **forced-login conduit** above (auto-fills password).
   - `qid.bin` missing → **ask the user to run the first-time capture snippet** in their terminal,
     wait, then run the conduit.
   - Then the user pastes the **email OTP** into the page. Wait, then `agent-browser snapshot -c` to
     confirm the dashboard. The profile stores the new session automatically.
3. **Login fails after submit** (still on `account.qualcomm.com` with a credential error, OR the form
   never advanced to the OTP step) → **wrong password**:
   - `agent-browser auth delete qualcomm` (if present) and delete `data/.secrets/qid.bin`.
   - Ask the user to re-run the capture snippet, then retry the conduit **once**.
   - Fails again → report plainly and STOP. Do not loop.
4. **OTP step reached but OTP rejected / expired** (~5 min) → this is an **OTP** problem, NOT a
   password problem. Do **not** delete `qid.bin`. The user requests a fresh code from the page and
   re-pastes it. Do not reuse an old code.
5. **Email unavailable** (mailbox not reachable) → a fresh login cannot complete (OTP required). If
   the profile session is also expired, authentication is impossible right now — report plainly and
   STOP. A still-valid profile bypasses OTP, so this only bites after the session expires.

## Rotation (password changed)

```powershell
Remove-Item "data\.secrets\qid.bin" -Force      # drop the stale secret
agent-browser auth delete qualcomm 2>$null      # drop any stray vault entry
```

Then re-run the first-time capture snippet with the new password. If the old profile session was tied
to the old password and now misbehaves, also reset the profile (below) and sign in once more.

## Profile reset

If login behaves oddly (corrupted profile), delete the profile and sign in once more:

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
Once the daemon is up and a profile session exists, non-launching commands (snapshot, fill, click,
auth, file ops) are fine from the automation shell.

## Windows "Input redirection is not supported"

Cause: a console app inherits a redirected stdin in a non-interactive/automation shell and blocks
waiting for keyboard input.

- agent-browser auto-denies confirmation prompts when stdin is not a TTY — **do not** pass
  `--confirm-interactive` from the automation shell.
- Run one-time interactive setup in a REAL terminal window: `agent-browser install`, the first SSO
  login, and the DPAPI capture snippet (`Read-Host` needs a real console).
- If a specific command still waits on stdin, feed it empty input: `cmd < /dev/null` (bash) /
  `cmd < NUL` (cmd.exe); in PowerShell launch GUI apps with `Start-Process`, not the `&` call
  operator (which inherits the redirected handle).
