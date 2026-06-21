<#
.SYNOPSIS
  One-time DPAPI capture of the Qualcomm ID password into data\.secrets\qid.bin.

.DESCRIPTION
  USER runs this once in a REAL PowerShell window (NOT cmd.exe). The password is
  typed into the terminal via Read-Host and NEVER enters the chat. Stored with
  Windows DPAPI (CurrentUser scope): the ciphertext only decrypts for this Windows
  user on this machine. Git-ignored.

  Canonical capture. Do NOT hand the user a hand-typed inline snippet — give them
  THIS file's path and have them run it. (An improvised one-liner mis-nested the
  ProtectedData parens and silently wrote a null file.)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Project root = 4 levels up from this script (scripts -> qualcomm-case-agent -> skills -> .claude -> ROOT)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$dir  = Join-Path $root 'data\.secrets'
$out  = Join-Path $dir  'qid.bin'

Add-Type -AssemblyName System.Security   # REQUIRED on PS 5.1 or ProtectedData = TypeNotFound
New-Item -ItemType Directory -Force $dir | Out-Null

$sec  = Read-Host "Qualcomm ID password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$enc = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($pw), $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($out, $enc)
$pw = $null

if ((Get-Item $out).Length -gt 0) {
  Write-Host "Saved $out (DPAPI, CurrentUser), $((Get-Item $out).Length) bytes."
} else {
  Write-Host "FAIL - qid.bin is empty; re-run."
}
