#!/bin/bash
# =============================================================================
# TEMPLATE: Build & deploy - DEVELOPMENT
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
#   CI_KEYWORD        keyword that triggered this job (e.g. BUILD_DEV)
#   CI_REPO           repo full name (e.g. owner/repo)
#   CI_COMMIT         commit SHA the action was matched against
#   CI_PROVIDER       github | gitea | forgejo | gitlab | generic
#   CI_GIT_USER       git username (if configured on the repo)
#   CI_GIT_TOKEN      git token/PAT (if configured on the repo)
#   CI_CLONE_AUTH_URL authenticated https clone URL (private repos)
#   CI_CLONE_URL      plain clone URL
#
# FILES EXPECTED
#   change these to match your repo layout
# -----------------------------------------------------------------------------
set -euo pipefail

WORKDIR="$(dirname "$0")/work"
REPO_URL="${CI_CLONE_AUTH_URL:-${CI_CLONE_URL:-}}"
BRANCH="dev"

info()  { echo "[build-dev] $*"; }
die()   { echo "[build-dev] ERROR: $*" >&2; exit 1; }

echo "==============================="
echo " BUILD_DEV ($(date -u +%FT%TZ))"
echo "==============================="

echo "-- 1. ENVIRONMENT CHECKS ----------------"
command -v git >/dev/null 2>&1 || die "git is required"
for tool in go node npm; do
  [ -x "$(command -v $tool)" ] && info "$tool: $($tool --version 2>/dev/null | head -1)" || true
done
info "repo: ${CI_REPO:-<unknown>}  commit: ${CI_COMMIT:-<unknown>}  branch: $BRANCH"
[ -n "$REPO_URL" ] || die "no clone URL (set clone_url on the repo or CI_CLONE_URL)"

echo "-- 2. CLONE / CHECKOUT ----------------"
rm -rf "$WORKDIR"
git clone "$REPO_URL" "$WORKDIR"
git -C "$WORKDIR" checkout "$BRANCH" 2>/dev/null || git -C "$WORKDIR" checkout -b "$BRANCH"
git -C "$WORKDIR" checkout "${CI_COMMIT:-HEAD}"
git -C "$WORKDIR" submodule update --init --recursive 2>/dev/null || true
cd "$WORKDIR"

echo "-- 3. BUILD ----------------"
# Uncomment the block that matches your stack and adjust paths/commands.
# The other block is provided for reference.

info "building (dev)..."

## --- Go backend -------------------------------------------------------------
# export CGO_ENABLED=0
# go mod download
# go build -trimpath -ldflags="-s -w" -o bin/app ./cmd/server     # adjust ./cmd/server
# go test ./... ./... >/dev/null 2>&1 || true                     # optional: dev tests
#
## --- Node.js backend --------------------------------------------------------
# npm ci 2>/dev/null || npm install
# npm run build:dev          # project script, e.g. tsc / vite build / next build
# npm test 2>/dev/null || true

echo ""                                                        # <- remove me
echo "BUILD STEP COMMENTED OUT - uncomment a stack block above" # <- remove me

echo "-- 4. DEPLOY ----------------"
# Uncomment one of the sections below. Pick what fits your setup.

## A) Simple: copy a package to a shared location -----------------------------
# DEPLOY_DIR="/srv/${CI_REPO//\//-}-dev"
# mkdir -p "$DEPLOY_DIR"
# rsync -a --delete --exclude node_modules --exclude .git ./ "$DEPLOY_DIR/"
# info "deployed files to $DEPLOY_DIR"

## B) Restart via systemd (unit file pre-created on the server) ---------------
# systemctl --user restart myapp-dev || sudo systemctl restart myapp-dev

## C) Run the process directly (dev) ------------------------------------------
# exec ./bin/app -port 8080   # Go
# exec npm run start:dev      # Node.js

echo "==============================="
echo " BUILD_DEV DONE"
echo "==============================="