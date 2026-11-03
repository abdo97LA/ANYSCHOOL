# Réinitialise le mot de passe d'un compte (secours, par exemple administrateur oublié). EN TANT QU'ADMINISTRATEUR.
param([string]$Username)
. "$PSScriptRoot\common.ps1"
Assert-Admin
$was = [bool](Get-ServerPid); if ($was) { & "$PSScriptRoot\stop-server.ps1" }
Push-Location $ServerDir; if ($Username) { & (Get-NodeExe) tools\reset-password.js --username $Username } else { & (Get-NodeExe) tools\reset-password.js }; Pop-Location
if ($was) { & "$PSScriptRoot\start-server.ps1" }
