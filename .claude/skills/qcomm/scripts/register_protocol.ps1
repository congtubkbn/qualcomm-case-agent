<#
.SYNOPSIS
    Registers the custom URL protocol scheme (qc://) in the Windows Registry for the current user.
.DESCRIPTION
    Creates HKCU:\Software\Classes\qc registry structure to handle qc://case/<id> and qc://<id>
    links without requiring Administrator privileges or UAC elevation.
#>

[CmdletBinding()]
param (
    [string]$KeyPath = "HKCU:\Software\Classes\qc",
    [string]$ScriptPath = "",
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

try {
    # Resolve target open_qc_case.mjs script path
    if (-not $ScriptPath) {
        $ScriptPath = Join-Path $PSScriptRoot "open_qc_case.mjs"
    }
    $ScriptPath = [System.IO.Path]::GetFullPath($ScriptPath)

    if (-not (Test-Path $ScriptPath)) {
        Write-Error "Target dispatcher script not found at: $ScriptPath"
        exit 1
    }

    # Resolve node binary
    if (-not $NodePath) {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCmd -and $nodeCmd.Source) {
            $NodePath = $nodeCmd.Source
        } else {
            $NodePath = "node"
        }
    }

    # Create root protocol key in HKCU
    if (-not (Test-Path $KeyPath)) {
        New-Item -Path $KeyPath -Force | Out-Null
    }

    Set-ItemProperty -Path $KeyPath -Name "(Default)" -Value "URL:Qualcomm Case Protocol"
    Set-ItemProperty -Path $KeyPath -Name "URL Protocol" -Value ""

    # Create shell\open\command subkey
    $cmdKeyPath = Join-Path $KeyPath "shell\open\command"
    if (-not (Test-Path $cmdKeyPath)) {
        New-Item -Path $cmdKeyPath -Force | Out-Null
    }

    # Command string formatting: "<NodePath>" "<ScriptPath>" "%1"
    $launchCommand = "`"$NodePath`" `"$ScriptPath`" `"%1`""
    Set-ItemProperty -Path $cmdKeyPath -Name "(Default)" -Value $launchCommand

    Write-Host "[QC Protocol] Successfully registered qc:// protocol handler in $KeyPath"
    Write-Host "  Dispatcher: $ScriptPath"
    Write-Host "  Node executable: $NodePath"
    Write-Host "  Command: $launchCommand"
    exit 0
} catch {
    Write-Error "[QC Protocol Error] Failed to register protocol: $_"
    exit 1
}
