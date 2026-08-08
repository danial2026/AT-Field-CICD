#!/bin/bash
# Smoke tests for multi-user / multi-repo AT FIELD CICD

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR" /tmp/ci_smoke_*' EXIT

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

test_case() { echo ""; echo "TEST: $1"; }
pass() { echo -e "${GREEN}✓ PASS${NC}"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}✗ FAIL: $1${NC}"; FAIL=$((FAIL+1)); }

hmac_sig() {
  local payload="$1" secret="$2"
  echo -n "$payload" | openssl dgst -sha256 -hmac "$secret" -hex | awk '{print $NF}'
}

# ── Health ──────────────────────────────────────────────────────────────────
test_case "Health check"
response=$(curl -s "$BASE_URL/health")
echo "$response" | grep -q '"status":"ok"' && pass || fail "$response"

# ── Auth required ───────────────────────────────────────────────────────────
test_case "API requires session"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/repos")
[ "$code" = "401" ] && pass || fail "expected 401 got $code"

# ── Login fail ──────────────────────────────────────────────────────────────
test_case "Login rejects bad password"
code=$(curl -s -o /tmp/ci_smoke_login.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"wrong-password-xyz"}' \
  "$BASE_URL/api/auth/login")
[ "$code" = "401" ] && pass || fail "expected 401 got $code"

# ── Login ok ────────────────────────────────────────────────────────────────
test_case "Login with admin"
code=$(curl -s -c "$COOKIE_JAR" -o /tmp/ci_smoke_login.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/api/auth/login")
if [ "$code" = "200" ] && grep -q '"username"' /tmp/ci_smoke_login.json; then
  pass
else
  fail "login failed code=$code body=$(cat /tmp/ci_smoke_login.json)"
fi

# ── Me ──────────────────────────────────────────────────────────────────────
test_case "GET /api/auth/me"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_me.json -w "%{http_code}" "$BASE_URL/api/auth/me")
[ "$code" = "200" ] && grep -q "$ADMIN_USER" /tmp/ci_smoke_me.json && pass || fail "me failed"

# ── Create repo ─────────────────────────────────────────────────────────────
test_case "Create repo"
SECRET="smoke-secret-$(date +%s)"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_repo.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"Smoke Repo\",\"full_name\":\"smoke/test\",\"provider\":\"github\",\"webhook_secret\":\"$SECRET\"}" \
  "$BASE_URL/api/repos")
if [ "$code" = "201" ] || [ "$code" = "200" ]; then
  REPO_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_repo.json','utf8')).id)")
  REPO_SLUG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_repo.json','utf8')).slug)")
  pass
  echo "  repo id=$REPO_ID slug=$REPO_SLUG"
else
  # maybe already exists - list and find
  curl -s -b "$COOKIE_JAR" "$BASE_URL/api/repos" > /tmp/ci_smoke_repos.json
  REPO_ID=$(node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_repos.json','utf8')).find(x=>x.full_name==='smoke/test'); console.log(r?r.id:'')")
  REPO_SLUG=$(node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_repos.json','utf8')).find(x=>x.full_name==='smoke/test'); console.log(r?r.slug:'')")
  if [ -n "$REPO_ID" ]; then
    # rotate secret
    curl -s -b "$COOKIE_JAR" -X PATCH -H 'Content-Type: application/json' \
      -d "{\"webhook_secret\":\"$SECRET\"}" "$BASE_URL/api/repos/$REPO_ID" > /dev/null
    pass
    echo "  reused repo id=$REPO_ID"
  else
    fail "create repo code=$code $(cat /tmp/ci_smoke_repo.json)"
  fi
fi

# ── Create script ───────────────────────────────────────────────────────────
test_case "Create script"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_script.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"content":"#!/bin/bash\necho SMOKE_OK\n"}' \
  "$BASE_URL/api/scripts/smoke-test")
[ "$code" = "200" ] && pass || fail "script save $code"

# ── Create action ───────────────────────────────────────────────────────────
test_case "Create repo action"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_action.json -w "%{http_code}" \
  -X PUT -H 'Content-Type: application/json' \
  -d '{"type":"script","script":"smoke-test.sh"}' \
  "$BASE_URL/api/repos/$REPO_ID/actions/SMOKE_TEST")
