# Fonctions communes aux scripts Windows de UniTimetable (chargé par les autres scripts).
$ErrorActionPreference = 'Stop'
$Script:ServerDir = Split-Path -Parent $PSScriptRoot
$Script:TaskName  = 'UniTimetable Serveur'
function Read-ServerEnv {
    $cfg = @{ HOST = '0.0.0.0'; PORT = '8787'; DATA_DIR = 'data' }
    $f = Join-Path $ServerDir 'server.env'
    if (Test-Path $f) {
        foreach ($l in Get-Content -LiteralPath $f -Encoding UTF8) {
            $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
            $i = $t.IndexOf('='); if ($i -lt 1) { continue }
            $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
        }
    }
    foreach ($k in 'DATA_DIR', 'LOG_DIR', 'BACKUP_DIR') { if ($cfg[$k] -and -not [IO.Path]::IsPathRooted($cfg[$k])) { $cfg[$k] = [IO.Path]::GetFullPath((Join-Path $ServerDir $cfg[$k])) } }
    if (-not $cfg['LOG_DIR']) { $cfg['LOG_DIR'] = Join-Path (Split-Path -Parent $cfg['DATA_DIR']) 'logs' }
    if (-not $cfg['BACKUP_DIR']) { $cfg['BACKUP_DIR'] = Join-Path $cfg['DATA_DIR'] 'backups' }
    $cfg['HTTPS'] = [bool]($cfg['TLS_PFX'] -or ($cfg['TLS_CERT'] -and $cfg['TLS_KEY']))
    return $cfg
}
function Get-NodeExe {
    $n = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $n) { foreach ($p in "$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe") { if (Test-Path $p) { return $p } } ; return $null }
    return $n.Source
}
function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'Ce script doit être lancé « en tant qu''administrateur » (clic droit sur PowerShell > Exécuter en tant qu''administrateur).' -ForegroundColor Red
        exit 1
    }
}
function Get-ServerPid {
    $c = Read-ServerEnv; $lock = Join-Path $c['DATA_DIR'] 'server.lock'
    if (Test-Path $lock) { $p = [int](Get-Content $lock -Raw).Trim(); if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p } }
    return $null
}
