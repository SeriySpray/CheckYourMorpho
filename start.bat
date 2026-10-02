@echo off
setlocal enabledelayedexpansion
title CheckYourMorpho Platform

:: Always run in script directory regardless of how it was launched
cd /d "%~dp0"

:: Resolve PowerShell path reliably across any Windows configuration
set "PS_CMD=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_CMD%" set "PS_CMD=powershell.exe"

:: 1. Check if local portable Node.js is already installed in .node
if exist "%~dp0.node\node.exe" (
    set "NODE_CMD=%~dp0.node\node.exe"
    set "PATH=%~dp0.node;%PATH%"
    goto :LAUNCH
)

:: 2. Check if compatible Node.js is present in system PATH (requires v22+ for native node:sqlite)
set "SYS_NODE_OK=0"
where node >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_FULL_VER=%%v"
    if defined NODE_FULL_VER (
        set "NODE_MAJOR=!NODE_FULL_VER:~1!"
        if !NODE_MAJOR! geq 22 (
            set "SYS_NODE_OK=1"
            set "NODE_CMD=node"
        ) else (
            echo [CheckYourMorpho] Installed Node.js is !NODE_FULL_VER! (requires v22+ for native node:sqlite).
        )
    )
)

if "%SYS_NODE_OK%"=="1" goto :LAUNCH

:: 3. Automatically download and configure portable Node.js LTS from requirements
echo [CheckYourMorpho] Node.js 22+ not found in system.
echo [CheckYourMorpho] Automatically downloading portable Node.js from requirements...
"%PS_CMD%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_node.ps1"
if %errorlevel% neq 0 (
    echo.
    echo ===============================================================================
    echo [ERROR] Failed to set up portable Node.js automatically.
    echo Please verify your internet connection or install Node.js 22+ LTS manually:
    echo https://nodejs.org
    echo ===============================================================================
    pause
    exit /b 1
)

if exist "%~dp0.node\node.exe" (
    set "NODE_CMD=%~dp0.node\node.exe"
    set "PATH=%~dp0.node;%PATH%"
) else (
    echo [ERROR] Node executable was not found in .node after download.
    pause
    exit /b 1
)

:LAUNCH
echo [CheckYourMorpho] Launching server on http://localhost:3000 ...
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
"%NODE_CMD%" server/index.js
pause
