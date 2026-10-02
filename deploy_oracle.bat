@echo off
setlocal enabledelayedexpansion
title Deploy CheckYourMorpho to Oracle Cloud VPS

set SERVER_IP=141.144.254.60
set SSH_KEY=%USERPROFILE%\Downloads\ssh-key-2026-07-11.key
set REMOTE_USER=ubuntu
set REMOTE_DIR=/home/ubuntu/CheckYourMorpho
set DOMAIN=checkyourmorpho.duckdns.org

echo ===============================================================================
echo Deploying CheckYourMorpho to Oracle Cloud VPS (%SERVER_IP%)
echo Domain: %DOMAIN%
echo ===============================================================================
echo.

if not exist "%SSH_KEY%" (
  echo [ERROR] SSH key not found at %SSH_KEY%
  pause
  exit /b 1
)

echo [1/4] Ensuring remote directories exist...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %REMOTE_USER%@%SERVER_IP% "mkdir -p %REMOTE_DIR%/server %REMOTE_DIR%/client %REMOTE_DIR%/data"

echo [2/4] Uploading project files, database, and configurations...
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no package.json %REMOTE_USER%@%SERVER_IP%:%REMOTE_DIR%/
scp -r -i "%SSH_KEY%" -o StrictHostKeyChecking=no server %REMOTE_USER%@%SERVER_IP%:%REMOTE_DIR%/
scp -r -i "%SSH_KEY%" -o StrictHostKeyChecking=no client %REMOTE_USER%@%SERVER_IP%:%REMOTE_DIR%/
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no data/morpho.db %REMOTE_USER%@%SERVER_IP%:%REMOTE_DIR%/data/morpho.db
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=no nginx_checkyourmorpho.conf %REMOTE_USER%@%SERVER_IP%:%REMOTE_DIR%/nginx.conf

echo [3/4] Updating Nginx and restarting systemd service...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %REMOTE_USER%@%SERVER_IP% "sudo cp %REMOTE_DIR%/nginx.conf /etc/nginx/sites-available/checkyourmorpho && sudo ln -sf /etc/nginx/sites-available/checkyourmorpho /etc/nginx/sites-enabled/checkyourmorpho && sudo nginx -t && sudo systemctl reload nginx && sudo systemctl restart checkyourmorpho"

echo [4/4] Verifying service status...
ssh -i "%SSH_KEY%" -o StrictHostKeyChecking=no %REMOTE_USER%@%SERVER_IP% "sudo systemctl status checkyourmorpho --no-pager | head -n 12; curl -s http://127.0.0.1:3000/api/status"

echo.
echo ===============================================================================
echo Deployment finished!
echo Domain: http://%DOMAIN%
echo ===============================================================================
pause
