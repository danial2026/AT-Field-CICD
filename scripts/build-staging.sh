#!/bin/bash
# =============================================================================
# TEMPLATE: Build & deploy - STAGING
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

WORKDIR="$(dirname "$0")/work-staging"
REPO_URL="${CI_CLONE_AUTH_URL:-${CI_CLONE_URL:-}}"
BRANCH="staging"

info()  { echo "[build-staging] $*"; }
die()   { echo "[build-staging] ERROR: $*" >&2; exit 1; }

echo "==============================="
echo " BUILD_STAGING ($(date -u +%FT%TZ))"
echo "==============================="

# -- 1. ENVIRONMENT CHECKS --------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required"
info "repo: ${CI_REPO:-<unknown>}  commit: ${CI_COMMIT:-<unknown>}  branch: $BRANCH"
[ -n "$REPO_URL" ] || die "no clone URL (set clone_url on the repo or CI_CLONE_URL)"

# -- 2. CLONE / CHECKOUT ----------------------------------------------------
rm -rf "$WORKDIR"
git clone "$REPO_URL" "$WORKDIR"
git -C "$WORKDIR" checkout "$BRANCH" 2>/dev/null || git -C "$WORKDIR" checkout -b "$BRANCH"
git -C "$WORKDIR" checkout "${CI_COMMIT:-HEAD}"
git -C "$WORKDIR" submodule update --init --recursive 2>/dev/null || true
cd "$WORKDIR"

# -- 3. BUILD ----------------------------------------------------------------
# Uncomment the block that matches your stack and adjust paths/commands.

info "building (staging)..."

## --- Go backend -------------------------------------------------------------
# export CGO_ENABLED=0
# go mod download
# go vet ./...
# go build -trimpath -ldflags="-s -w" -o bin/app ./cmd/server     # adjust ./cmd/server
#
## --- Node.js backend --------------------------------------------------------
# npm ci 2>/dev/null || npm install
# npm run build:staging       # project script (envs usually come from config)
# npm run test 2>/dev/null || true

echo ""                                                        # <- remove me
echo "BUILD STEP COMMENTED OUT - uncomment a stack block above" # <- remove me

# -- 4. DEPLOY ---------------------------------------------------------------
# Uncomment one of the sections below. Pick what fits your setup.

## A) Copy a package to a shared location --------------------------------------
# DEPLOY_DIR="/srv/${CI_REPO//\//-}-staging"
# mkdir -p "$DEPLOY_DIR"
# rsync -a --delete --exclude "$WORKDIR/.git" "$WORKDIR/" "$DEPLOY_DIR/"
#
## B) Restart the service via SSH ----------------------------------------------
# ssh -i /path/to/key deployer@staging.example.com \
#   'sudo systemctl restart myapp-staging'
#
## C) Run the process directly (staging) ---------------------------------------
# exec ./bin/app -port 8081   # Go
# exec npm run start:staging  # Node.js

echo "==============================="
echo " BUILD_STAGING DONE"
echo "==============================="