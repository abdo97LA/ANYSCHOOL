<#
  Poste CLIENT : installe le certificat public du serveur UniTimetable dans les « Autorités de certification racines de confiance »
  de l'ordinateur, pour que l'application (et les navigateurs Chrome/Edge) acceptent la connexion HTTPS au serveur local.
  Seul le certificat de CE serveur est approuvé ; la vérification des certificats n'est jamais désactivée.
  Usage (EN TANT QU'ADMINISTRATEUR) : powershell -ExecutionPolicy Bypass -File trust-certificate.ps1 -Path .\unitimetable.cer
#>
param([Parameter(Mandatory = $true)][string]$Path)
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Lancez ce script en tant qu''administrateur.' -ForegroundColor Red; exit 1 }
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Resolve-Path $Path).Path
Write-Host "Certificat : $($c.Subject)  empreinte SHA1 : $($c.Thumbprint)  valable jusqu'au $($c.NotAfter)"
Write-Host 'Vérifiez que cette empreinte est identique à celle affichée sur le PC serveur.' -ForegroundColor Yellow
$r = Read-Host 'Installer ce certificat comme certificat de confiance sur ce poste ? (O/N)'
if ($r -notmatch '^[oOyY]') { exit 0 }
Import-Certificate -FilePath (Resolve-Path $Path).Path -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Write-Host '[OK] Certificat installé. Redémarrez l''application UniTimetable.' -ForegroundColor Green
