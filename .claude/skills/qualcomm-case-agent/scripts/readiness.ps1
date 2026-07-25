param()
. "$PSScriptRoot\_paths.ps1"   # -> $QcSkillRoot (location-derived, not CWD)
$b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $QcSkillRoot 'scripts\readiness.js')))
for($i=0;$i -lt 6;$i++){
  $R = agent-browser eval -b $b64
  Write-Output $R
  if ($R -match '"state":"(READY|EMPTY|AUTH|BLANK)"'){break}
  agent-browser wait 2000
}