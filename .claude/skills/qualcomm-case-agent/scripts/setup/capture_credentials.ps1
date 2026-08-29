<#
.SYNOPSIS
  One-time DPAPI capture of the Qualcomm ID (email) and password into data\.secrets\.

.DESCRIPTION
  USER runs this once in a REAL PowerShell window (NOT cmd.exe).
  The credentials are typed into the terminal and saved locally.
  The password is encrypted with Windows DPAPI (CurrentUser scope) into qid.bin.
  The email is saved in plaintext into qid.user.
  Git-ignored.

.EXAMPLE
  npm run setup:credentials
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\_paths.ps1"
$out = $QcSecretPath
$dir = Split-Path $out -Parent
$userFile = Join-Path $dir "qid.user"

Add-Type -AssemblyName System.Security
New-Item -ItemType Directory -Force $dir | Out-Null

$defaultUser = "the.thoi@samsung.com"
if ($env:QUALCOMM_USER) { $defaultUser = $env:QUALCOMM_USER }
if (Test-Path $userFile) {
  $defaultUser = (Get-Content $userFile -Raw).Trim()
}

$userInput = Read-Host "Qualcomm ID (email) [default: $defaultUser]"
if (-not $userInput) { $userInput = $defaultUser }
$userInput = $userInput.Trim()

if (-not $userInput) {
  Write-Error "Qualcomm ID (email) cannot be empty."
  exit 1
}

# Save the email
[IO.File]::WriteAllText($userFile, $userInput)
Write-Host "Saved username: $userInput to $userFile"

$sec  = Read-Host "Qualcomm ID password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if (-not $pw) {
  Write-Error "Password cannot be empty."
  exit 1
}

$enc = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($pw), $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($out, $enc)
$pw = $null

if ((Get-Item $out).Length -gt 0) {
  Write-Host "Saved password to $out (DPAPI, CurrentUser), $((Get-Item $out).Length) bytes."
} else {
  Write-Host "FAIL - qid.bin is empty; re-run."
}
