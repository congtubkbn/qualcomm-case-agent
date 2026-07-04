<#
  okta_login.ps1 - drive Qualcomm Okta identifier-first login through the
  password step using the DPAPI-stored credential. Email OTP stays human.

  CONFIRMED Okta flow (support.qualcomm.com, observed 2026-06):
    1. username screen : textbox "Username" (often prefilled) + button "Next"
                         (+ "Keep me signed in" checkbox - checked here, ~30d session)
    2. password screen : textbox "Password"               + button "Verify"
    3. email-OTP screen : "Get a verification email" -> "Send me an email"
                          -> "Enter a verification code instead" -> 6-digit code
  This script handles steps 1-2 only. The password is decrypted from
  data\.secrets\qid.bin and passed straight to agent-browser; it is NEVER
  printed. The human completes step 3 (Claude cannot read the mailbox).

  STUCK-PROOFING (v2): every wait is a BOUNDED POLL, never a fixed sleep.
  The Salesforce/Okta pages are SPAs - a single 2s sleep races hydration and
  produced two false verdicts in v1: "Session appears valid" on a page that
  had not rendered yet, and "password accepted" when Okta was actually
  showing a credential error (the old OTP regex matched the word 'Verify',
  which is on the PASSWORD screen itself). State is now decided by
  location.hostname via eval (cheap, race-free) plus OTP-SPECIFIC markers.

  PREREQS (Phase 0): real Chrome on CDP 9222 + agent-browser attached:
    powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\connect_chrome.ps1
    agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"

  RUN from anywhere (paths resolve via _paths.ps1 from the script's own location):
    powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\okta_login.ps1

  EXIT CODES:
    0 session already valid, OR established with no OTP, OR password accepted
      and the OTP screen is up (message says which - only the OTP case needs
      the human)
    3 not attached / page never reached a known state within the timeout
      (report the dumped DOM; do NOT retry in a loop)
    4 qid.bin missing (run capture_password.ps1 first)
    6 WRONG PASSWORD (bounced to username screen, or password-screen error).
      Delete qid.bin, re-run capture_password.ps1, retry ONCE. Do NOT treat
      as an OTP problem.

  NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file as the
  ANSI codepage, so non-ASCII chars corrupt parsing.
#>
param(
  [string]$Username = "the.thoi@samsung.com",
  [string]$SecretPath,        # default resolved below via _paths.ps1 (CWD-independent)
  [int]$StepTimeoutSec = 20   # per-transition poll ceiling (bounded - never infinite)
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
. "$PSScriptRoot\_paths.ps1"   # -> $QcSecretPath / $QcProjectRoot (location-derived, not CWD)
if (-not $SecretPath)                              { $SecretPath = $QcSecretPath }
elseif (-not [IO.Path]::IsPathRooted($SecretPath)) { $SecretPath = Join-Path $QcProjectRoot $SecretPath }

function AB { agent-browser @args 2>&1 }

# Current hostname via eval - the race-free state signal. Returns $null when the
# result does not look like a hostname (daemon not attached, eval error text,
# about:blank). eval prints the JSON-serialized result, i.e. quoted.
function Get-QcHostname {
  $out = (AB eval "location.hostname" | Out-String).Trim()
  $h = $out.Trim('"')
  if ($h -match '^[A-Za-z0-9.-]+$' -and $h -match '\.') { return $h.ToLower() }
  return $null
}

# Classify the current hostname. PORTAL = signed-in support portal.
# AUTH = any identity-provider host (account.qualcomm.com, *.okta.com, sso/login hosts).
function Get-QcHostState([string]$h) {
  if (-not $h) { return 'NONE' }
  if ($h -eq 'support.qualcomm.com') { return 'PORTAL' }
  if ($h -match 'okta\.com$' -or $h -match '(account|login|signin|sso|auth)') { return 'AUTH' }
  return 'UNKNOWN'
}

# OTP-SPECIFIC markers only. Deliberately does NOT include the word 'Verify' -
# that button is on the PASSWORD screen too, and matching it made v1 report
# "password accepted" on a rejected password (human then waits for a mail that
# never comes). Same reason 'Sign In' is not an OTP marker.
$OtpPattern  = '(verification code|Send me an email|Get a verification email|Enter a code)'
$PwErrPattern = '(incorrect|Unable to sign in|Authentication failed|too many attempts)'

# Screen signatures from the a11y snapshot: the field NAME in quotes is stabler
# than loose words ('Sign In' is in headers; 'password' is in a "Forgot
# password?" link on the USERNAME screen and would poison a bare -match).
function Test-QcUserScreen([string]$s) { return (($s -match '"Username"') -or ($s -match "name=.?identifier")) }
function Test-QcPwScreen([string]$s)   { return ($s -match '"Password"') }

if (-not (Test-Path $SecretPath)) {
  Write-Host "ERROR: $SecretPath missing. Run capture_password.ps1 first."
  exit 4
}

# --- Step 0: open portal, then POLL hostname until a known state (no blind sleep) ---
AB open "https://support.qualcomm.com" | Out-Host
$deadline = (Get-Date).AddSeconds($StepTimeoutSec)
$state = 'NONE'; $lastHost = $null
while ($true) {
  $lastHost = Get-QcHostname
  $state = Get-QcHostState $lastHost
  if ($state -eq 'PORTAL' -or $state -eq 'AUTH') { break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds 2
}
if ($state -eq 'PORTAL') {
  Write-Host "Session valid (already on support.qualcomm.com). Nothing to do."
  exit 0
}
if ($state -ne 'AUTH') {
  if ($null -eq $lastHost) {
    Write-Host "ERROR: agent-browser not attached (eval returned no hostname within ${StepTimeoutSec}s)."
    Write-Host "       Run connect_chrome.ps1 and 'agent-browser connect <ws-url>' first (PHASE 0)."
  } else {
    Write-Host "ERROR: page settled on unexpected host '$lastHost' (neither portal nor Okta) within ${StepTimeoutSec}s."
  }
  exit 3
}

# --- Step 1: username screen -> keep-me-signed-in + Next ---
$snap = (AB snapshot -i | Out-String)
if ($snap -match $OtpPattern) {
  # Password step already done in a previous attempt - straight to the handoff.
  Write-Host ">>> OTP screen already up. Complete the email OTP in the Chrome window:"
  Write-Host ">>>   'Send me an email' -> 'Enter a verification code instead' -> paste 6-digit code -> Verify."
  exit 0
}
if (Test-QcUserScreen $snap) {
  # "Keep me signed in" extends the Okta session ~2h -> ~30 days, which is the
  # single biggest reducer of re-login (and therefore of OTP round-trips).
  # Best-effort: selector may vary; a failure here must not block the login.
  AB check "input[name='rememberMe']" 2>&1 | Out-Null
  # Prefill defends against a blank field; harmless if already populated.
  AB fill "input[name='identifier']" $Username 2>&1 | Out-Null
  AB click "input[type='submit']" | Out-Host
}

# --- Step 2: POLL for the password field (Okta transition is not instant) ---
$deadline = (Get-Date).AddSeconds($StepTimeoutSec)
$snap = ""
while ($true) {
  $snap = (AB snapshot -i | Out-String)
  if (Test-QcPwScreen $snap) { break }
  if ((Get-Date) -ge $deadline) {
    Write-Host "WARN: password field never appeared within ${StepTimeoutSec}s. Live DOM:"
    Write-Host $snap
    exit 3
  }
  Start-Sleep -Seconds 2
}
$enc = [IO.File]::ReadAllBytes($SecretPath)
$pw  = [Text.Encoding]::UTF8.GetString(
  [Security.Cryptography.ProtectedData]::Unprotect(
    $enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
AB fill "input[type='password']" $pw 2>&1 | Out-Null   # never echo $pw
$pw = $null; [GC]::Collect()
AB click "input[type='submit']" | Out-Host

# --- Step 3: POLL the outcome. Four terminal states, checked in this order: ---
#   PORTAL host          -> session established, no OTP        -> exit 0
#   OTP markers          -> password accepted, human does OTP  -> exit 0
#   username bounce      -> Okta's wrong/empty-password signature -> exit 6
#   password-screen error -> wrong password variant            -> exit 6
# Anything else keeps polling until the ceiling, then exit 3 with the DOM dump.
$deadline = (Get-Date).AddSeconds($StepTimeoutSec)
$post = ""
while ($true) {
  $h = Get-QcHostname
  if ((Get-QcHostState $h) -eq 'PORTAL') {
    Write-Host ">>> Session established - portal loaded with no OTP challenge."
    exit 0
  }
  $post = (AB snapshot -i | Out-String)
  if ($post -match $OtpPattern) {
    Write-Host "`n>>> Password accepted. Complete the email OTP in the Chrome window:"
    Write-Host ">>>   'Send me an email' -> 'Enter a verification code instead' -> paste 6-digit code -> Verify."
    exit 0
  }
  $looksUser = (Test-QcUserScreen $post) -and (-not (Test-QcPwScreen $post))
  $looksPwErr = (Test-QcPwScreen $post) -and ($post -match $PwErrPattern)
  if ($looksUser -or $looksPwErr) {
    Write-Host "`nERROR: WRONG (or empty) password in qid.bin."
    if ($looksUser) { Write-Host "       (Okta bounced back to the USERNAME screen - its wrong-password signature.)" }
    else            { Write-Host "       (Password screen shows a credential error.)" }
    Write-Host "       Fix (do once):"
    Write-Host "         Remove-Item `"$SecretPath`" -Force"
    Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1"
    Write-Host "         powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\okta_login.ps1"
    exit 6
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds 2
}
Write-Host "`nERROR: page never reached portal / OTP / error state within ${StepTimeoutSec}s. Live DOM:"
Write-Host $post
exit 3
