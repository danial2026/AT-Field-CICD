#!/bin/bash
# =============================================================================
# server-setup-proxy.sh   v1.0.0   —   run ON THE UBUNTU SERVER
# =============================================================================
# Points the server's git, Docker daemon, and the AT-Field CI container at an
# HTTP proxy (typically tinyproxy on your Mac) so they reach the internet
# through the Mac's VPN tunnel. Fixes "git clone hangs forever" on filtered
# ISPs (e.g. TCI / Mokhaberat DPI blocking of github.com).
#
# What it configures:
#   1. git (global http/https proxy)                 — no sudo
#   2. shell no_proxy in ~/.zshrc and ~/.bashrc      — no sudo
#   3. docker-compose.override.yml (container env)  — no sudo
#   4. Docker daemon proxy drop-in + DNS (docker pull/build) — NEEDS SUDO
#
# Requirements:
#   - Run from inside the AT-Field-CICD repo (or its parent layout).
#   - The proxy host must already be reachable (see mac-setup-tinyproxy.sh).
#   - Sudo available for step 4 (it will prompt if passwordless sudo is off).
#
# Safety:
#   - Strict mode (set -euo pipefail), OS guard, lock file, backups, atomic
#     writes, pre-flight reachability check, post-flight verification, and
#     rollback on failure for the git/compose steps.
#
# Usage:
#   cd /path/to/your/repo
#   bash scripts/proxy/server-setup-proxy.sh
#
#   PROXY_HOST=<your-mac-ip> PROXY_PORT=8888 bash scripts/proxy/server-setup-proxy.sh
#   DOCKER_DNS=8.8.8.8,1.1.1.1 bash scripts/proxy/server-setup-proxy.sh   # override DNS
#   DRY_RUN=1 bash scripts/proxy/server-setup-proxy.sh        # show actions only
#   FORCE=1  bash scripts/proxy/server-setup-proxy.sh         # skip pre-flight
#   bash scripts/proxy/server-setup-proxy.sh --help
#
# Undo:
#   bash scripts/proxy/server-remove-proxy.sh
# =============================================================================
set -euo pipefail

cat <<'BANNER'

   ▄▄▄▄
 ▄█▀▀▀▀█
 ██▄        ▄████▄    ██▄████  ██▄  ▄██   ▄████▄    ██▄████
  ▀████▄   ██▄▄▄▄██   ██▀       ██  ██   ██▄▄▄▄██   ██▀
      ▀██  ██▀▀▀▀▀▀   ██        ▀█▄▄█▀   ██▀▀▀▀▀▀   ██
 █▄▄▄▄▄█▀  ▀██▄▄▄▄█   ██         ████    ▀██▄▄▄▄█   ██
  ▀▀▀▀▀      ▀▀▀▀▀    ▀▀          ▀▀       ▀▀▀▀▀    ▀▀


BANNER

readonly SCRIPT_VERSION="1.0.0"
readonly LOCK="/tmp/at-field-server-proxy-setup.lock"
readonly MARKER="# AT-Field CI: LAN proxy bypass (added by server-setup-proxy.sh)"

PROXY_HOST="${PROXY_HOST:-}"
PROXY_PORT="${PROXY_PORT:-8888}"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"
TEST_GIT_REPO="${TEST_GIT_REPO:-https://github.com/octocat/Hello-World.git}"
DOCKER_DNS="${DOCKER_DNS:-8.8.8.8,1.1.1.1}"

# ---------- helpers ----------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
info() { log "  INFO  $*"; }
warn() { log "  WARN  $*"; }
err()  { log "  ERROR $*" >&2; }
run()  { if [ "$DRY_RUN" = "1" ]; then log "  DRY   $*"; else eval "$@"; fi; }

