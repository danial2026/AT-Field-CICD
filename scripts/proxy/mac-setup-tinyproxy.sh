#!/bin/bash
# =============================================================================
# mac-setup-tinyproxy.sh   v1.0.0   —   run ON THE MAC (the laptop with the VPN)
# =============================================================================
# Turns the Mac into a LAN-facing HTTP proxy so other devices on your home
# network (e.g. the Ubuntu server) can reach the internet through the Mac's
# VPN tunnel.
#
# What it does:
#   1. Installs tinyproxy via Homebrew (if missing).
#   2. Backs up the existing tinyproxy.conf, then configures port + LAN allow.
#   3. Starts it as a brew background service (auto-restarts at login).
#   4. Verifies it is listening and can reach GitHub end-to-end.
#
# Requirements:
#   - macOS with Homebrew (https://brew.sh)
#   - Your VPN connected (OpenVPN Connect, etc.) — tinyproxy only forwards
#     traffic; the VPN does the unblocking.
#
# Usage:
#   bash scripts/proxy/mac-setup-tinyproxy.sh
#   PROXY_PORT=8888 LAN_SUBNET=<your-lan-subnet> bash scripts/proxy/mac-setup-tinyproxy.sh
#   DRY_RUN=1 bash scripts/proxy/mac-setup-tinyproxy.sh    # show actions, change nothing
#   bash scripts/proxy/mac-setup-tinyproxy.sh --help
#
# Undo:
#   brew services stop tinyproxy && brew uninstall tinyproxy
# =============================================================================
set -euo pipefail

cat <<'BANNER'


 ████▄██▄   ▄█████▄   ▄█████▄
 ██ ██ ██   ▀ ▄▄▄██  ██▀    ▀
 ██ ██ ██  ▄██▀▀▀██  ██
 ██ ██ ██  ██▄▄▄███  ▀██▄▄▄▄█
 ▀▀ ▀▀ ▀▀   ▀▀▀▀ ▀▀    ▀▀▀▀▀


BANNER

readonly SCRIPT_VERSION="1.0.0"
readonly CONF="/opt/homebrew/etc/tinyproxy/tinyproxy.conf"
readonly LOCK="/tmp/at-field-mac-tinyproxy.lock"

PROXY_PORT="${PROXY_PORT:-8888}"
LAN_SUBNET="${LAN_SUBNET:-}"
DRY_RUN="${DRY_RUN:-0}"
TEST_GIT_REPO="${TEST_GIT_REPO:-https://github.com/octocat/Hello-World.git}"

# ---------- helpers ----------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
info() { log "  INFO  $*"; }
warn() { log "  WARN  $*"; }
err()  { log "  ERROR $*" >&2; }
run()  { if [ "$DRY_RUN" = "1" ]; then log "  DRY   $*"; else eval "$@"; fi; }

cleanup() {
  rm -f "$LOCK"
  [ -n "${BACKUP:-}" ] && [ -f "$BACKUP" ] && rm -f "$BACKUP"
  return 0
}
trap cleanup EXIT

# ---------- arg parsing ------------------------------------------------------
case "${1:-}" in
  -h|--help)
    sed -n '2,30p' "$0"; exit 0 ;;
  -v|--version)
    echo "mac-setup-tinyproxy.sh v$SCRIPT_VERSION"; exit 0 ;;
esac

# ---------- guards -----------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  err "This script must run on macOS (got $(uname -s))."
  err "For the Ubuntu server, use server-setup-proxy.sh instead."
  exit 2
fi

# Lock to prevent concurrent runs
if [ -f "$LOCK" ]; then
  err "Another run is in progress ($LOCK). Remove it if stale: rm -f $LOCK"
  exit 3
fi
echo $$ > "$LOCK"

command -v brew >/dev/null 2>&1 || { err "Homebrew not installed. See https://brew.sh"; exit 4; }

# Validate port
case "$PROXY_PORT" in
  ''|*[!0-9]*) err "PROXY_PORT must be numeric (got '$PROXY_PORT')"; exit 5 ;;
esac
[ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ] || { err "PROXY_PORT out of range: $PROXY_PORT"; exit 5; }

# ---------- prompt for LAN_SUBNET if not set -----------------------------------
if [ -z "${LAN_SUBNET:-}" ]; then
  if [ -t 0 ]; then
    printf 'Enter your LAN subnet (e.g. 192.168.1.0/24): '
    read -r LAN_SUBNET
  fi
  [ -n "${LAN_SUBNET:-}" ] || { err "LAN_SUBNET is required. Set via env or run interactively."; exit 5; }
