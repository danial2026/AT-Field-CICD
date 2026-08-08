#!/bin/bash
# =============================================================================
# server-remove-proxy.sh   v1.0.0   —   run ON THE UBUNTU SERVER
# =============================================================================
# Removes ALL proxy configuration created by server-setup-proxy.sh:
#   1. git global http/https proxy
#   2. no_proxy block from ~/.zshrc and ~/.bashrc
#   3. docker-compose.override.yml (backed up, not deleted outright)
#   4. Docker daemon proxy drop-in (NEEDS SUDO)
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
#   DRY_RUN=1 bash scripts/proxy/server-remove-proxy.sh   # show actions only
#   bash scripts/proxy/server-remove-proxy.sh --help
# =============================================================================
set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly LOCK="/tmp/at-field-server-proxy-remove.lock"
readonly MARKER="# AT-Field CI: LAN proxy bypass (added by server-setup-proxy.sh)"

DRY_RUN="${DRY_RUN:-0}"

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

# ---------- 1) git -----------------------------------------------------------
info "[1/4] Removing git global proxy config..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   git config --global --unset http.proxy / https.proxy"
else
  git config --global --unset http.proxy  2>/dev/null && info "    unset http.proxy" || info "    (http.proxy was not set)"
  git config --global --unset https.proxy 2>/dev/null && info "    unset https.proxy" || info "    (https.proxy was not set)"
fi

# ---------- 2) shell rc files ------------------------------------------------
info "[2/4] Removing no_proxy block from shell rc files..."
for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
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
info "[4/4] Removing Docker daemon proxy drop-in (needs sudo)..."
DAEMON_CONF="/etc/systemd/system/docker.service.d/http-proxy.conf"
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   would remove $DAEMON_CONF + restart docker (if present)"
else
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else SUDO="sudo"; info "    (sudo will prompt)"; fi

  if $SUDO test -f "$DAEMON_CONF"; then
    $SUDO rm -f "$DAEMON_CONF"
    $SUDO systemctl daemon-reload
    if $SUDO systemctl restart docker; then
      info "    removed drop-in + restarted docker"
    else
      warn "    docker restart failed — check: journalctl -u docker -n 50"
    fi
  else
    info "    (no drop-in present)"
  fi
fi

# ---------- post-flight ------------------------------------------------------
info "Post-flight: verifying removal..."
if [ "$DRY_RUN" = "0" ]; then
  GIT_PROXY="$(git config --global --get http.proxy 2>/dev/null || true)"
  [ -z "$GIT_PROXY" ] && info "  git http.proxy = (unset) [OK]" || warn "  git http.proxy = $GIT_PROXY (still set!)"
  [ -f "$COMPOSE_FILE" ] && warn "  $COMPOSE_FILE still exists" || info "  $COMPOSE_FILE gone [OK]"
  if [ "${SUDO:-}" != "" ]; then
    $SUDO test -f "$DAEMON_CONF" && warn "  $DAEMON_CONF still exists" || info "  $DAEMON_CONF gone [OK]"
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
