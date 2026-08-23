<#
.SYNOPSIS
    Unregisters the custom URL protocol scheme (qc://) from the Windows Registry for the current user.
.DESCRIPTION
    Safely removes HKCU:\Software\Classes\qc registry structure without requiring Administrator
    privileges or UAC elevation.
#>

[CmdletBinding()]
param (
    [string]$KeyPath = "HKCU:\Software\Classes\qc"
)

$ErrorActionPreference = "Stop"

try {
    if (Test-Path $KeyPath) {
        Remove-Item -Path $KeyPath -Recurse -Force
        Write-Host "[QC Protocol] Successfully unregistered protocol handler from $KeyPath"
    } else {
        Write-Host "[QC Protocol] Protocol handler is not registered at $KeyPath (nothing to do)"
    }
    exit 0
} catch {
    Write-Error "[QC Protocol Error] Failed to unregister protocol: $_"
    exit 1
}