[ "$code" = "200" ] && pass || fail "action $code $(cat /tmp/ci_smoke_action.json)"

# ── Manual run ──────────────────────────────────────────────────────────────
test_case "Manual run action"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_run.json -w "%{http_code}" \
  -X POST "$BASE_URL/api/repos/$REPO_ID/actions/SMOKE_TEST/run")
[ "$code" = "200" ] && grep -q enqueued /tmp/ci_smoke_run.json && pass || fail "run failed"

sleep 1

# ── Webhook signed ──────────────────────────────────────────────────────────
test_case "Signed webhook queues job"
PAYLOAD=$(cat <<EOF
{"ref":"refs/heads/main","repository":{"full_name":"smoke/test","name":"test"},"commits":[{"id":"abc123","message":"chore: SMOKE_TEST via webhook","author":{"name":"ci"}}]}
EOF
)
SIG=$(hmac_sig "$PAYLOAD" "$SECRET")
code=$(curl -s -o /tmp/ci_smoke_hook.json -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$PAYLOAD" \
  "$BASE_URL/webhook/$REPO_SLUG")
if [ "$code" = "200" ] && grep -q queued /tmp/ci_smoke_hook.json; then
  pass
else
  fail "webhook code=$code body=$(cat /tmp/ci_smoke_hook.json)"
fi

# ── Bad signature ───────────────────────────────────────────────────────────
test_case "Webhook rejects bad signature"
code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=deadbeef" \
  -d "$PAYLOAD" \
  "$BASE_URL/webhook/$REPO_SLUG")
[ "$code" = "401" ] && pass || fail "expected 401 got $code"

# ── Forgejo-style signature ─────────────────────────────────────────────────
test_case "Forgejo HMAC header"
# create forgejo repo or update provider temporarily
curl -s -b "$COOKIE_JAR" -X PATCH -H 'Content-Type: application/json' \
  -d '{"provider":"forgejo"}' "$BASE_URL/api/repos/$REPO_ID" > /tmp/ci_smoke_forge.json
FG_PAYLOAD='{"repository":{"full_name":"smoke/test"},"commits":[{"message":"SMOKE_TEST forgejo","id":"f1"}]}'
FG_SIG=$(hmac_sig "$FG_PAYLOAD" "$SECRET")
code=$(curl -s -o /tmp/ci_smoke_fg.json -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "X-Forgejo-Event: push" \
  -H "X-Gitea-Signature: $FG_SIG" \
  -d "$FG_PAYLOAD" \
  "$BASE_URL/webhook/$REPO_SLUG")
# restore github
curl -s -b "$COOKIE_JAR" -X PATCH -H 'Content-Type: application/json' \
  -d '{"provider":"github"}' "$BASE_URL/api/repos/$REPO_ID" > /dev/null
if [ "$code" = "200" ] && grep -q queued /tmp/ci_smoke_fg.json; then
  pass
else
  fail "forgejo hook code=$code $(cat /tmp/ci_smoke_fg.json)"
fi

# ── Audit (admin) ───────────────────────────────────────────────────────────
test_case "Audit log"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_audit.json -w "%{http_code}" "$BASE_URL/api/audit")
if [ "$code" = "200" ] && grep -q login /tmp/ci_smoke_audit.json; then
  pass
else
  fail "audit code=$code"
fi

# ── Create secondary user ───────────────────────────────────────────────────
test_case "Admin creates user"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_user.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"username":"smokeuser","password":"smokeuser1","role":"user"}' \
  "$BASE_URL/api/users")
if [ "$code" = "201" ] || [ "$code" = "409" ]; then
  pass
else
  fail "user create $code $(cat /tmp/ci_smoke_user.json)"
fi

# ── Cleanup script ──────────────────────────────────────────────────────────
test_case "Delete script"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE_URL/api/scripts/smoke-test")
[ "$code" = "200" ] && pass || fail "delete script $code"

# ── Logout ──────────────────────────────────────────────────────────────────
test_case "Logout"
code=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/api/auth/logout")
[ "$code" = "200" ] && pass || fail "logout $code"

test_case "Session invalid after logout"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$BASE_URL/api/repos")
[ "$code" = "401" ] && pass || fail "expected 401 got $code"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================"
echo "PASS: $PASS  FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
