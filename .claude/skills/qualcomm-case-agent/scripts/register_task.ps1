# register_task.ps1 - put the scheduler on Windows Task Scheduler.
#
#   powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\register_task.ps1
#   powershell -ExecutionPolicy Bypass -File ...\register_task.ps1 -EveryMinutes 60
#   powershell -ExecutionPolicy Bypass -File ...\register_task.ps1 -Remove
#
# The task runs `scheduler.mjs --once`, which captures only the cases whose own
# interval has elapsed - so a tight task trigger stays cheap, and data/watchlist.json
# remains the single place that decides how often each case is actually pulled.
#
# It runs INTERACTIVE (-LogonType Interactive), not as SYSTEM: the Chrome profile
# and the DPAPI-encrypted password are bound to your user account, and a SYSTEM
# task would see neither.

param(
  [int]$EveryMinutes = 60,
  [string]$TaskName = 'QualcommCaseSync',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_paths.ps1"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled task $TaskName"
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'scheduler.mjs'

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --once" -WorkingDirectory $QcProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
             -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "registered $TaskName - every $EveryMinutes min, working dir $QcProjectRoot"
Write-Host "check it:  Get-ScheduledTaskInfo -TaskName $TaskName"
