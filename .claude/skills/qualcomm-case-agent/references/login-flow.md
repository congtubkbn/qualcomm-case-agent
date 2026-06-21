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
| Browser | **real Google Chrome** on CDP `9222` (launched detached via `scripts/connect_chrome.ps1`), attached with `agent-browser connect 9222`. NOT the bundled Chromium. |
| Session store | `data/chrome-profile/` — Chrome `--user-data-dir` (cookies/tokens). Git-ignored. Separate instance — the user's personal Chrome is never touched. |

## Two-layer auth model

1. **Session reuse (primary, silent).** Launch real Chrome with the SAME `--user-data-dir` every run,
   then attach (`agent-browser connect 9222`). A valid profile loads the dashboard with **no password
   and no OTP**. This is the real "don't ask again" mechanism.
2. **Password autofill (only on forced re-login).** When the session has expired and Okta appears,
   the stored DPAPI password auto-fills the password field via the agent-browser auth vault used as a
   transient conduit. The human still pastes the **email OTP** — a stored password cannot bypass MFA.

The password is captured ONCE by the user in their own terminal (never the chat) and DPAPI-encrypted.
Thereafter the agent decrypts and uses it without prompting, **unless the password is wrong**.

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

The helper runs (equivalent inline):

```powershell
# Separate --user-data-dir = separate instance; do NOT kill the user's personal Chrome.
# Embedded quotes around the path are REQUIRED: Start-Process does not quote -ArgumentList
# items, so a path with a space (e.g. "C:\Users\Win 11\...") would split and the CDP port
# would never open. connect_chrome.ps1 is the source of truth: it auto-detects Chrome AND resolves
# the profile from the project root (NOT CWD) via _paths.ps1 -> prefer it. This inline form assumes
# you launch from the project root; run from elsewhere and you get a DIFFERENT empty profile.
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList @(
  '--remote-debugging-port=9222',
  "--user-data-dir=`"$((Get-Location).Path)\data\chrome-profile`"")
