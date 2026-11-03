# Sauvegarde immédiate (le serveur peut rester démarré). Option : -Dest D:\Sauvegardes\UniTimetable (disque externe / NAS)
param([string]$Dest)
. "$PSScriptRoot\common.ps1"
Push-Location $ServerDir; if ($Dest) { & (Get-NodeExe) tools\backup.js --dest $Dest } else { & (Get-NodeExe) tools\backup.js }; Pop-Location