# Rollback state
ROLLBACK_GIT=0
ROLLBACK_COMPOSE=0
rollback() {
  local rc=$?
  rm -f "$LOCK"
  if [ $rc -ne 0 ]; then
    if [ "$ROLLBACK_GIT" = "1" ] || [ "$ROLLBACK_COMPOSE" = "1" ]; then
      err "Failed (exit $rc). Rolling back git + compose changes..."
      [ "$ROLLBACK_GIT" = "1" ] && [ "$DRY_RUN" = "0" ] && {
        git config --global --unset http.proxy 2>/dev/null || true
        git config --global --unset https.proxy 2>/dev/null || true
        err "  unset git proxy"
      }
      [ "$ROLLBACK_COMPOSE" = "1" ] && [ "$DRY_RUN" = "0" ] && [ -n "${COMPOSE_BAK:-}" ] && {
        if [ -f "$COMPOSE_BAK" ]; then mv "$COMPOSE_BAK" "$COMPOSE_FILE"; else rm -f "$COMPOSE_FILE"; fi
        err "  restored docker-compose.override.yml"
      }
      err "Rolled back. Docker daemon drop-in was NOT touched (step 4 runs last)."
    fi
  fi
  exit $rc
}
trap rollback EXIT

# ---------- arg parsing ------------------------------------------------------
case "${1:-}" in
  -h|--help)
    sed -n '2,40p' "$0"; exit 0 ;;
  -v|--version)
    echo "server-setup-proxy.sh v$SCRIPT_VERSION"; exit 0 ;;
esac

# ---------- guards -----------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  err "This script must run on Linux (got $(uname -s))."
  err "For the Mac, use mac-setup-tinyproxy.sh instead."
  exit 2
fi

command -v git >/dev/null 2>&1 || { err "git not found."; exit 4; }
command -v curl >/dev/null 2>&1 || { err "curl not found."; exit 4; }

# Validate port
case "$PROXY_PORT" in
  ''|*[!0-9]*) err "PROXY_PORT must be numeric (got '$PROXY_PORT')"; exit 5 ;;
esac
[ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ] || { err "PROXY_PORT out of range: $PROXY_PORT"; exit 5; }

# Validate host (basic) — prompt if not set
if [ -z "${PROXY_HOST:-}" ]; then
  if [ -t 0 ]; then
    printf 'Enter your Mac LAN IP (PROXY_HOST): '
    read -r PROXY_HOST
  fi
fi
case "$PROXY_HOST" in
  ''|*[[:space:]]*) err "PROXY_HOST is required. Set via env or run interactively."; exit 5 ;;
esac
info "Proxy host: $PROXY_HOST"

PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
_LAN_PREFIX="$(echo "$PROXY_HOST" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
if [ -n "${_LAN_PREFIX:-}" ]; then
  NO_PROXY_VAL="${NO_PROXY_VAL:-localhost,127.0.0.1,${_LAN_PREFIX}.0/24}"
else
  NO_PROXY_VAL="${NO_PROXY_VAL:-localhost,127.0.0.1}"
fi

# Resolve repo dir (supports running from repo root or scripts/proxy/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../../docker-compose.yml" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  REPO_DIR="$SCRIPT_DIR"
else
  err "Cannot locate docker-compose.yml. Run from the repo root or scripts/proxy/."
  exit 6
fi
COMPOSE_FILE="$REPO_DIR/docker-compose.override.yml"

# Lock
if [ -f "$LOCK" ]; then
  err "Another run is in progress ($LOCK). Remove if stale: rm -f $LOCK"
  exit 3
fi
echo $$ > "$LOCK"

info "server-setup-proxy.sh v$SCRIPT_VERSION"
info "Proxy target : $PROXY_URL"
info "Repo dir     : $REPO_DIR"
[ "$DRY_RUN" = "1" ] && warn "DRY RUN mode — no changes will be made."

# ---------- pre-flight: is the proxy reachable? ------------------------------
if [ "$FORCE" != "1" ]; then
  info "Pre-flight: testing reachability to $PROXY_URL ..."
  if curl -s --max-time 12 -x "$PROXY_URL" -o /dev/null -w '' https://github.com 2>/dev/null; then
    info "OK: proxy reachable and can reach github.com."
  else
    err "Cannot reach $PROXY_URL (or it cannot reach github.com)."
    err "Start the Mac proxy first: bash scripts/proxy/mac-setup-tinyproxy.sh"
    err "Override with FORCE=1 bash scripts/proxy/server-setup-proxy.sh"
    exit 7
  fi
