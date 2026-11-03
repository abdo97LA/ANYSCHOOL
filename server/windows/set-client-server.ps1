<#
  Poste CLIENT : fixe l'adresse du serveur pour tous les utilisateurs de ce PC (sans reconstruire l'application).
  Écrit %ProgramData%\UniTimetable\client.json. Un utilisateur peut toujours la remplacer par Fichier > Configurer le serveur.
  Usage (EN TANT QU'ADMINISTRATEUR) : powershell -ExecutionPolicy Bypass -File set-client-server.ps1 -Url http://192.168.1.10:8787
#>
param([Parameter(Mandatory = $true)][string]$Url)
try { $u = [Uri]$Url } catch { Write-Host 'Adresse invalide.' -ForegroundColor Red; exit 1 }
if ($u.Scheme -notin 'http', 'https') { Write-Host 'L''adresse doit commencer par http:// ou https://' -ForegroundColor Red; exit 1 }
try { $h = Invoke-RestMethod -Uri ($u.GetLeftPart('Authority') + '/health') -TimeoutSec 5; Write-Host "[OK] Serveur UniTimetable $($h.version) joignable." -ForegroundColor Green } catch { Write-Host "[!!] Serveur injoignable pour l'instant : $($_.Exception.Message)" -ForegroundColor Yellow }
$d = Join-Path $env:ProgramData 'UniTimetable'; New-Item -ItemType Directory -Force -Path $d | Out-Null
@{ serverUrl = $u.GetLeftPart('Authority') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $d 'client.json') -Encoding UTF8
Write-Host "[OK] Adresse enregistrée dans $d\client.json"
