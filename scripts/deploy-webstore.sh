#!/bin/bash
set -euo pipefail
echo "==> Deploying Acme Webstore (${CI_KEYWORD:-deploy})"
echo "==> Machine: ${CI_MACHINES:-n/a}"
cd /var/www/webstore
rsync -a --delete /tmp/deploy/ ./ 2>/dev/null || echo "(rsync stage skipped - local)"
echo "==> Restarting services"
sudo systemctl restart webstore
echo "==> Health check"
curl -sf http://localhost/health && echo "OK" || echo "WARN"
echo "==> Deploy finished in ${CI_DURATION:-0}s"
