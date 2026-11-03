@echo off
rem Lance le serveur dans cette fenêtre (test ou depannage). Ctrl+C pour l'arrêter.
cd /d "%~dp0.."
where node >nul 2>&1 || (echo Node.js est introuvable. Installez Node.js LTS depuis https://nodejs.org & pause & exit /b 1)
node server.js
pause