else
  warn "FORCE=1 — skipping pre-flight reachability check."
fi

# ---------- 1) git (global, no sudo) -----------------------------------------
info "[1/4] Configuring git to use the proxy..."
run "git config --global http.proxy  '$PROXY_URL'"
run "git config --global https.proxy '$PROXY_URL'"
run "git config --global http.version HTTP/1.1"
[ "$DRY_RUN" = "0" ] && ROLLBACK_GIT=1
info "    done: git http.proxy / https.proxy set"

# ---------- 2) shell no_proxy (no sudo) --------------------------------------
info "[2/4] Adding no_proxy to shell rc files..."
for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ "$DRY_RUN" = "0" ]; then
    touch "$RC"
    if ! grep -qF "$MARKER" "$RC"; then
      {
        printf '\n%s\nexport no_proxy=%s\nexport NO_PROXY=%s\n' "$MARKER" "$NO_PROXY_VAL" "$NO_PROXY_VAL"
      } >> "$RC"
      info "    added to $RC"
    else
      info "    already present in $RC (idempotent)"
    fi
  else
    log "  DRY   would add no_proxy to $RC"
  fi
done

# ---------- 3) docker-compose.override.yml (atomic, backup) -----------------
info "[3/4] Writing docker-compose.override.yml (container proxy env)..."
if [ "$DRY_RUN" = "0" ]; then
  if [ -f "$COMPOSE_FILE" ]; then
    COMPOSE_BAK="$COMPOSE_FILE.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$COMPOSE_FILE" "$COMPOSE_BAK"
    info "    backed up existing override -> $COMPOSE_BAK"
  fi
  ROLLBACK_COMPOSE=1
fi
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Local-only: route container traffic through the LAN proxy.
# Auto-merged by docker-compose; NOT tracked by git.
# Generated by server-setup-proxy.sh v$SCRIPT_VERSION on $(date -u +%Y-%m-%dT%H:%M:%SZ)
services:
  at-field-ci:
    environment:
      - HTTP_PROXY=$PROXY_URL
      - HTTPS_PROXY=$PROXY_URL
      - http_proxy=$PROXY_URL
      - https_proxy=$PROXY_URL
      - NO_PROXY=$NO_PROXY_VAL
      - no_proxy=$NO_PROXY_VAL
EOF
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   would write $COMPOSE_FILE"
  rm -f "$TMP"
else
  mv "$TMP" "$COMPOSE_FILE"
  info "    written: $COMPOSE_FILE"
fi

# Validate the merged compose config if docker-compose is present
if command -v docker-compose >/dev/null 2>&1 && [ "$DRY_RUN" = "0" ]; then
  info "    validating merged compose config..."
  ( cd "$REPO_DIR" && docker-compose config >/dev/null 2>&1 ) \
    && info "    OK: compose config valid" \
    || warn "    compose config check failed (non-fatal; check syntax)"
fi

# ---------- 4) Docker daemon proxy (NEEDS SUDO) ------------------------------
info "[4/4] Configuring Docker daemon proxy (needs sudo)..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   would write /etc/systemd/system/docker.service.d/http-proxy.conf + restart docker"
else
  if sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
  else
    SUDO="sudo"
    info "    (sudo will prompt for your password)"
  fi

  DAEMON_DIR="/etc/systemd/system/docker.service.d"
  DAEMON_CONF="$DAEMON_DIR/http-proxy.conf"

  # Backup existing drop-in if present
  if $SUDO test -f "$DAEMON_CONF"; then
    $SUDO cp -a "$DAEMON_CONF" "$DAEMON_CONF.bak.$(date +%Y%m%d%H%M%S)"
    info "    backed up existing drop-in"
  fi

  $SUDO mkdir -p "$DAEMON_DIR"
  $SUDO tee "$DAEMON_CONF" >/dev/null <<EOF