```

- `--user-data-dir` (a directory path) → persistent profile. Cookies/tokens live there and are reused
  on every run. Created automatically on first use.
- Real Chrome is OS-trusted and stable; the bundled Chromium can ship a broken build (`os error
  10060`). The window is visible so the user can paste the OTP when the session has lapsed.
- Always use the SAME `--user-data-dir`. Do not use incognito or a fresh dir per run.
- `Start-Process` (NOT the `&` call operator) launches Chrome detached without inheriting the
  automation shell's redirected stdin.

## DPAPI password store (`data/.secrets/qid.bin`)

True Windows DPAPI, `CurrentUser` scope — the ciphertext only decrypts for this Windows user on this
machine. Built into .NET; no module install. Git-ignored.

**Portability (copying the skill to another workspace or machine):**
- **Path resolution is automatic.** All scripts resolve their paths through `scripts\_paths.ps1`
  (PowerShell) / `scripts\_paths.mjs` (Node): derived from the script's own location, then walking UP
  to the project root (`.git` or an existing `data\cases`). Works from any CWD and survives the skill
  being re-nested. Escape hatches: `$env:QUALCOMM_ROOT` (pin the project root), `$env:QUALCOMM_SECRET`
  (pin the `qid.bin` path).
- **The DPAPI secret is NOT portable across machines/users — by design.** `qid.bin` is bound to the
  Windows user + machine that ran the capture; it can never be decrypted elsewhere, and no path logic
  changes that. On a new machine (or a different Windows user), **re-run `capture_password.ps1` once**
  to regenerate `qid.bin` locally. `data\.secrets\` is git-ignored, so it never travels with a copy
  anyway — you regenerate regardless.

### First-time capture — USER runs this in a REAL terminal (password never enters the chat)

**Give the user the canonical script — do NOT hand-type or improvise an inline snippet.** The
`ProtectedData.Protect` call nests five levels of parens; a regenerated one-liner mis-counted them
(`...$pwd)))))` → `Unexpected token ')'`), `$enc` stayed null, and `WriteAllBytes` threw `Value
cannot be null` while the run *looked* saved. The script removes that failure mode — it is never
re-typed, and it auto-detects the project root (no `Set-Location`/path edit needed):

```
powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1
```

They run it once in their own **PowerShell** window (NOT cmd.exe — the `Read-Host`/.NET calls are
PowerShell). Claude does NOT run it and never sees the value. Wait for the `Saved … bytes` line.

The script (`scripts\capture_password.ps1`) is the source of truth; this is what it does:

```powershell
. "$PSScriptRoot\_paths.ps1"      # shared resolver: walks UP to project root (.git / data\cases)
$out = $QcSecretPath              # <project-root>\data\.secrets\qid.bin (or $env:QUALCOMM_SECRET)
$dir = Split-Path $out -Parent
Add-Type -AssemblyName System.Security                # REQUIRED on PS 5.1 or ProtectedData = TypeNotFound
New-Item -ItemType Directory -Force $dir | Out-Null
$sec  = Read-Host "Qualcomm ID password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$enc  = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($pw), $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($out, $enc)
```

Pitfalls this snippet defends against (all hit on first real capture):
- **cmd.exe instead of PowerShell** → `'New-Item' is not recognized`. Open `powershell` first.
- **Missing `Add-Type`** → `Unable to find type [Security.Cryptography.ProtectedData]`, `$enc` stays
  null, `WriteAllBytes` then throws `Value cannot be null` while the file looks "saved".
- **Wrong working dir** — no longer a failure mode: `_paths.ps1` derives paths from the script's own
  location and walks UP to the project root (`.git` / `data\cases`), so capture and login agree from
  ANY CWD and at any nesting depth. Override with `$env:QUALCOMM_ROOT` / `$env:QUALCOMM_SECRET` for
  layouts the walk-up can't infer (e.g. secret stored outside the repo).
- The `if … Length -gt 0` guard proves the bytes were actually written (don't trust a bare "Saved").

### Forced-login conduit — Claude runs this (Okta is identifier-first / two-step)

**CONFIRMED 2026-06:** Qualcomm Okta is **identifier-first** — username and password are on
**separate screens**, so the single-page `agent-browser auth login` vault conduit does **not** work
(it fills username + password on one page; the password field does not exist until after "Next").
Use the helper script, which drives the two-step form and fills the password straight from DPAPI
(plaintext only ever lives in a PowerShell variable + the child agent-browser argv — never the
transcript):

```powershell
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/okta_login.ps1"
```

Confirmed screen sequence (refs are illustrative — re-snapshot each run):

| Screen | Heading | Field | Action |
|--------|---------|-------|--------|
| 1 | "Sign In" | textbox "Username" (often prefilled) | click button "Next" |
| 2 | "Verify with your password" | textbox "Password" | fill (DPAPI), click "Verify" |
| 3 | "Get a verification email" | — | click "Send me an email" |
| 3b | "Verify with your email" | — | click "Enter a verification code instead" |
| 3c | "Verify with your email" | textbox "Enter Code" | **human pastes 6-digit OTP**, click "Verify" |

`okta_login.ps1` handles screens 1–2 (the secret-bearing part) and exits 0. The agent then drives
3 → 3b → 3c by snapshot refs; the **human pastes the email OTP**. Stable selectors used by the
script: username `input[name='identifier']`, password `input[type='password']`, submit
`input[type='submit']`.

Manual equivalent (if the helper is unavailable) — decrypt and fill by selector, no echo. Prefer
`okta_login.ps1`: it resolves `qid.bin` via `_paths.ps1` (CWD-independent). The `$QcSecretPath` line
below does the same; the commented `Get-Location` fallback only works when CWD is the project root:

```powershell
Add-Type -AssemblyName System.Security
. "$PSScriptRoot\_paths.ps1"   # -> $QcSecretPath  (or set $secret manually if running ad-hoc)
agent-browser click "input[type='submit']"          # Next (username -> password screen)
Start-Sleep 2
$enc = [IO.File]::ReadAllBytes($QcSecretPath)        # was: Join-Path (Get-Location) "data\.secrets\qid.bin"
$pw  = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect($enc, $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser))
agent-browser fill "input[type='password']" $pw     # never print $pw
$pw = $null; [GC]::Collect()
agent-browser click "input[type='submit']"          # Verify
```

- The `auth save`/`login`/`delete` vault path is retired for Qualcomm — kept only for single-page
  logins elsewhere. The only durable secret remains the DPAPI `qid.bin`.
- `Add-Type -AssemblyName System.Security` is **required** on Windows PowerShell 5.1, or
  `[Security.Cryptography.ProtectedData]` throws `TypeNotFound`. Run in **PowerShell**, not cmd.exe.

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

A persistent `--user-data-dir` can be opened by only ONE Chrome instance at a time (Chrome locks the
dir). The helper is idempotent — if CDP `9222` is already up it reuses it instead of launching a
second instance. If you need to restart, `agent-browser close` then re-run `connect_chrome.ps1`.

## `os error 10060` / bundled-Chromium failure (root cause of the switch to real Chrome)

agent-browser can drive either its **bundled Playwright Chromium** (`~/.agent-browser/browsers/
chrome-*`, exe named `chrome.exe` but NOT system Google Chrome) or, via `connect <port>`, a **real
Chrome over CDP**. The bundled path broke: a freshly-downloaded bundled build (`chrome-150.x`, newer
than the working `chrome-149.x`) failed its CDP handshake → `Could not configure browser: Failed to
read … (os error 10060)` on every `open`. Each failure also left an orphaned bundled Chromium and a
stale `~/.agent-browser/default.pid` / `default.port` (next launch then says *"daemon already
running"* and times out).

**Fix = attach to real Chrome (the current default flow).** `connect_chrome.ps1` launches system
Chrome detached on `9222`; `agent-browser connect 9222` attaches. If a prior bundled run wedged the
daemon, clear it first (path-filtered kill so personal Chrome survives):

```powershell
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process agent-browser-win32-x64 -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:USERPROFILE\.agent-browser\default.pid","$env:USERPROFILE\.agent-browser\default.port","$env:USERPROFILE\.agent-browser\default.stream" -Force -ErrorAction SilentlyContinue
```

Launch Chrome with `Start-Process` (NOT `&`) from a non-TTY shell so it does not inherit a redirected
stdin. Once attached, non-launching commands (snapshot, fill, click, auth, file ops) are fine from
the automation shell with no stdin redirect — agent-browser auto-denies prompts on non-TTY stdin.
Do NOT use `< /dev/null`: it is bash-only and breaks in PowerShell/cmd (see below).

## Windows "Input redirection is not supported"

Cause: a console app inherits a redirected stdin in a non-interactive/automation shell and blocks
waiting for keyboard input.

- agent-browser auto-denies confirmation prompts when stdin is not a TTY — **do not** pass
  `--confirm-interactive` from the automation shell.
- Run one-time interactive setup in a REAL terminal window: `agent-browser install`, the first SSO
  login, and the DPAPI capture snippet (`Read-Host` needs a real console).
- agent-browser commands need NO stdin redirect (auto-deny on non-TTY). Do not add one by reflex:
  `< /dev/null` is bash-only and fails in PowerShell/cmd with *"The system cannot find the path
  specified"* (`/dev/null` parsed as a literal path). If a non-agent-browser command truly waits on
  stdin, use the token for the actual shell: `< /dev/null` (bash) / `< $null` (PowerShell) /
  `< NUL` (cmd.exe). In PowerShell launch GUI apps with `Start-Process`, not the `&` call operator
  (which inherits the redirected handle).
