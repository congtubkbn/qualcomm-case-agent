<#
  recover_chrome.ps1 - Recovery 0 as ONE script (was a raw PowerShell block
  pasted into SKILL.md, which errored when the agent ran it through the Bash
  tool: 'Where-Object' is not recognized ...). Bundling it means the agent
  runs a single `powershell -File` line - identical under Bash tool, cmd, and
  PowerShell - so the dialect mismatch can no longer happen.

  What it does (safe, path-filtered - NEVER touches the user's personal Chrome):
   0. Diagnose (read-only): if the target port is held by a process that is NOT
      this project's Chrome (issue #104 - an external CDP port-scanner attached
      to it first and corrupted the Okta session), print its PID and command
      line and suggest a Stop-Process command. NEVER auto-kills it - could be
      an unrelated, legitimate process.
   1. Kill only agent-browser's OWN throwaway Chrome (ExecutablePath under
      \.agent-browser\) and the agent-browser daemon process.
   2. Remove the stale daemon pid/port/stream files.
   3. Re-launch the persistent-profile Chrome on CDP 9773 via connect_chrome.ps1
      and print the exact `agent-browser connect "ws://..."` line to run next.

  Usage:
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qcomm/scripts/recover_chrome.ps1"

  NOTE: keep this file ASCII-only (PS 5.1 reads a BOM-less file as ANSI).
#>
param([int]$Port = 9773)

. "$PSScriptRoot\_paths.ps1"   # -> $QcProfileDir (location-derived)

# 0. Diagnose the target port, read-only. Runs BEFORE the cleanup below so the
#    report reflects what was actually squatting on the port, not what's left
#    after this script's own cleanup runs.
$portOwner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portOwner) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($portOwner.OwningProcess)" -ErrorAction SilentlyContinue
  $cmdLine = if ($proc) { $proc.CommandLine } else { $null }
  Write-Host "Port $Port is held by PID $($portOwner.OwningProcess): $cmdLine"
  if (-not $cmdLine -or $cmdLine -notlike "*$QcProfileDir*") {
    Write-Host "This does NOT look like qcomm's Chrome (expected --user-data-dir under $QcProfileDir)."
    Write-Host "If you're sure it's safe to close, run: Stop-Process -Id $($portOwner.OwningProcess) -Force"
  }
} else {
  Write-Host "Port $Port is not currently held by anything."
}

# Cleanup must be best-effort: a missing process/file is success, not an error.
$ErrorActionPreference = "SilentlyContinue"

# 1. Stop agent-browser's own Chrome (path-filtered) + the daemon. The filter on
#    ExecutablePath under \.agent-browser\ guarantees the user's real Chrome and
#    our persistent-profile Chrome (launched from the system chrome.exe) are left
#    untouched - only the daemon's temp-profile spawn matches.
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process agent-browser-win32-x64 | Stop-Process -Force

# 2. Drop the stale daemon handshake files so the next connect starts clean.
Remove-Item "$env:USERPROFILE\.agent-browser\default.pid",
            "$env:USERPROFILE\.agent-browser\default.port",
            "$env:USERPROFILE\.agent-browser\default.stream" -Force

# 3. Re-launch the persistent-profile Chrome. connect_chrome.ps1 is idempotent and
#    prints the ws:// connect line. Restore strict error handling for the launch.
$ErrorActionPreference = "Stop"
& "$PSScriptRoot\connect_chrome.ps1" -Port $Port
