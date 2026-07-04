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

  Usage (run from anywhere - paths resolve from the script's own location):
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
     agent-browser connect 9222
  Optional args:
     -Port 9222            CDP/remote-debugging port (default 9222)
     -Profile <dir>        user-data-dir (default: <project-root>\data\chrome-profile)

  Exit codes: 0 CDP up (launched or reused, OUR profile verified where readable)
              3 Chrome not found | 4 CDP port never came up
              5 port is held by a DIFFERENT process/profile (close it or use -Port;
                do NOT loop Recovery 0 on this - its kill cannot reach that process)

  NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file as the
  ANSI codepage, so non-ASCII chars (em-dashes, curly quotes) corrupt parsing.
#>
param(
  [int]$Port = 9222,
  [string]$Profile = "",   # default resolved below via _paths.ps1 (project-root, NOT CWD)
  [string]$ChromePath = ""
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_paths.ps1"   # -> $QcProfileDir / $QcProjectRoot (location-derived)

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
# Default = project-root data\chrome-profile (location-derived, NOT CWD) so the SAME session
# profile is reused no matter which folder you launch from. A relative -Profile override is
# resolved against the project root too.
if (-not $Profile)                                 { $Profile = $QcProfileDir }
elseif (-not [System.IO.Path]::IsPathRooted($Profile)) { $Profile = Join-Path $QcProjectRoot $Profile }
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
  # Guard: the listener must be OUR profile's Chrome. Blindly "reusing" a foreign
  # listener (another tool, or a Chrome on a DIFFERENT --user-data-dir) is the
  # silent stuck-loop: the saved Okta session never loads, every run re-logins,
  # and Recovery 0 cannot fix it (its kill is path-filtered to .agent-browser).
  # Positive mismatch only - if the command line is unreadable (rights), fall
  # through to reuse with a caution rather than false-blocking.
  $own = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -First 1).OwningProcess
  $cmd = $null
  if ($own) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$own" -ErrorAction SilentlyContinue
    if ($proc) { $cmd = $proc.CommandLine }
  }
  if ($cmd -and $cmd.IndexOf($Profile, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Write-Host "ERROR: port $Port is already used by a DIFFERENT process/profile (pid $own):"
    Write-Host "  $cmd"
    Write-Host "Expected --user-data-dir: $Profile"
    Write-Host "The saved Okta session lives ONLY in that profile - reusing this listener would force a login every run."
    Write-Host "Fix: close that process (or re-run with -Port <other> and connect to that port instead)."
    exit 5
  }
  Write-Host "Chrome CDP already listening on $Port - reusing it. Profile: $Profile"
  if (-not $cmd) { Write-Host "  (note: listener command line unreadable - could not verify the profile)" }
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