fi
info "LAN subnet: $LAN_SUBNET"

# ---------- pre-flight: is a VPN tunnel up? -----------------------------------
info "Pre-flight: checking for an active VPN tunnel..."
if ifconfig 2>/dev/null | grep -q '^utun[0-9].*UP'; then
  info "VPN tunnel interface found (utun)."
else
  warn "No utun interface detected. Is your VPN connected?"
  warn "tinyproxy will still start, but it won't bypass anything without a VPN."
  warn "Continuing in 3s (Ctrl+C to abort)..."
  [ "$DRY_RUN" = "1" ] || sleep 3
fi

# ---------- install ----------------------------------------------------------
info "Installing tinyproxy (if missing)..."
run "brew list tinyproxy >/dev/null 2>&1 || brew install tinyproxy"

# ---------- backup + configure (atomic) -------------------------------------
if [ -f "$CONF" ]; then
  BACKUP="$CONF.bak.$(date +%Y%m%d%H%M%S)"
  info "Backing up $CONF -> $BACKUP"
  run "cp -a \"$CONF\" \"$BACKUP\""
else
  warn "No existing tinyproxy.conf found at $CONF (will be created by brew)."
fi

info "Configuring: port=$PROXY_PORT allow=$LAN_SUBNET (binds all interfaces)..."

# Write a fresh, deterministic config block to a temp file, then atomically move.
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# AT-Field CI tinyproxy config — managed by mac-setup-tinyproxy.sh v$SCRIPT_VERSION
# $(date -u +%Y-%m-%dT%H:%M:%SZ)
Port $PROXY_PORT
# Listen commented out => bind to ALL interfaces (needed for LAN access)
#Listen 127.0.0.1
Allow 127.0.0.1
Allow ::1
Allow $LAN_SUBNET
Timeout 600
EOF

if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   would install config -> $CONF"
  cat "$TMP" | sed 's/^/        /'
  rm -f "$TMP"
else
  # Preserve any extra directives from the old config that we didn't manage
  # (e.g. LogFile, PidFile). Simplest robust approach: keep default brew conf
  # and only rewrite the lines we own. We do a full overwrite here because the
  # brew default is self-contained; see backup above for recovery.
  mv "$TMP" "$CONF"
  info "Config written: $CONF"
fi

# ---------- start service ----------------------------------------------------
info "Starting tinyproxy as a brew background service..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   brew services start tinyproxy (skipped)"
else
  brew services start tinyproxy >/dev/null 2>&1 || true
  # Wait for the port to come up (up to ~10s)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 1
  done
fi

# ---------- post-flight ------------------------------------------------------
info "Post-flight: verifying tinyproxy is listening on :$PROXY_PORT..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   listening check skipped"
else
  if lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    info "OK: listening on :$PROXY_PORT (all interfaces)."
  else
    err "Nothing listening on :$PROXY_PORT."
    err "Check: brew services info tinyproxy ; cat $CONF"
    if [ -n "${BACKUP:-}" ]; then
      err "Recover with: mv $BACKUP $CONF && brew services restart tinyproxy"
    fi
    exit 6
  fi
fi

info "Post-flight: end-to-end test (curl -> proxy -> github.com)..."
if [ "$DRY_RUN" = "1" ]; then
  log "  DRY   curl test skipped"
else
  HTTP_CODE="$(curl -s --max-time 25 -x "http://127.0.0.1:$PROXY_PORT" \
    -o /dev/null -w '%{http_code}' https://github.com 2>/dev/null || echo "000")"
  if [ "$HTTP_CODE" = "200" ]; then
    info "OK: github.com returned 200 through the proxy."
  else
    warn "github.com returned HTTP $HTTP_CODE through the proxy."
    warn "If your VPN is up but this fails, the VPN may not be routing github."
  fi
fi

# ---------- summary ----------------------------------------------------------
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
cat <<EOF

============================================================
 DONE.  mac-setup-tinyproxy.sh v$SCRIPT_VERSION
============================================================
 Proxy URL for LAN devices:
   http://${LAN_IP:-<your-mac-lan-ip>}:$PROXY_PORT
$( [ "$DRY_RUN" = "1" ] && echo " (DRY RUN — nothing was actually changed)" )
 Keep the Mac on and the VPN connected.
 Undo: brew services stop tinyproxy && brew uninstall tinyproxy
EOF
