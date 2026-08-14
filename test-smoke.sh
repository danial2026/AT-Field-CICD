#!/bin/bash
# Smoke tests for multi-user / multi-repo AT FIELD CICD

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
COOKIE_JAR=$(mktemp)
CAPTURE_PORT="${CAPTURE_PORT:-$(( RANDOM % 20000 + 10000 ))}"
CAPTURE_LOG=$(mktemp)
trap 'rm -f "$COOKIE_JAR" /tmp/ci_smoke_* "$CAPTURE_LOG"' EXIT

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

# ── Re-login (logout invalidated the session used below) ─────────────────────
test_case "Re-login for dashboard tests"
code=$(curl -s -c "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/api/auth/login")
[ "$code" = "200" ] && pass || fail "re-login $code"

# ── Stats API ────────────────────────────────────────────────────────────────
test_case "Stats API returns chart data"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_stats.json -w "%{http_code}" "$BASE_URL/api/stats?days=7")
if [ "$code" = "200" ] && grep -q per_day /tmp/ci_smoke_stats.json && grep -q overview /tmp/ci_smoke_stats.json; then
  pass
else
  fail "stats code=$code $(cat /tmp/ci_smoke_stats.json)"
fi

# ── Notifications (per user) ─────────────────────────────────────────────────
# Start a tiny local capture server that mimics a generic webhook target.
node -e '
  const http = require("http"), fs = require("fs");
  const log = process.argv[2];
  http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => {
      fs.appendFileSync(log, JSON.stringify({
        method: req.method, path: req.url, headers: req.headers, body: b,
      }) + "\n");
      res.writeHead(200, {"Content-Type":"application/json"}); res.end("{\"ok\":true}");
    });
  }).listen(process.argv[1], () => console.log("capture up"));
' "$CAPTURE_PORT" "$CAPTURE_LOG" > /tmp/ci_smoke_capture.log 2>&1 &
CAPTURE_PID=$!
sleep 1
if ! grep -q "capture up" /tmp/ci_smoke_capture.log; then
  fail "capture server failed to start: $(cat /tmp/ci_smoke_capture.log)"
fi

test_case "Create notification target"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_notif.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"Smoke Target\",\"type\":\"generic\",\"config\":{\"url\":\"http://localhost:$CAPTURE_PORT/hook\"},\"events\":[\"job_failure\",\"job_success\"],\"enabled\":true}" \
  "$BASE_URL/api/notifications")
if [ "$code" = "201" ] && grep -q '"type":"generic"' /tmp/ci_smoke_notif.json; then
  NOTIF_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_notif.json','utf8')).id)")
  pass
else
  fail "notification create code=$code $(cat /tmp/ci_smoke_notif.json)"
fi

test_case "Notification targets are per-user"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$BASE_URL/api/notifications")
[ "$code" = "200" ] && pass || fail "list notifications $code"

test_case "Test notification delivery (generic webhook)"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_notiftest.json -w "%{http_code}" \
  -X POST "$BASE_URL/api/notifications/$NOTIF_ID/test")
sleep 1
if [ "$code" = "200" ] && grep -q sent /tmp/ci_smoke_notiftest.json && [ -s "$CAPTURE_LOG" ] && grep -q "Test notification" "$CAPTURE_LOG"; then
  pass
else
  fail "test send code=$code $(cat /tmp/ci_smoke_notiftest.json)"
fi

test_case "Invalid notification config rejected"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"bad","type":"discord","config":{},"events":[]}' \
  "$BASE_URL/api/notifications")
[ "$code" = "400" ] && pass || fail "expected 400 got $code"

test_case "Generic URL (Shoutrrr-style) notification"
code=$(curl -s -b "$COOKIE_JAR" -o /tmp/ci_smoke_gennotif.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"SMS Target\",\"type\":\"generic\",\"config\":{\"url\":\"generic://localhost:$CAPTURE_PORT/hook/sms?template=json&disabletls=yes&\$simId=1_2&\$recipient=%2B09981077840&\$priority=high&@authorization=Bearer%20testtoken&x-forwarded=yes\"},\"events\":[\"job_failure\"],\"enabled\":true}" \
  "$BASE_URL/api/notifications")
if [ "$code" = "201" ] && grep -q '"type":"generic"' /tmp/ci_smoke_gennotif.json; then
  GEN_NOTIF_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_gennotif.json','utf8')).id)")
  pass
else
  fail "generic notification create code=$code $(cat /tmp/ci_smoke_gennotif.json)"
