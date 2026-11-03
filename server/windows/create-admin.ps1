# Crée un compte administrateur (arrête puis redémarre le serveur si nécessaire). EN TANT QU'ADMINISTRATEUR.
. "$PSScriptRoot\common.ps1"
Assert-Admin
$was = [bool](Get-ServerPid); if ($was) { & "$PSScriptRoot\stop-server.ps1" }
Push-Location $ServerDir; & (Get-NodeExe) tools\create-admin.js; Pop-Location
if ($was) { & "$PSScriptRoot\start-server.ps1" }
