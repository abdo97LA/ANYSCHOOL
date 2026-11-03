# Arrête le serveur et son superviseur (EN TANT QU'ADMINISTRATEUR si le serveur tourne sous SYSTEM).
. "$PSScriptRoot\common.ps1"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*run-server.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$p = Get-ServerPid
if ($p) {
    # Les écritures du serveur sont atomiques (fichier temporaire puis renommage) : l'arrêt ne peut pas corrompre les données.
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1
    $c = Read-ServerEnv; Remove-Item (Join-Path $c['DATA_DIR'] 'server.lock') -ErrorAction SilentlyContinue
    Write-Host "Serveur arrêté (PID $p)."
} else { Write-Host 'Le serveur n''était pas en cours d''exécution.' }
