# Poste CLIENT : vérifie qu'il atteint le serveur. Usage : powershell -ExecutionPolicy Bypass -File test-connexion-client.ps1 -IP 192.168.1.10 [-Port 8787] [-Https]
param([Parameter(Mandatory = $true)][string]$IP, [int]$Port = 8787, [switch]$Https)
$r = Test-NetConnection -ComputerName $IP -Port $Port -WarningAction SilentlyContinue
if ($r.TcpTestSucceeded) { Write-Host "[OK] Port $Port ouvert sur $IP" -ForegroundColor Green } else { Write-Host "[!!] Port $Port injoignable sur $IP (serveur arrêté, pare-feu, mauvais réseau ?)" -ForegroundColor Red; exit 1 }
$p = if ($Https) { 'https' } else { 'http' }
try { $h = Invoke-RestMethod -Uri "${p}://${IP}:$Port/health" -TimeoutSec 5; Write-Host "[OK] UniTimetable $($h.version) répond (HTTPS : $($h.https))." -ForegroundColor Green } catch { Write-Host "[!!] $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
