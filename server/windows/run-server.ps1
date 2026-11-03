# Superviseur du serveur UniTimetable : lancé par la tâche planifiée au démarrage du PC.
# Redémarre le serveur en cas d'arrêt anormal, avec une politique contrôlée :
#   attente croissante (5 s, 15 s, 30 s, 60 s…) et au plus 10 redémarrages par heure, puis pause de 15 minutes.
# Ne lance jamais deux serveurs : verrou global + fichier data\server.lock vérifié par le serveur lui-même.
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
$mutex = New-Object System.Threading.Mutex($false, 'Global\UniTimetableSupervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }   # un superviseur tourne déjà
$cfg = Read-ServerEnv
New-Item -ItemType Directory -Force -Path $cfg['LOG_DIR'] | Out-Null
$slog = Join-Path $cfg['LOG_DIR'] 'superviseur.log'
function Log($m) { Add-Content -LiteralPath $slog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 }
$node = Get-NodeExe
if (-not $node) { Log 'ERREUR : node.exe introuvable. Installez Node.js LTS.'; exit 1 }
$env:UNITT_QUIET = '1'
$delays = 5, 15, 30, 60, 120; $starts = New-Object System.Collections.ArrayList; $n = 0
Log "Superviseur démarré (node : $node)"
while ($true) {
    $now = Get-Date; [void]$starts.Add($now)
    while ($starts.Count -gt 0 -and ($now - $starts[0]).TotalMinutes -gt 60) { $starts.RemoveAt(0) }
    if ($starts.Count -gt 10) { Log 'Plus de 10 redémarrages en une heure : pause de 15 minutes.'; Start-Sleep -Seconds 900; $starts.Clear() }
    Log 'Lancement du serveur'
    Push-Location $ServerDir
    & $node server.js | Out-Null
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { Log 'Serveur arrêté normalement (code 0) : fin du superviseur.'; break }
    if ($code -eq 3) { Log 'Une autre instance du serveur est déjà active (code 3) : fin du superviseur.'; break }
    if ($code -eq 4 -or $code -eq 5) { Log "ERREUR de configuration ou de données (code $code) : voir logs\server-*.log. Nouvel essai dans 5 minutes."; Start-Sleep -Seconds 300; continue }
    $d = $delays[[Math]::Min($n, $delays.Count - 1)]; $n++
    Log "Arrêt anormal (code $code). Redémarrage dans $d s."
    Start-Sleep -Seconds $d
    if ((Get-Date) - $now -gt [TimeSpan]::FromMinutes(10)) { $n = 0 }
}
$mutex.ReleaseMutex()
