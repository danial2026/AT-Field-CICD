#!/bin/bash
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
echo "==> Dumping production database"
pg_dump --format=custom --file=/backups/acme-$STAMP.dump acme_prod
echo "==> Rotating old backups"
find /backups -name 'acme-*.dump' -mtime +14 -delete
echo "==> Backup complete: acme-$STAMP.dump"
