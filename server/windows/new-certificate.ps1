<#
  HTTPS en réseau local : crée un certificat auto-signé pour l'adresse IP (et le nom) du serveur.
  À lancer EN TANT QU'ADMINISTRATEUR sur le PC serveur.
  Produit :  certs\unitimetable.pfx  (clé privée, reste sur le serveur, protégé par un mot de passe)
             certs\unitimetable.cer  (certificat public, à installer sur chaque poste client avec trust-certificate.ps1)
  Puis ajoute TLS_PFX / TLS_PFX_PASSPHRASE dans server.env.
  Usage : powershell -ExecutionPolicy Bypass -File windows\new-certificate.ps1 -IP 192.168.1.10 [-Name SERVEUR-EDT] [-Years 3]
#>
param([Parameter(Mandatory = $true)][string]$IP, [string]$Name = $env:COMPUTERNAME, [int]$Years = 3)
. "$PSScriptRoot\common.ps1"
Assert-Admin
if (-not ($IP -as [ipaddress])) { Write-Host 'Adresse IP invalide.' -ForegroundColor Red; exit 1 }
$dir = Join-Path $ServerDir 'certs'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$san = "2.5.29.17={text}IPAddress=$IP&DNS=$Name&DNS=localhost&IPAddress=127.0.0.1"
$cert = New-SelfSignedCertificate -Subject "CN=UniTimetable $Name" -FriendlyName 'UniTimetable (réseau local)' -CertStoreLocation 'Cert:\LocalMachine\My' `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears($Years) `
    -TextExtension @($san, '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={text}CA=false') -KeyUsage DigitalSignature, KeyEncipherment
$bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pass = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x'
$sec = ConvertTo-SecureString $pass -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $dir 'unitimetable.pfx') -Password $sec | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $dir 'unitimetable.cer') | Out-Null
Remove-Item -Path ("Cert:\LocalMachine\My\" + $cert.Thumbprint)   # la clé ne reste que dans le fichier .pfx
& icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
$envFile = Join-Path $ServerDir 'server.env'
$lines = @(); if (Test-Path $envFile) { $lines = Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*(TLS_PFX|TLS_PFX_PASSPHRASE)\s*=' } }
$lines += 'TLS_PFX=certs\unitimetable.pfx'; $lines += "TLS_PFX_PASSPHRASE=$pass"
Set-Content -LiteralPath $envFile -Value $lines -Encoding UTF8
Write-Host "[OK] Certificat créé pour $IP / $Name (empreinte $($cert.Thumbprint), valable $Years ans)." -ForegroundColor Green
Write-Host "     server.env mis à jour (TLS_PFX, TLS_PFX_PASSPHRASE). Fichier protégé : accès SYSTEM + Administrateurs."
Write-Host "     Copiez certs\unitimetable.cer sur chaque poste client et lancez-y windows\trust-certificate.ps1 (en administrateur)."
Write-Host "     Redémarrez le serveur, puis configurez les clients avec https://${IP}:$((Read-ServerEnv)['PORT'])"
& icacls $envFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
