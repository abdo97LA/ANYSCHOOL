# Diagnostic du serveur UniTimetable. Usage : powershell -ExecutionPolicy Bypass -File windows\status-server.ps1
param([switch]$Short)
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
$cfg = Read-ServerEnv; $port = [int]$cfg['PORT']; $proto = if ($cfg['HTTPS']) { 'https' } else { 'http' }
$ok = { param($c, $m) if ($c) { Write-Host "[OK]  $m" -ForegroundColor Green } else { Write-Host "[!!]  $m" -ForegroundColor Yellow } }
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
& $ok ([bool]$t) ("Tâche planifiée : " + $(if ($t) { $t.State } else { 'absente' }))
$p = Get-ServerPid; & $ok ([bool]$p) ("Processus serveur : " + $(if ($p) { "PID $p" } else { 'arrêté' }))
$l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
& $ok ([bool]$l) ("Écoute sur le port $port : " + $(if ($l) { ($l | ForEach-Object { $_.LocalAddress }) -join ', ' } else { 'non' }))
try {
    $h = Invoke-RestMethod -Uri "${proto}://localhost:$port/health" -TimeoutSec 5
    & $ok $true ("/health : version $($h.version), révision des données $($h.stateRev), comptes : " + $(if ($h.users) { 'oui' } else { 'AUCUN (lancez create-admin)' }))
    if ($h.vendorMissing -and $h.vendorMissing.Count) { & $ok $false ('Bibliothèques absentes : ' + ($h.vendorMissing -join ', ') + ' (windows\fetch-vendor.ps1)') }
} catch { & $ok $false "/health ne répond pas sur ${proto}://localhost:$port ($($_.Exception.Message))" }
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
foreach ($i in $ips) { Write-Host "      Adresse pour les postes : ${proto}://$($i.IPAddress):$port   ($($i.InterfaceAlias), $($i.PrefixOrigin))" }
if ($Short) { exit 0 }
$fw = Get-NetFirewallRule -DisplayName 'UniTimetable Serveur*' -ErrorAction SilentlyContinue
& $ok ([bool]$fw) ("Règle pare-feu : " + $(if ($fw) { ($fw | ForEach-Object { $_.DisplayName + ' / profil ' + $_.Profile + ' / ' + $(if ($_.Enabled -eq 'True') { 'activée' } else { 'DÉSACTIVÉE' }) }) -join '; ' } else { 'absente (windows\configure-firewall.ps1)' }))
foreach ($c in Get-NetConnectionProfile) { & $ok ($c.NetworkCategory -ne 'Public') ("Réseau « $($c.Name) » ($($c.InterfaceAlias)) : profil $($c.NetworkCategory)") }
foreach ($i in $ips) { if ($i.PrefixOrigin -eq 'Dhcp') { Write-Host "      Conseil : $($i.IPAddress) est attribuée par DHCP : créez une réservation DHCP sur le routeur pour qu'elle ne change pas." -ForegroundColor Yellow } }
& $ok ($cfg['HTTPS']) ('Chiffrement : ' + $(if ($cfg['HTTPS']) { 'HTTPS' } else { 'HTTP non chiffré (voir README, section HTTPS)' }))
$bk = Get-ChildItem -LiteralPath $cfg['BACKUP_DIR'] -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
& $ok ([bool]$bk) ('Dernière sauvegarde : ' + $(if ($bk) { $bk.Name + ' dans ' + $cfg['BACKUP_DIR'] } else { 'aucune' }))
$lf = Get-ChildItem -LiteralPath $cfg['LOG_DIR'] -Filter 'server-*.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($lf) { Write-Host "      Dernières lignes de $($lf.FullName) :"; Get-Content -LiteralPath $lf.FullName -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "        $_" } }
$sv = Join-Path $cfg['LOG_DIR'] 'superviseur.log'; if (Test-Path $sv) { Write-Host '      Superviseur :'; Get-Content -LiteralPath $sv -Tail 4 -Encoding UTF8 | ForEach-Object { Write-Host "        $_" } }
