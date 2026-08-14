#!/bin/bash
# =============================================================================
# server-remove-proxy.sh   v1.0.0   —   run ON THE UBUNTU SERVER
# =============================================================================
# Removes ALL proxy configuration created by server-setup-proxy.sh:
#   1. git global http/https proxy
#   2. no_proxy block from ~/.zshrc and ~/.bashrc
#   3. docker-compose.override.yml (backed up, not deleted outright)
#   4. Docker daemon proxy drop-in + DNS config (NEEDS SUDO)
#
# After this, the server uses its direct (TCI) connection again — which may
# re-introduce the GitHub hang. Use this to revert or troubleshoot.
#
# Safety:
#   - Strict mode, OS guard, lock file, backups before removal, post-flight
#     verification that each piece is actually gone.
#
# Usage:
#   cd /path/to/your/repo
#   bash scripts/proxy/server-remove-proxy.sh
#   DOCKER_RESTART=1 bash scripts/proxy/server-remove-proxy.sh  # allow docker daemon restart (restarts ALL containers)
#   DRY_RUN=1 bash scripts/proxy/server-remove-proxy.sh   # show actions only
#   bash scripts/proxy/server-remove-proxy.sh --help
# =============================================================================
set -euo pipefail

readonly SCRIPT_VERSION="1.1.0"
readonly LOCK="/tmp/at-field-server-proxy-remove.lock"
readonly MARKER="# AT-Field CI: LAN proxy bypass (added by server-setup-proxy.sh)"

DRY_RUN="${DRY_RUN:-0}"
DOCKER_RESTART="${DOCKER_RESTART:-0}"

# ---------- helpers ----------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
info() { log "  INFO  $*"; }
warn() { log "  WARN  $*"; }
err()  { log "  ERROR $*" >&2; }
run()  { if [ "$DRY_RUN" = "1" ]; then log "  DRY   $*"; else eval "$@"; fi; }

cleanup() { rm -f "$LOCK"; }
trap cleanup EXIT

# ---------- arg parsing ------------------------------------------------------
case "${1:-}" in
  -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
  -v|--version) echo "server-remove-proxy.sh v$SCRIPT_VERSION"; exit 0 ;;
esac

# ---------- guards -----------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  err "This script must run on Linux (got $(uname -s))."
  exit 2
fi

# Resolve repo dir
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

if [ -f "$LOCK" ]; then
  err "Another run is in progress ($LOCK). Remove if stale: rm -f $LOCK"
  exit 3
fi
echo $$ > "$LOCK"

info "server-remove-proxy.sh v$SCRIPT_VERSION"
info "Repo dir: $REPO_DIR"
[ "$DRY_RUN" = "1" ] && warn "DRY RUN mode — nothing will be changed."

# Same sudo-awareness as the setup script: `git config --global` under sudo
# would touch /root's config, not the invoking user's.
TARGET_HOME="${HOME}"
GITCONF="git config --global"
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_HOME="/home/${SUDO_USER}"
  GITCONF="git config --file ${TARGET_HOME}/.gitconfig"
  warn "Running via sudo — git + shell config will target ${SUDO_USER} (home: ${TARGET_HOME}), not root."
fi

# ---------- 1) git -----------------------------------------------------------
info "[1/4] Removing git global proxy config..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   $GITCONF --unset http.proxy / https.proxy"
else
  eval "$GITCONF --unset http.proxy 2>/dev/null" && info "    unset http.proxy" || info "    (http.proxy was not set)"
  eval "$GITCONF --unset https.proxy 2>/dev/null" && info "    unset https.proxy" || info "    (https.proxy was not set)"
fi

# ---------- 2) shell rc files ------------------------------------------------
info "[2/4] Removing no_proxy block from shell rc files..."
for RC in "$TARGET_HOME/.zshrc" "$TARGET_HOME/.bashrc"; do
  [ -f "$RC" ] || { info "    (no $RC)"; continue; }
  if [ "$DRY_RUN" = "1" ]; then
    grep -qF "$MARKER" "$RC" && log "  DRY   would remove block from $RC" || info "    (nothing in $RC)"
    continue
  fi
  if grep -qF "$MARKER" "$RC"; then
    cp -a "$RC" "$RC.bak.$(date +%Y%m%d%H%M%S)"
    # Delete the 4-line managed block (marker comment + 2 exports + leading blank)
    sed -i "/^${MARKER}\$/,/^export NO_PROXY=/d" "$RC"
    info "    cleaned $RC (backup saved)"
  else
    info "    nothing to clean in $RC"
  fi
