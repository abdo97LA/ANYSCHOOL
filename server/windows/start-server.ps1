# Démarre le serveur (tâche planifiée). Usage : powershell -ExecutionPolicy Bypass -File windows\start-server.ps1
. "$PSScriptRoot\common.ps1"
if (Get-ServerPid) { Write-Host "Le serveur est déjà en cours d'exécution (PID $(Get-ServerPid))."; exit 0 }
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Write-Host "Tâche « $TaskName » absente : lancez d'abord windows\install-server.ps1 (ou windows\run-console.bat pour un test)." -ForegroundColor Red; exit 1 }
Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Get-ServerPid) { break } }
& "$PSScriptRoot\status-server.ps1" -Short
