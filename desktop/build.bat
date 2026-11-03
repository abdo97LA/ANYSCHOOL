@echo off
setlocal
rem UniTimetable - compilation du client Windows (installateur + version portable)
rem A lancer depuis le dossier UniTimetable-Desktop. Prerequis : Node.js LTS (https://nodejs.org).
cd /d "%~dp0"
echo === Compilation du client UniTimetable ===
where node >nul 2>&1 || (echo [ERREUR] Node.js introuvable. Installez Node.js LTS puis relancez. & pause & exit /b 1)
for /f %%v in ('node -v') do echo Node.js %%v
if not exist "node_modules\electron" (
  echo [1/3] Installation des dependances npm (Internet necessaire une seule fois)...
  call npm install || (echo [ERREUR] npm install a echoue. & pause & exit /b 1)
) else (
  echo [1/3] Dependances deja installees.
)
echo [2/3] Copie du serveur (code uniquement, sans donnees) dans server-bundle...
call node scripts\copy-server.js || (echo [ERREUR] Copie du serveur impossible. & pause & exit /b 1)
echo [3/3] Construction (installateur NSIS + version portable)...
call npx electron-builder --win nsis portable --x64
if errorlevel 1 (
  echo.
  echo [ERREUR] La compilation a echoue.
  echo  - Message "Cannot create symbolic link" : activez le Mode developpeur de Windows
  echo    (Parametres ^> Systeme ^> Pour les developpeurs) ou lancez cette fenetre en administrateur, puis relancez.
  pause & exit /b 1
)
echo.
echo === Termine. Fichiers generes : ===
dir /b "dist\releases\*.exe"
echo Installateur : dist\releases\UniTimetable-Setup.exe
pause