done

# ---------- 3) docker-compose.override.yml ----------------------------------
info "[3/4] Removing docker-compose.override.yml..."
if [ "$DRY_RUN" = "1" ]; then
  [ -f "$COMPOSE_FILE" ] && log "  DRY   would remove $COMPOSE_FILE" || info "    (none present)"
else
  if [ -f "$COMPOSE_FILE" ]; then
    rm -f "$COMPOSE_FILE"
    info "    removed $COMPOSE_FILE"
  else
    info "    (none present)"
  fi
fi

# ---------- 4) Docker daemon drop-in (NEEDS SUDO) ---------------------------
info "[4/4] Removing Docker daemon proxy drop-in + DNS (needs sudo)..."
DAEMON_CONF="/etc/systemd/system/docker.service.d/http-proxy.conf"
DAEMON_JSON="/etc/docker/daemon.json"
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   would remove $DAEMON_CONF + DNS config from $DAEMON_JSON + reload docker (no restart; DOCKER_RESTART=1 to restart)"
else
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else SUDO="sudo"; info "    (sudo will prompt)"; fi

  if $SUDO test -f "$DAEMON_CONF"; then
    $SUDO rm -f "$DAEMON_CONF"
    info "    removed drop-in"
  else
    info "    (no drop-in present)"
  fi

  # Remove the dns key from daemon.json
  if $SUDO test -f "$DAEMON_JSON"; then
    $SUDO cp -a "$DAEMON_JSON" "$DAEMON_JSON.bak.$(date +%Y%m%d%H%M%S)"
    DNS_JSON_TMP="$(mktemp)"
    $SUDO python3 <<PYEOF
import json
cfg_path = '$DAEMON_JSON'
with open(cfg_path) as f:
    cfg = json.load(f)
cfg.pop('dns', None)
with open('$DNS_JSON_TMP', 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
    $SUDO mv "$DNS_JSON_TMP" "$DAEMON_JSON"
    info "    removed dns from $DAEMON_JSON"
  else
    info "    (no daemon.json present)"
  fi

  $SUDO systemctl daemon-reload
  $SUDO systemctl reload docker 2>/dev/null \
    && info "    docker reloaded (SIGHUP — no containers restarted)" \
    || warn "    docker reload failed — check: journalctl -u docker -n 50"
  if [ "$DOCKER_RESTART" = "1" ]; then
    $SUDO systemctl restart docker && info "    docker restarted (restarts ALL containers) — DOCKER_RESTART=1"
  else
    warn "    Drop-in removed; the daemon keeps its old proxy env until restarted."
    warn "    Run later at a quiet time: sudo systemctl restart docker   (restarts ALL containers)"
  fi
fi

# ---------- post-flight ------------------------------------------------------
info "Post-flight: verifying removal..."
if [ "$DRY_RUN" = "0" ]; then
  GIT_PROXY="$($GITCONF --get http.proxy 2>/dev/null || true)"
  [ -z "$GIT_PROXY" ] && info "  git http.proxy = (unset) [OK]" || warn "  git http.proxy = $GIT_PROXY (still set!)"
  [ -f "$COMPOSE_FILE" ] && warn "  $COMPOSE_FILE still exists" || info "  $COMPOSE_FILE gone [OK]"
  if [ "${SUDO:-}" != "" ]; then
    $SUDO test -f "$DAEMON_CONF" && warn "  $DAEMON_CONF still exists" || info "  $DAEMON_CONF gone [OK]"
    DOCKER_DNS_CHECK="$($SUDO python3 -c "import json; d=json.load(open('/etc/docker/daemon.json')); print(','.join(d.get('dns',[])))" 2>/dev/null || echo '')"
    [ -z "$DOCKER_DNS_CHECK" ] && info "  docker DNS removed [OK]" || warn "  docker DNS still in daemon.json: $DOCKER_DNS_CHECK"
  fi
fi

# ---------- summary ----------------------------------------------------------
cat <<EOF

============================================================
 DONE.  server-remove-proxy.sh v$SCRIPT_VERSION
============================================================
 The server now uses its DIRECT connection again.
$( [ "$DRY_RUN" = "1" ] && echo " (DRY RUN — nothing was actually changed)" )
 Re-enable later:
   bash scripts/proxy/server-setup-proxy.sh
EOF
