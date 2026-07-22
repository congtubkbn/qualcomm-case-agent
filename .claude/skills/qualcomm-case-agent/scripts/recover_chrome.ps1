<#
  recover_chrome.ps1 - Recovery 0 as ONE script (was a raw PowerShell block
  pasted into SKILL.md, which errored when the agent ran it through the Bash
  tool: 'Where-Object' is not recognized ...). Bundling it means the agent
  runs a single `powershell -File` line - identical under Bash tool, cmd, and
  PowerShell - so the dialect mismatch can no longer happen.

  What it does (safe, path-filtered - NEVER touches the user's personal Chrome):
   1. Kill only agent-browser's OWN throwaway Chrome (ExecutablePath under
      \.agent-browser\) and the agent-browser daemon process.
   2. Remove the stale daemon pid/port/stream files.
   3. Re-launch the persistent-profile Chrome on CDP 9222 via connect_chrome.ps1
      and print the exact `agent-browser connect "ws://..."` line to run next.

  Usage:
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1"

  NOTE: keep this file ASCII-only (PS 5.1 reads a BOM-less file as ANSI).
#>
param([int]$Port = 9222)

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