# AT-Field CI: Docker daemon proxy through the LAN proxy
# Generated by server-setup-proxy.sh v$SCRIPT_VERSION on $(date -u +%Y-%m-%dT%H:%M:%SZ)
[Service]
Environment="HTTP_PROXY=$PROXY_URL"
Environment="HTTPS_PROXY=$PROXY_URL"
Environment="NO_PROXY=$NO_PROXY_VAL"
EOF
  info "    written: $DAEMON_CONF"

  # Also configure Docker DNS in daemon.json so build containers can resolve
  # hostnames (DNS is also filtered by some ISPs; proxy only handles HTTP).
  info "    configuring Docker DNS: $DOCKER_DNS"
  DAEMON_JSON="/etc/docker/daemon.json"
  DNS_JSON_TMP="$(mktemp)"
  if $SUDO test -f "$DAEMON_JSON"; then
    $SUDO cp -a "$DAEMON_JSON" "$DAEMON_JSON.bak.$(date +%Y%m%d%H%M%S)"
    info "    backed up existing $DAEMON_JSON"
  fi
  # Merge dns into daemon.json using python3 (available on Ubuntu by default)
  $SUDO python3 <<PYEOF
import json, os
dns = '${DOCKER_DNS}'.split(',')
cfg = {}
cfg_path = '${DAEMON_JSON}'
if os.path.exists(cfg_path):
    try:
        with open(cfg_path) as f: cfg = json.load(f)
    except (json.JSONDecodeError, ValueError):
        pass
cfg['dns'] = dns
with open('${DNS_JSON_TMP}', 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
  $SUDO mv "$DNS_JSON_TMP" "$DAEMON_JSON"
  info "    written: $DAEMON_JSON"

  info "    reloading systemd + restarting docker..."
  $SUDO systemctl daemon-reload
  if $SUDO systemctl restart docker; then
    info "    OK: docker restarted"
  else
    err "    docker failed to restart. Check: journalctl -u docker -n 50"
    err "    Recover: sudo rm -f $DAEMON_CONF && sudo systemctl daemon-reload && sudo systemctl restart docker"
    exit 8
  fi
fi

# ---------- post-flight ------------------------------------------------------
info "Post-flight: verifying configuration..."
if [ "$DRY_RUN" = "0" ]; then
  GIT_PROXY="$(git config --global --get http.proxy 2>/dev/null || echo '(unset)')"
  info "  git http.proxy = $GIT_PROXY"
  if [ "${SUDO:-}" != "" ]; then
    DOCKER_ENV="$($SUDO systemctl show docker -p Environment 2>/dev/null | tr ' ' '\n' | grep -o 'HTTPS_PROXY=[^ ]*' || echo 'set')"
    info "  docker HTTPS_PROXY = $DOCKER_ENV"
    DOCKER_DNS_CHECK="$($SUDO python3 -c "import json; d=json.load(open('/etc/docker/daemon.json')); print(','.join(d.get('dns',[])))" 2>/dev/null || echo 'unset')"
    info "  docker DNS = $DOCKER_DNS_CHECK"
  fi
  # Functional test: git through proxy
  info "  functional test: git ls-remote via proxy..."
  if timeout 30 git ls-remote "$TEST_GIT_REPO" HEAD >/dev/null 2>&1; then
    info "  OK: git can reach github via proxy."
  else
    warn "  git ls-remote failed (proxy may be down; config is still applied)."
  fi
fi

# ---------- summary ----------------------------------------------------------
cat <<EOF

============================================================
 DONE.  server-setup-proxy.sh v$SCRIPT_VERSION
============================================================
 Configured: git, shell env, docker-compose override, docker daemon
$( [ "$DRY_RUN" = "1" ] && echo " (DRY RUN — nothing was actually changed)" )
 Next:
   cp .env.example .env        # set ADMIN_USER / ADMIN_PASSWORD
    docker-compose up -d --build
    docker exec at-field-ci git ls-remote "$TEST_GIT_REPO" HEAD

 Undo: bash scripts/proxy/server-remove-proxy.sh
EOF
