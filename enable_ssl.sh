#!/bin/bash
set -e
DOMAIN="checkyourmorpho.duckdns.org"

echo "=== Enabling SSL for $DOMAIN ==="
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@duckdns.org" --redirect
sudo nginx -t && sudo systemctl reload nginx
echo "SSL enabled successfully! Access: https://$DOMAIN/"
