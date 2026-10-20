@echo off
setlocal
title CheckYourMorpho AI research
cd /d "%~dp0"

:: agy lives in %LOCALAPPDATA%\agy\bin; portable Node.js (if any) goes first
set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
if exist "%~dp0.node\node.exe" set "PATH=%~dp0.node;%PATH%"

if not exist logs mkdir logs
node scripts\research.mjs --api https://checkyourmorpho.duckdns.org --limit 40 %* >> logs\research.log 2>&1
exit /b %errorlevel%