fi

test_case "Generic URL delivers via http with headers/params"
: > "$CAPTURE_LOG"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/api/notifications/$GEN_NOTIF_ID/test")
sleep 1
if [ "$code" = "200" ] && node -e "
  const d = require('fs').readFileSync(process.argv[1], 'utf8').trim().split('\n').map(JSON.parse);
  const e = d.find(x => x.path.includes('/hook/sms'));
  if (!e) process.exit(1);
  if (e.method !== 'POST') process.exit(2);
  if (!e.path.includes('x-forwarded=yes')) process.exit(3);
  if (e.headers.authorization !== 'Bearer testtoken') process.exit(4);
  const b = JSON.parse(e.body);
  if (b.simId !== '1_2' || b.recipient !== '+09981077840' || b.priority !== 'high') process.exit(5);
  process.exit(0);
" "$CAPTURE_LOG"; then
  pass
else
  fail "generic delivery: code=$code capture=$(cat "$CAPTURE_LOG" 2>/dev/null)"
fi

test_case "Delete generic notification"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE_URL/api/notifications/$GEN_NOTIF_ID")
[ "$code" = "200" ] && pass || fail "delete generic notification $code"

# ── Status webhook (external status reports) ─────────────────────────────────
test_case "Status webhook token from /api/notifications"
STATUS_WEBHOOK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ci_smoke_notif.json','utf8')).status_webhook || '')" 2>/dev/null)
if [ -z "$STATUS_WEBHOOK" ]; then
  STATUS_WEBHOOK=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/notifications" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status_webhook||''))")
fi
if [ -n "$STATUS_WEBHOOK" ]; then pass; else fail "no status webhook in notification payload"; fi

test_case "External status report forwards to targets"
: > "$CAPTURE_LOG"
code=$(curl -s -o /tmp/ci_smoke_status.json -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"title":"docker myapp","message":"container myapp is healthy","ok":true,"details":"uptime 3d"}' \
  "$BASE_URL$STATUS_WEBHOOK")
sleep 1
if [ "$code" = "200" ] && grep -q received /tmp/ci_smoke_status.json && grep -q "container myapp is healthy" "$CAPTURE_LOG"; then
  pass
else
  fail "status report code=$code body=$(cat /tmp/ci_smoke_status.json) capture=$(cat "$CAPTURE_LOG" 2>/dev/null)"
fi

test_case "Status webhook rejects bad token"
code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"message":"hi"}' \
  "$BASE_URL/webhook/status/00000000000000000000000000000000")
[ "$code" = "401" ] && pass || fail "expected 401 got $code"

test_case "Job events notify subscribed targets (job_success)"
# point a repo action at a script and run it; the user subscribed to job_success
: > "$CAPTURE_LOG"
curl -s -b "$COOKIE_JAR" -X POST -H 'Content-Type: application/json' \
  -d '{"content":"#!/bin/bash\necho NOTIFY_OK\n"}' \
  "$BASE_URL/api/scripts/notify-test" > /dev/null
curl -s -b "$COOKIE_JAR" -X PUT -H 'Content-Type: application/json' \
  -d '{"type":"script","script":"notify-test.sh"}' \
  "$BASE_URL/api/repos/$REPO_ID/actions/NOTIFY_TEST" > /dev/null
curl -s -b "$COOKIE_JAR" -X POST "$BASE_URL/api/repos/$REPO_ID/actions/NOTIFY_TEST/run" > /dev/null
sleep 2
if [ -s "$CAPTURE_LOG" ] && grep -q "job_success" "$CAPTURE_LOG"; then
  pass
else
  fail "no notification captured for job_success: $(cat "$CAPTURE_LOG" 2>/dev/null)"
fi

test_case "Job run recorded for stats"
curl -s -b "$COOKIE_JAR" "$BASE_URL/api/stats?days=7" > /tmp/ci_smoke_stats2.json
if grep -q "NOTIFY_TEST" /tmp/ci_smoke_stats2.json; then
  pass
else
  fail "job run missing from stats"
fi

test_case "Delete notification target"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE_URL/api/notifications/$NOTIF_ID")
[ "$code" = "200" ] && pass || fail "delete notification $code"

kill "$CAPTURE_PID" 2>/dev/null || true

test_case "Cleanup notify-test script"
code=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" \
  -X DELETE "$BASE_URL/api/scripts/notify-test")
[ "$code" = "200" ] && pass || fail "delete script $code"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "================================"
echo "PASS: $PASS  FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
