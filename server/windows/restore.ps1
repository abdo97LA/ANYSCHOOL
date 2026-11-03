# Restaure une sauvegarde : arrête le serveur, restaure (après copie de sécurité de l'état actuel), redémarre.
# Usage : windows\restore.ps1 -List        |  windows\restore.ps1 -Name 20261025-020000-auto [-From D:\Sauvegardes\UniTimetable]
param([switch]$List, [string]$Name, [string]$From)
. "$PSScriptRoot\common.ps1"
$node = Get-NodeExe; Push-Location $ServerDir
$extra = @(); if ($From) { $extra = @('--from', $From) }
if ($List -or -not $Name) { & $node tools\restore.js --list @extra; Pop-Location; if (-not $Name) { Write-Host 'Indiquez -Name <sauvegarde>.' }; exit 0 }
Pop-Location
Assert-Admin
$was = [bool](Get-ServerPid); if ($was) { & "$PSScriptRoot\stop-server.ps1" }
Push-Location $ServerDir; & $node tools\restore.js --name $Name @extra; Pop-Location
if ($was) { & "$PSScriptRoot\start-server.ps1" }
