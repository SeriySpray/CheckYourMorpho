@echo off
setlocal enabledelayedexpansion
title CheckYourMorpho Sync Engine

:: Always run in script directory regardless of how it was launched
cd /d "%~dp0"

:: Resolve PowerShell path reliably across any Windows configuration
set "PS_CMD=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_CMD%" set "PS_CMD=powershell.exe"

:: 1. Check if local portable Node.js is installed in .node
if exist "%~dp0.node\node.exe" (
    set "NODE_CMD=%~dp0.node\node.exe"
    set "PATH=%~dp0.node;%PATH%"
    goto :SYNC
)

:: 2. Check if compatible Node.js is present in system PATH (requires v22+)
set "SYS_NODE_OK=0"
where node >nul 2>nul
if %errorlevel% equ 0 (
    for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_FULL_VER=%%v"
    if defined NODE_FULL_VER (
        set "NODE_MAJOR=!NODE_FULL_VER:~1!"
        if !NODE_MAJOR! geq 22 (
            set "SYS_NODE_OK=1"
            set "NODE_CMD=node"
        )
    )
)

if "%SYS_NODE_OK%"=="1" goto :SYNC

:: 3. Setup Node.js if missing
"%PS_CMD%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_node.ps1"
if exist "%~dp0.node\node.exe" (
    set "NODE_CMD=%~dp0.node\node.exe"
    set "PATH=%~dp0.node;%PATH%"
) else (
    set "NODE_CMD=node"
)

:SYNC
echo [CheckYourMorpho] Running on-chain synchronization with Morpho GraphQL API...
"%NODE_CMD%" server/services/syncEngine.js
pause
