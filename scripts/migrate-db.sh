#!/bin/bash
set -euo pipefail
echo "==> Running DB migrations"
psql "$DATABASE_URL" -f /srv/migrations/$(cat /srv/migrations/latest) 
echo "==> VACUUM ANALYZE"
psql "$DATABASE_URL" -c "VACUUM ANALYZE;"
echo "==> Migrations complete"
