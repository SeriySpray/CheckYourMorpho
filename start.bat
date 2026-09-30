@echo off
title CheckYourMorpho Platform
echo [CheckYourMorpho] Launching server on http://localhost:3000 ...
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
node server/index.js
pause
