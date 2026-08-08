#!/bin/bash
set -e

KNOWN_HOSTS="/app/ssh/known_hosts"

if [ ! -s "$KNOWN_HOSTS" ]; then
    echo "[entrypoint] Seeding SSH known_hosts..."
    ssh-keyscan github.com    > "$KNOWN_HOSTS" 2>/dev/null || true
    ssh-keyscan gitlab.com    >> "$KNOWN_HOSTS" 2>/dev/null || true
    ssh-keyscan bitbucket.org >> "$KNOWN_HOSTS" 2>/dev/null || true
    echo "[entrypoint] Done."
fi

exec "$@"
