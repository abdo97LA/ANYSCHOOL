<#
  Règle du pare-feu Windows Defender pour UniTimetable (à lancer EN TANT QU'ADMINISTRATEUR).
  Autorise uniquement : TCP entrant sur le port du serveur, profil réseau « Privé », depuis le sous-réseau local.
  Usage : powershell -ExecutionPolicy Bypass -File windows\configure-firewall.ps1 [-RemoteAddress 192.168.1.0/24] [-Remove]
#>
param([string]$RemoteAddress = 'LocalSubnet', [switch]$Remove)
. "$PSScriptRoot\common.ps1"
Assert-Admin
$cfg = Read-ServerEnv; $port = [int]$cfg['PORT']; $name = 'UniTimetable Serveur (TCP ' + $port + ')'
Get-NetFirewallRule -DisplayName 'UniTimetable Serveur*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Host '[OK] Règle(s) UniTimetable supprimée(s).'; exit 0 }
$node = Get-NodeExe
New-NetFirewallRule -DisplayName $name -Description 'Accès des postes du réseau local au serveur UniTimetable' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -RemoteAddress $RemoteAddress -Program $node | Out-Null
Write-Host "[OK] Pare-feu : entrée TCP $port autorisée (profil Privé, origine : $RemoteAddress, programme : $node)"
$pub = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
foreach ($p in $pub) {
    Write-Host "  ATTENTION : la connexion « $($p.Name) » ($($p.InterfaceAlias)) est en profil PUBLIC : la règle ne s'y applique pas." -ForegroundColor Yellow
    $r = Read-Host '  Passer cette connexion en profil Privé (réseau de l''établissement de confiance) ? (O/N)'
    if ($r -match '^[oOyY]') { Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private; Write-Host '  [OK] Profil Privé appliqué.' }
}
Write-Host '  Rappel : ne créez AUCUNE redirection de port (NAT/port forwarding) vers ce PC sur le routeur ou la box Internet.'
