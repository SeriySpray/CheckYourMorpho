#!/bin/bash
# Deploy CheckYourMorpho to Oracle Cloud VPS

SERVER_IP="${SERVER_IP:-141.144.254.60}"
SSH_KEY="${SSH_KEY:-$HOME/Downloads/ssh-key-2026-07-11.key}"
REMOTE_USER="ubuntu"
REMOTE_DIR="/home/ubuntu/CheckYourMorpho"
DOMAIN="checkyourmorpho.duckdns.org"

if [ ! -f "$SSH_KEY" ]; then
  SSH_KEY="/home/user/ssh-key-2026-07-11.key"
fi

echo "==============================================================================="
echo "Deploying CheckYourMorpho to Oracle Cloud VPS ($SERVER_IP)"
echo "Domain: $DOMAIN"
echo "==============================================================================="

echo "[1/5] Creating remote directories..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no $REMOTE_USER@$SERVER_IP "mkdir -p $REMOTE_DIR/server $REMOTE_DIR/client $REMOTE_DIR/data"

echo "[2/5] Uploading project files..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no package.json $REMOTE_USER@$SERVER_IP:$REMOTE_DIR/
scp -r -i "$SSH_KEY" -o StrictHostKeyChecking=no server $REMOTE_USER@$SERVER_IP:$REMOTE_DIR/
scp -r -i "$SSH_KEY" -o StrictHostKeyChecking=no client $REMOTE_USER@$SERVER_IP:$REMOTE_DIR/
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no data/morpho.db $REMOTE_USER@$SERVER_IP:$REMOTE_DIR/data/morpho.db

echo "[3/5] Configuring systemd service..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no $REMOTE_USER@$SERVER_IP "sudo tee /etc/systemd/system/checkyourmorpho.service > /dev/null << 'EOF'
[Unit]
Description=CheckYourMorpho MetaMorpho Risk Terminal
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/CheckYourMorpho
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable checkyourmorpho
sudo systemctl restart checkyourmorpho
"

echo "[4/5] Configuring Nginx reverse proxy..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no $REMOTE_USER@$SERVER_IP "sudo tee /etc/nginx/sites-available/checkyourmorpho > /dev/null << 'EOF'
server {
    listen 80;
    server_name checkyourmorpho.duckdns.org;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/checkyourmorpho /etc/nginx/sites-enabled/checkyourmorpho
sudo nginx -t && sudo systemctl reload nginx
"

echo "[5/5] Verifying service status..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no $REMOTE_USER@$SERVER_IP "sudo systemctl status checkyourmorpho --no-pager; curl -s http://127.0.0.1:3000/api/status"

echo ""
echo "==============================================================================="
echo "Deployment finished!"
echo "Web access: http://checkyourmorpho.duckdns.org"
echo "==============================================================================="
