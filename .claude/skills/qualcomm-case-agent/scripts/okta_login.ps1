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

  EXIT CODES: 0 password submitted (do OTP) | 3 not attached / no Okta form |
              4 qid.bin missing (run capture snippet first)
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

# --- Step 0: open portal, confirm we are attached + on Okta ---
AB open "https://support.qualcomm.com" | Out-Host
Start-Sleep -Seconds 2
$snap = (AB snapshot -i | Out-String)
if ($snap -match 'os error 10060' -or $snap -match 'Failed to read') {
  Write-Host "ERROR: agent-browser not attached. Run connect_chrome.ps1 + 'agent-browser connect 9222' first."
  exit 3
}
if ($snap -match 'dashboard' -or $snap -notmatch '(Username|Password|Sign In|Verify)') {
  Write-Host "Session appears valid (no Okta form). Nothing to do."
  exit 0
}

# --- Step 1: username screen -> Next ---
if ($snap -match 'Username') {
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

# --- Verify the password actually advanced us past the credential step ---
# Okta identifier-first bounces a WRONG/EMPTY password BACK to the username screen
# (it will NOT say "wrong password" on the password page). Detect that bounce so we
# don't falsely tell the user to look for an OTP that never appears.
$post = (AB snapshot -i | Out-String)
$looksOtp  = $post -match '(verification code|Send me an email|Get a verification|Enter a code|Verify)'
$looksUser = $post -match "(name=.?identifier|Username|Sign In)"
if ($looksUser -and -not $looksOtp) {
  Write-Host "`nERROR: bounced back to the USERNAME screen after submitting the password."
  Write-Host "       This is Okta's signature for a WRONG or EMPTY password in qid.bin."
  Write-Host "       Fix (do once):"
  Write-Host "         Remove-Item `"$SecretPath`" -Force"
  Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1"
  Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\okta_login.ps1"
  exit 3
}

# --- Hand off to human for email OTP ---
Write-Host "`n--- post-password DOM ---"
Write-Host $post
Write-Host "`n>>> Password accepted. Complete the email OTP in the Chrome window:"
Write-Host ">>>   'Send me an email' -> 'Enter a verification code instead' -> paste 6-digit code -> Verify."
exit 0
