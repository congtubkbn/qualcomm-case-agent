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
  [string]$Profile = "data\chrome-profile"
)

$ErrorActionPreference = "Stop"

# Resolve Chrome executable (64-bit first, then 32-bit).
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) {
  Write-Error "Google Chrome not found. Install it, or edit this path."
  exit 3
}

# Resolve the profile dir to an ABSOLUTE path (Chrome --user-data-dir prefers absolute).
if (-not [System.IO.Path]::IsPathRooted($Profile)) { $Profile = Join-Path (Get-Location).Path $Profile }
New-Item -ItemType Directory -Force $Profile | Out-Null

function Test-Cdp([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

if (Test-Cdp $Port) {
  Write-Host "Chrome CDP already listening on $Port - reusing it. Profile: $Profile"
  exit 0
}

# Launch detached. Start-Process (NOT the '&' call operator) so Chrome does NOT
# inherit the automation shell's redirected stdin (that triggers Windows
# "Input redirection is not supported" / a hung launch).
Start-Process $chrome -ArgumentList @("--remote-debugging-port=$Port", "--user-data-dir=$Profile")

# Poll until the CDP port is up (Chrome can take a couple seconds cold).
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-Cdp $Port) {
    $own = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    Write-Host "Chrome CDP listening on $Port (pid $own). Profile: $Profile"
    Write-Host "Next: agent-browser connect $Port"
    exit 0
  }
}

Write-Error "Chrome launched but CDP port $Port never came up within 20s. Check Chrome / firewall."
exit 4
