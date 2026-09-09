<#
  _paths.ps1 - single source of truth for skill paths (PowerShell).

  Dot-source it at the top of every .ps1 in this folder:
      . "$PSScriptRoot\_paths.ps1"

  Design goals (so the skill keeps working when copied to ANY workspace/machine):
   - CWD-independent: every path derives from THIS file's location ($PSScriptRoot),
     never from Get-Location. Run the scripts from anywhere.
   - Nesting-depth-independent: the project root is found by WALKING UP to a marker
     (.git or an existing data\cases), not by counting a fixed number of '..'.
     Survives the skill being re-nested (e.g. under .claude\plugins\...).
   - Escape hatch: $env:QUALCOMM_ROOT pins the project root, $env:QUALCOMM_SECRET
     pins the DPAPI blob, for layouts the walk-up cannot infer.

  Exposes (Qc-prefixed to avoid clobbering a caller's own param):
     $QcSkillRoot   - the qualcomm-case-agent\ folder
     $QcProjectRoot - workspace root (holds data\)
     $QcSecretPath  - data\.secrets\qid.bin   (DPAPI ciphertext)
     $QcProfileDir  - data\chrome-profile\    (persistent Chrome --user-data-dir)
     $QcDataDir     - data\cases\             (case cache)

  NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file as the
  ANSI codepage, so non-ASCII chars corrupt parsing.
#>

# $PSScriptRoot here = the scripts\ dir (resolves to THIS file's folder even when dot-sourced).
$QcSkillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Resolve-QcWorktreeMainRoot {
  param([string]$D)
  $p = Join-Path $D '.git'
  if (-not (Test-Path $p -PathType Leaf)) { return $null }   # dir, or missing
  $line = Get-Content $p -Raw | Select-String '^gitdir:\s*(.+?)\s*$'
  if (-not $line) { return $null }
  $gitdir = $line.Matches[0].Groups[1].Value -replace '\\', '/'
  $i = $gitdir.IndexOf('/worktrees/')
  if ($i -lt 0) { return $null }
  return Split-Path ($gitdir.Substring(0, $i)) -Parent   # .../.git -> main repo root
}

function Find-QcProjectRoot {
  param([string]$Start)
  $d = $Start
  while ($d) {
    # A git *worktree* has .git as a FILE (a "gitdir: ..." pointer) -- resolve
    # it straight back to the main repo root so a worktree shares ONE data\
    # tree with its checkout instead of silently forking its own empty cache.
    $mainRoot = Resolve-QcWorktreeMainRoot $d
    if ($mainRoot) { return $mainRoot }
    if (Test-Path (Join-Path $d '.git') -PathType Container) { return $d }   # repo root
    if (Test-Path (Join-Path $d 'data\cases'))  { return $d }   # established cache = root
    $parent = Split-Path $d -Parent
    if ($parent -eq $d) { break }   # reached filesystem root
    $d = $parent
  }
  return $null
}

if ($env:QUALCOMM_ROOT) {
  $QcProjectRoot = $env:QUALCOMM_ROOT
} else {
  $QcProjectRoot = Find-QcProjectRoot $QcSkillRoot
  if (-not $QcProjectRoot) { $QcProjectRoot = (Get-Location).Path }   # last resort
}

if ($env:QUALCOMM_SECRET) {
  $QcSecretPath = $env:QUALCOMM_SECRET
} else {
  $QcSecretPath = Join-Path $QcProjectRoot 'data\.secrets\qid.bin'
}
$QcProfileDir = Join-Path $QcProjectRoot 'data\chrome-profile'
$QcDataDir    = Join-Path $QcProjectRoot 'data\cases'
$QcUserPath   = Join-Path $QcProjectRoot 'data\.secrets\qid.user'

if ($env:QUALCOMM_USER) {
  $QcUser = $env:QUALCOMM_USER
} elseif (Test-Path $QcUserPath) {
  $QcUser = (Get-Content $QcUserPath -Raw).Trim()
} else {
  $QcUser = $null
}
