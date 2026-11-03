<#
  Installation du serveur UniTimetable sur le PC principal (à lancer EN TANT QU'ADMINISTRATEUR) :
    - vérifie Node.js ;
    - crée server.env à partir de server.env.exemple (si absent) ;
    - télécharge une fois les bibliothèques Excel/PDF (si Internet est disponible) ;
    - protège les dossiers de données (accès réservé à SYSTEM et aux administrateurs) ;
    - crée la règle du pare-feu Windows (port du serveur, profil Privé, sous-réseau local uniquement) ;
    - crée la tâche planifiée « UniTimetable Serveur » (démarrage automatique au boot, compte SYSTEM).
  Usage :  powershell -ExecutionPolicy Bypass -File windows\install-server.ps1 [-NoFirewall] [-NoTask] [-RemoteAddress 192.168.1.0/24]
#>
param([switch]$NoFirewall, [switch]$NoTask, [string]$RemoteAddress = 'LocalSubnet')
. "$PSScriptRoot\common.ps1"
Assert-Admin
Write-Host "=== Installation du serveur UniTimetable ===" -ForegroundColor Cyan
Write-Host "Dossier : $ServerDir"
# 1. Node.js
$node = Get-NodeExe
if (-not $node) { Write-Host 'Node.js est introuvable. Installez « Node.js LTS » (22.x) depuis https://nodejs.org puis relancez ce script.' -ForegroundColor Red; exit 1 }
$ver = (& $node -v).Trim(); $major = [int]($ver.TrimStart('v').Split('.')[0])
Write-Host "[OK] Node.js $ver ($node)"
if ($major -lt 18) { Write-Host 'Node.js 18 minimum est requis (22 LTS recommandé).' -ForegroundColor Red; exit 1 }
if ($major -lt 22) { Write-Host '  Conseil : Node.js 22 LTS est recommandé (fuseaux horaires du Maroc à jour).' -ForegroundColor Yellow }
# 2. configuration
$envFile = Join-Path $ServerDir 'server.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $ServerDir 'server.env.exemple') $envFile; Write-Host '[OK] server.env créé (à adapter si besoin : port, dossier de sauvegarde…)' } else { Write-Host '[OK] server.env existant conservé' }
$cfg = Read-ServerEnv; $port = [int]$cfg['PORT']
# 3. bibliothèques locales
Push-Location $ServerDir
& $node tools\fetch-vendor.js
if ($LASTEXITCODE -ne 0) { Write-Host '  Bibliothèques incomplètes : relancez windows\fetch-vendor.ps1 quand Internet est disponible (voir README).' -ForegroundColor Yellow }
Pop-Location
# 4. dossiers et droits
foreach ($k in 'DATA_DIR', 'LOG_DIR', 'BACKUP_DIR') { New-Item -ItemType Directory -Force -Path $cfg[$k] | Out-Null }
foreach ($k in 'DATA_DIR', 'BACKUP_DIR', 'LOG_DIR') {
    # SYSTEM (S-1-5-18) et Administrateurs (S-1-5-32-544) uniquement, héritage coupé.
    & icacls $cfg[$k] /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    Write-Host "[OK] Accès restreint (SYSTEM + Administrateurs) : $($cfg[$k])"
}
if (Test-Path $envFile) { & icacls $envFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null }
# 5. pare-feu
if (-not $NoFirewall) { & "$PSScriptRoot\configure-firewall.ps1" -RemoteAddress $RemoteAddress }
# 6. tâche planifiée
if (-not $NoTask) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'run-server.ps1') + '"') -WorkingDirectory $ServerDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Serveur central UniTimetable (réseau local)' -Force | Out-Null
    Write-Host "[OK] Tâche planifiée « $TaskName » créée (démarrage automatique, compte SYSTEM)"
}
Write-Host ''
Write-Host 'Étapes suivantes :' -ForegroundColor Cyan
Write-Host '  1. Créer le premier administrateur :  powershell -ExecutionPolicy Bypass -File windows\create-admin.ps1'
Write-Host '  2. Démarrer le serveur :              powershell -ExecutionPolicy Bypass -File windows\start-server.ps1'
Write-Host '  3. Vérifier :                         powershell -ExecutionPolicy Bypass -File windows\status-server.ps1'
