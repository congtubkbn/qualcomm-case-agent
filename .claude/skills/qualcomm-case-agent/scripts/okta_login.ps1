<#
  okta_login.ps1 — drive Qualcomm Okta identifier-first login through the
  password step using the DPAPI-stored credential. Email OTP stays human.

  CONFIRMED Okta flow (support.qualcomm.com, observed 2026-06):
    1. username screen : textbox "Username" (often prefilled) + button "Next"
    2. password screen : textbox "Password"               + button "Verify"
    3. email-OTP screen : "Get a verification email" -> "Send me an email"
                          -> "Enter a verification code instead" -> 6-digit code
  This script handles steps 1-2 only. The password is decrypted from
  data\.secrets\qid.bin and passed straight to agent-browser; it is NEVER
  printed. The human completes step 3 (Claude cannot read the mailbox).

  PREREQS (Phase 0): real Chrome on CDP 9222 + agent-browser attached:
    powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\connect_chrome.ps1
    agent-browser connect 9222

  RUN from anywhere (paths resolve via _paths.ps1 from the script's own location):
    powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\okta_login.ps1

  EXIT CODES: 0 password submitted (do OTP) | 2 already authenticated (MFA
              skipped — continue capture NOW, no OTP) | 3 not attached / no Okta
              form / wrong password | 4 qid.bin missing (run capture snippet first)
#>
param(
  [string]$Username = "the.thoi@samsung.com",
  [string]$SecretPath   # default resolved below via _paths.ps1 (CWD-independent)
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
. "$PSScriptRoot\_paths.ps1"   # -> $QcSecretPath / $QcProjectRoot (location-derived, not CWD)
if (-not $SecretPath)                              { $SecretPath = $QcSecretPath }
elseif (-not [IO.Path]::IsPathRooted($SecretPath)) { $SecretPath = Join-Path $QcProjectRoot $SecretPath }

function AB { agent-browser @args 2>&1 }

if (-not (Test-Path $SecretPath)) {
  Write-Host "ERROR: $SecretPath missing. Run capture_password.ps1 first."
  exit 4
}

# --- Step 0: check current state FIRST. Only navigate fresh if we're not already
# mid-flow — re-opening the portal when already on the password screen resets Okta
# back to the username step and throws away progress the caller already made.
$snap = (AB snapshot -i | Out-String)
if ($snap -match 'os error 10060' -or $snap -match 'Failed to read') {
  Write-Host "ERROR: agent-browser not attached. Run connect_chrome.ps1 + 'agent-browser connect 9222' first."
  exit 3
}
if ($snap -notmatch '(Username|Qualcomm ID|Password|Sign In|Verify)') {
  # Not already on an Okta form — navigate to the portal to trigger the auth flow.
  AB open "https://support.qualcomm.com" | Out-Host
  Start-Sleep -Seconds 2
  $snap = (AB snapshot -i | Out-String)
}
if ($snap -match 'dashboard' -or $snap -notmatch '(Username|Qualcomm ID|Password|Sign In|Verify)') {
  Write-Host ">>> AUTHENTICATED -- session already valid (no Okta form). No password, no OTP."
  Write-Host ">>> Continue the capture NOW: re-run run_case.mjs."
  exit 2
}

# --- Step 1: username screen -> Next ---
# NOTE: the field label seen live is "Qualcomm ID", not "Username" (confirmed
# 2026-07). Matching on "Username" alone silently skipped this whole block and
# fell through to the password check with a stale username-only snapshot.
if ($snap -match '(Username|Qualcomm ID)') {
  # Prefill defends against a blank field; harmless if already populated.
  AB fill "input[name='identifier']" $Username 2>&1 | Out-Null
  AB click "input[type='submit']" | Out-Host
  Start-Sleep -Seconds 2
  $snap = (AB snapshot -i | Out-String)
}

# --- Step 2: password screen -> decrypt + fill + Verify ---
if ($snap -notmatch 'Password') {
  Write-Host "WARN: password field not found after Next. Live DOM:"
  Write-Host $snap
  exit 3
}
$enc = [IO.File]::ReadAllBytes($SecretPath)
$pw  = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect(
    $enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
AB fill "input[type='password']" $pw 2>&1 | Out-Null   # never echo $pw
$pw = $null; [GC]::Collect()
AB click "input[type='submit']" | Out-Host
Start-Sleep -Seconds 3

# --- Classify the post-password state: authenticated / OTP / bounce ---
# There are THREE outcomes after Verify, not two:
#   (a) AUTHENTICATED — Okta skipped MFA (remembered device / still-warm session)
#       and dropped us straight back on support.qualcomm.com. Waiting for an OTP
#       here hangs forever: none is sent. Tell the caller to continue NOW (exit 2).
#   (b) OTP screen — human pastes the 6-digit email code (exit 0).
#   (c) BOUNCE — Okta identifier-first sends a WRONG/EMPTY password BACK to the
#       username screen (it will NOT say "wrong password" on the password page) (exit 3).
$post  = (AB snapshot -i | Out-String)
$host2 = (AB eval "location.hostname" 2>&1 | Out-String).Trim()

# The host is the authority: only "support.qualcomm.com" (or portal chrome in the
# snapshot) proves we cleared the WHOLE Okta flow. Absence of "account.qualcomm.com"
# alone is NOT enough — a failed eval must never masquerade as authenticated.
$onPortal  = ($host2 -match 'support\.qualcomm\.com') -or ($post -match 'dashboard|My Cases')
$looksOtp  = $post -match '(Send me an email|Get a verification|Enter a verification code|verification code|Enter Code)'
$looksUser = $post -match "(name=.?identifier|Username|Qualcomm ID|Sign In)"

# (a) Already through Okta -> live session, no OTP.
if ($onPortal) {
  Write-Host "`n>>> AUTHENTICATED -- past MFA already (host: $host2). No OTP needed."
  Write-Host ">>> Continue the capture NOW: re-run run_case.mjs. Do NOT wait for an OTP."
  exit 2
}

# (c) Bounced back to the username screen = signature of a wrong/empty password.
if ($looksUser -and -not $looksOtp) {
  Write-Host "`nERROR: bounced back to the USERNAME screen after submitting the password."
  Write-Host "       This is Okta's signature for a WRONG or EMPTY password in qid.bin."
  Write-Host "       Fix (do once):"
  Write-Host "         Remove-Item `"$SecretPath`" -Force"
  Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1"
  Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\okta_login.ps1"
  exit 3
}

# (b) Still on Okta with an OTP prompt -> hand off to the human.
Write-Host "`n--- post-password DOM ---"
Write-Host $post
Write-Host "`n>>> Password accepted. Complete the email OTP in the Chrome window:"
Write-Host ">>>   'Send me an email' -> 'Enter a verification code instead' -> paste 6-digit code -> Verify."
exit 0
