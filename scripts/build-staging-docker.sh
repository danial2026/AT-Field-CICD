#!/bin/bash
# =============================================================================
# TEMPLATE: Docker build & deploy - STAGING
# =============================================================================
# Part of the AT FIELD CICD template set (type 2: Docker Compose builds).
#
# HOW THIS TEMPLATE WORKS
#   1. Check whether the compose service/container is CURRENTLY RUNNING.
#   2. Build the Dockerfile and rebuild the container image.
#   3. If the container WAS running before the check in step 1:
#        it is redeployed automatically (up -d).
#      If it was NOT running:
#        only the image is updated - the container is left stopped so you
#        can start it manually later (docker compose up -d).
#
# VARIABLES TO CHANGE
#   PROJECT_DIR   where your repo (with Dockerfile / docker-compose.yml) lives
#   COMPOSE_FILE  compose file to use (default: docker-compose.yml)
#   SERVICE_NAME  service inside the compose file that is the app
#   GIT_BRANCH    branch to build
#
# ENV PROVIDED BY AT FIELD CICD
#   CI_KEYWORD  CI_REPO  CI_COMMIT  CI_PROVIDER
#   CI_GIT_USER  CI_GIT_TOKEN  CI_CLONE_AUTH_URL  CI_CLONE_URL
#
#   See scripts/build-dev.sh header for the full list and docs.
#
# NOTES
#   - Every docker/repo command below is COMMENTED OUT with real instructions.
#     Uncomment the lines you need and adjust the variables.
#   - Run this script on the Docker host itself (or give the CI user access
#     to the docker socket).
# -----------------------------------------------------------------------------
set -euo pipefail

PROJECT_DIR="/srv/${CI_REPO:-myapp}/staging"
COMPOSE_FILE="docker-compose.yml"
SERVICE_NAME="app"
GIT_BRANCH="staging"
REPO_URL="${CI_CLONE_AUTH_URL:-${CI_CLONE_URL:-}}"

info() { echo "[build-staging-docker] $*"; }
die()  { echo "[build-staging-docker] ERROR: $*" >&2; exit 1; }

echo "==============================="
echo " BUILD_STAGING_DOCKER ($(date -u +%FT%TZ))"
echo "==============================="

command -v docker >/dev/null 2>&1 || die "docker is required"

# -- 1. WAS THE CONTAINER RUNNING? -------------------------------------------
# WAS_RUNNING=false
# if docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" ps -q "$SERVICE_NAME" >/dev/null 2>&1 \
#    && [ -n "$(docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" ps -q "$SERVICE_NAME")" ]; then
#   state=$(docker inspect -f '{{.State.Running}}' "$(docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR" ps -q "$SERVICE_NAME")" 2>/dev/null || echo false)
#   WAS_RUNNING=$state
# fi
# info "container was running before build: $WAS_RUNNING"
WAS_RUNNING=false

# -- 2. GET THE CODE ----------------------------------------------------------
# cd "$PROJECT_DIR"
# git fetch --all --prune
# git checkout "$GIT_BRANCH"
# git pull --ff-only
# git checkout "${CI_COMMIT:-HEAD}"

# -- 3. BUILD / REBUILD THE IMAGE ---------------------------------------------
# docker build -t "${CI_REPO:-myapp}:staging-${CI_COMMIT:-latest}" .
# docker compose -f "$COMPOSE_FILE" build "$SERVICE_NAME"

# -- 4. DEPLOY ONLY IF IT WAS RUNNING BEFORE ---------------------------------
# if [ "$WAS_RUNNING" = "true" ]; then
#   docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$SERVICE_NAME"
#   docker image prune -f
#   info "redeployed $SERVICE_NAME (was running before build)"
# else
#   info "container was not running - image updated. Start manually:"
#   info "  docker compose -f $PROJECT_DIR/$COMPOSE_FILE up -d $SERVICE_NAME"
# fi

echo "==============================="
echo " BUILD_STAGING_DOCKER SKELETON READY"
echo " uncomment the commands above and adjust PROJECT_DIR / SERVICE_NAME"
echo "==============================="