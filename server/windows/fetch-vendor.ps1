# Télécharge une fois les bibliothèques Excel/PDF dans public\vendor (Internet nécessaire uniquement pendant cette commande).
. "$PSScriptRoot\common.ps1"
Push-Location $ServerDir; & (Get-NodeExe) tools\fetch-vendor.js; Pop-Location
