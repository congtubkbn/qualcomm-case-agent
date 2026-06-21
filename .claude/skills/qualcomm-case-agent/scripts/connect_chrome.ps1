<#
  connect_chrome.ps1 - launch REAL system Chrome detached with a CDP port +
  dedicated persistent profile, ready for 'agent-browser connect <port>'.

  Why: the bundled Playwright Chromium that ships with agent-browser can break
  (e.g. a freshly-downloaded dev build whose CDP handshake times out =>
  "os error 10060"). Attaching to real Google Chrome over CDP sidesteps that
  entirely and keeps a stable, OS-trusted, signed browser for the SSO session.

  Safe by design:
   - Uses its OWN --user-data-dir (data\chrome-profile), so it runs as a
     SEPARATE Chrome instance and NEVER touches the user's personal Chrome
     (their tabs/work stay open). It does NOT kill any Chrome.
   - Idempotent: if the CDP port is already listening, it just reports OK and
     exits 0 - re-running is harmless.

  Usage (from the workspace root):
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
     agent-browser connect 9222
  Optional args:
     -Port 9222            CDP/remote-debugging port (default 9222)
     -Profile <dir>        user-data-dir (default data\chrome-profile, relative to CWD)

  NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file as the
  ANSI codepage, so non-ASCII chars (em-dashes, curly quotes) corrupt parsing.
#>
param(
  [int]$Port = 9222,
  [string]$Profile = "data\chrome-profile",
  [string]$ChromePath = ""
)

$ErrorActionPreference = "Stop"

# Resolve Chrome executable across the common install locations so this script
# is portable to any Windows machine (per-machine AND per-user installs), then
# fall back to the registry App Paths key for non-standard install dirs.
# Pass -ChromePath to override entirely.
if ($ChromePath -and (Test-Path $ChromePath)) {
  $chrome = $ChromePath
} else {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) {
    foreach ($rk in @(
      "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
      "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe")) {
      if (Test-Path $rk) {
        $p = (Get-Item $rk).GetValue("")
        if ($p -and (Test-Path $p)) { $chrome = $p; break }
      }
    }
  }
  if (-not $chrome) {
    Write-Error "Google Chrome not found in Program Files, LocalAppData, or registry App Paths. Install Chrome or pass -ChromePath '<full path to chrome.exe>'."
    exit 3
  }
}

# Resolve the profile dir to an ABSOLUTE path (Chrome --user-data-dir prefers absolute).
if (-not [System.IO.Path]::IsPathRooted($Profile)) { $Profile = Join-Path (Get-Location).Path $Profile }
New-Item -ItemType Directory -Force $Profile | Out-Null

function Test-Cdp([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

# Return the IPv4 webSocketDebuggerUrl from the CDP /json/version endpoint.
# Why 127.0.0.1 (not localhost): 'agent-browser connect <port>' connects to
# http://localhost:<port>. On Windows 'localhost' resolves to IPv6 ::1 FIRST,
# but Chrome --remote-debugging-port binds ONLY IPv4 127.0.0.1. The ::1 attempt
# has no listener => SYN timeout => "os error 10060". Connecting via the explicit
# ws://127.0.0.1 URL (connect also accepts a full ws:// URL) sidesteps that.
function Get-WsUrl([int]$p) {
  try {
    $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 5
    return $ver.webSocketDebuggerUrl
  } catch { return $null }
}

if (Test-Cdp $Port) {
  Write-Host "Chrome CDP already listening on $Port - reusing it. Profile: $Profile"
  $ws = Get-WsUrl $Port
  if ($ws) { Write-Host "Next: agent-browser connect `"$ws`"" }
  else     { Write-Host "Next: agent-browser connect $Port  (use ws://127.0.0.1 URL if this 10060-times-out)" }
  exit 0
}

# Launch detached. Start-Process (NOT the '&' call operator) so Chrome does NOT
# inherit the automation shell's redirected stdin (that triggers Windows
# "Input redirection is not supported" / a hung launch).
#
# CRITICAL portability detail: PowerShell 5.1 Start-Process -ArgumentList does
# NOT quote array elements - it concatenates them with spaces. If $Profile
# contains a space (e.g. "C:\Users\Win 11\...") the --user-data-dir token gets
# split, Chrome silently uses a bogus data dir / forwards to an already-open
# personal Chrome, and the CDP port never opens (exit 4). Embed literal quotes
# around the path so the value survives spaces on ANY machine/folder.
$chromeArgs = @(
  "--remote-debugging-port=$Port",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=`"$Profile`""
)
Start-Process -FilePath $chrome -ArgumentList $chromeArgs

# Poll until the CDP port is up (Chrome can take a couple seconds cold).
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-Cdp $Port) {
    $own = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    Write-Host "Chrome CDP listening on $Port (pid $own). Profile: $Profile"
    $ws = Get-WsUrl $Port
    if ($ws) { Write-Host "Next: agent-browser connect `"$ws`"" }
    else     { Write-Host "Next: agent-browser connect $Port  (use ws://127.0.0.1 URL if this 10060-times-out)" }
    exit 0
  }
}

Write-Error "Chrome launched but CDP port $Port never came up within 20s. Check Chrome / firewall."
exit 4
