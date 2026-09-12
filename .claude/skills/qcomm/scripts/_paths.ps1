<#
  _paths.ps1 - PowerShell adapter onto _paths.mjs (single source of truth).

  Dot-source it at the top of every .ps1 in this folder:
      . "$PSScriptRoot\_paths.ps1"

  Shells out to `node _paths.mjs --json` instead of re-implementing the
  project-root walk-up / git-worktree-pointer resolution here in PowerShell --
  that logic used to be duplicated in this file by hand and drifted out of
  sync with _paths.mjs. Env overrides ($env:QUALCOMM_ROOT, $env:QUALCOMM_SECRET,
  $env:QUALCOMM_USER) still work: the node subprocess inherits this process's
  environment.

  Exposes (Qc-prefixed to avoid clobbering a caller's own param):
     $QcSkillRoot   - the qcomm\ folder
     $QcProjectRoot - workspace root (holds data\)
     $QcSecretPath  - data\.secrets\qid.bin   (DPAPI ciphertext)
     $QcProfileDir  - data\chrome-profile\    (persistent Chrome --user-data-dir)
     $QcDataDir     - data\cases\             (case cache)
     $QcUserPath    - data\.secrets\qid.user
     $QcUser        - resolved Qualcomm ID username, or $null

  NOTE: keep this file ASCII-only. PowerShell 5.1 reads a BOM-less file as the
  ANSI codepage, so non-ASCII chars corrupt parsing.
#>

$QcPathsScript = Join-Path $PSScriptRoot '_paths.mjs'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$QcNodePath = if ($nodeCmd -and $nodeCmd.Source) { $nodeCmd.Source } else { 'node' }

$QcPathsJson = & $QcNodePath $QcPathsScript --json
if ($LASTEXITCODE -ne 0 -or -not $QcPathsJson) {
  throw "_paths.ps1: failed to resolve paths via '$QcNodePath $QcPathsScript --json'"
}
$QcPaths = $QcPathsJson | ConvertFrom-Json

$QcSkillRoot   = $QcPaths.skillRoot
$QcProjectRoot = $QcPaths.projectRoot
$QcSecretPath  = $QcPaths.secretPath
$QcProfileDir  = $QcPaths.profileDir
$QcDataDir     = $QcPaths.dataDir
$QcUserPath    = $QcPaths.userPath
$QcUser        = $QcPaths.user
