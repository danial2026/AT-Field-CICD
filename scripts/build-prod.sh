#!/bin/bash
# =============================================================================
# TEMPLATE: Build & deploy - PRODUCTION
# =============================================================================
# Part of the AT FIELD CICD template set (type 1: plain CI/CD builds).
#
# WHAT IT DOES
#   1. Verifies the environment (git, build tooling, CI_* env vars).
#   2. Clones/checks out the repo (with auth when CI_GIT_TOKEN is set).
#   3. Builds the project - Go and Node.js examples are written out below
#      but COMMENTED OUT. Uncomment the one you need and delete the other.
#   4. Deploys the result - run/restart sections are COMMENTED OUT.
#
# ENV VARIABLES PROVIDED BY AT FIELD CICD
#   CI_KEYWORD   CI_REPO   CI_COMMIT   CI_PROVIDER
#   CI_GIT_USER  CI_GIT_TOKEN  CI_CLONE_AUTH_URL  CI_CLONE_URL
#
#   See scripts/build-dev.sh header for the full list and docs.
#
# FILES EXPECTED
#   change these to match your repo layout
# -----------------------------------------------------------------------------
set -euo pipefail

WORKDIR="$(dirname "$0")/work-prod"
REPO_URL="${CI_CLONE_AUTH_URL:-${CI_CLONE_URL:-}}"
BRANCH="main"
# The tag/release or annotation this build deploys. Leave as CI_COMMIT to
# deploy the exact commit that triggered the job.
DEPLOY_REF="${CI_COMMIT:-HEAD}"

info()  { echo "[build-prod] $*"; }
die()   { echo "[build-prod] ERROR: $*" >&2; exit 1; }

echo "==============================="
echo " BUILD_PROD ($(date -u +%FT%TZ))"
echo "==============================="

# -- 1. ENVIRONMENT CHECKS --------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required"
info "repo: ${CI_REPO:-<unknown>}  commit: ${CI_COMMIT:-<unknown>}  branch: $BRANCH"
[ -n "$REPO_URL" ] || die "no clone URL (set clone_url on the repo or CI_CLONE_URL)"

# -- 2. CLONE / CHECKOUT ----------------------------------------------------
rm -rf "$WORKDIR"
git clone "$REPO_URL" "$WORKDIR"
git -C "$WORKDIR" checkout "$BRANCH" 2>/dev/null || git -C "$WORKDIR" checkout -b "$BRANCH"
git -C "$WORKDIR" checkout "$DEPLOY_REF"
git -C "$WORKDIR" submodule update --init --recursive 2>/dev/null || true
cd "$WORKDIR"

# -- 3. BUILD ----------------------------------------------------------------
# Uncomment the block that matches your stack and adjust paths/commands.

info "building (production)..."

## --- Go backend -------------------------------------------------------------
# export CGO_ENABLED=0
# export GOFLAGS="-mod=readonly"
# go mod download
# go vet ./...
# go test ./... -count=1
# go build -trimpath -ldflags="-s -w" -o bin/app ./cmd/server     # adjust ./cmd/server
#
## --- Node.js backend --------------------------------------------------------
# npm ci                       # clean install from package-lock.json
# npm run build:prod           # project script, e.g. tsc / vite build / next build
# npm run test                 # required tests must pass

echo ""                                                        # <- remove me
echo "BUILD STEP COMMENTED OUT - uncomment a stack block above" # <- remove me

# -- 4. DEPLOY ---------------------------------------------------------------
# Uncomment one of the sections below. Pick what fits your setup.

## A) Copy a package to a shared location --------------------------------------
# DEPLOY_DIR="/srv/${CI_REPO//\//-}"
# mkdir -p "$DEPLOY_DIR"
# rsync -a --delete --exclude "$WORKDIR/.git" "$WORKDIR/" "$DEPLOY_DIR/"
#
## B) Restart the service via SSH (key on server; see SECURITY.md) -------------
# DEPLOY_HOST="prod.example.com"
# DEPLOY_USER="deployer"
# ssh -i /path/to/key "$DEPLOY_USER@$DEPLOY_HOST" \
#   'sudo systemctl restart myapp'   # 'stop' first for zero-downtime scripts
#
## C) SSH + rsync in one step ---------------------------------------------------
# ssh -i /path/to/key "$DEPLOY_USER@$DEPLOY_HOST" 'mkdir -p /var/www/app'
# rsync -az --delete -e "ssh -i /path/to/key" \
#   --exclude node_modules --exclude .git \
#   "$WORKDIR/dist/" "$DEPLOY_USER@$DEPLOY_HOST:/var/www/app/"
# ssh -i /path/to/key "$DEPLOY_USER@$DEPLOY_HOST" 'sudo systemctl restart myapp'

echo "==============================="
echo " BUILD_PROD DONE"
echo "==============================="