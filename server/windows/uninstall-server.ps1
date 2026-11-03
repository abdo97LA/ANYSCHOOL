# Retire la tâche planifiée et la règle de pare-feu. Les DONNÉES et SAUVEGARDES sont conservées.
. "$PSScriptRoot\common.ps1"
Assert-Admin
& "$PSScriptRoot\stop-server.ps1"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
& "$PSScriptRoot\configure-firewall.ps1" -Remove
Write-Host 'Désinstallation terminée. Les dossiers data, logs et backups n''ont pas été modifiés.'
