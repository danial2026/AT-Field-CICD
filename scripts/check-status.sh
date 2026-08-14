#!/bin/bash
# =============================================================================
# TEMPLATE: Check status & notify - full service check + push report
# =============================================================================
# Part of the AT FIELD CICD template set (type 3: status checks).
#
# WHAT IT DOES
#   1. Takes a list of things to check as arguments (see CHECKS below):
#        - docker container names
#        - url:port services
#        - plain TCP ports on the local host
#   2. Determines an overall status (OK / FAILED).
#   3. POSTs the result to the AT FIELD CICD status webhook. The server then
#      forwards the report to YOUR notification targets - SMS, email, Discord,
#      Slack, Telegram, ... exactly the ones configured in the "Notifications"
#      tab of the dashboard.
#
# USAGE
#   ./check-status.sh <container-or-service> [more services...]
#   examples:
#     ./check-status.sh myapp-db myapp-api web:80
#     ./check-status.sh "https://example.com/health"
#     ./check-status.sh myapp-db     # single docker container
#
# FULL EXAMPLE (cron every 5 minutes, notify on failure only):
#   */5 * * * * /opt/at-field/check-status.sh myapp-api web:80 \
#     --url https://example.com/api/health --notify-on failure
#
# VARIABLES TO CHANGE
#   STATUS_URL   your status webhook URL. Get it from the dashboard:
#                Notifications tab -> "Status Webhook URL"
#                (e.g. https://ci.example.com/webhook/status/<token>)
#   NOTIFY_ON    "always" | "failure" - only send when something failed
#
# EXIT CODES
#   0  all checks passed
#   1  at least one check failed (message was still sent when NOTIFY_ON=always)
# -----------------------------------------------------------------------------
set -uo pipefail

STATUS_URL="${CI_STATUS_URL:-https://ci.example.com/webhook/status/YOUR_TOKEN_HERE}"
NOTIFY_ON="${NOTIFY_ON:-always}"

info()  { echo "[status] $*"; }
die()   { echo "[status] ERROR: $*" >&2; exit 1; }

echo "==============================="
echo " STATUS CHECK ($(date -u +%FT%TZ))"
echo "==============================="

command -v curl >/dev/null 2>&1 || die "curl is required"

# -- CHECKS -------------------------------------------------------------------
# Each line below lists what to check. Uncomment the ones you need.
# Everything named on the command line is checked as well (see USAGE).
CHECKS=(
  # --- docker containers (must be running) -----------------------------------
  # "docker:myapp-api"
  # "docker:myapp-db"
  # --- http(s) endpoints (must return HTTP 200..399) -------------------------
  # "url:https://example.com/health"
  # --- tcp port on localhost / a remote host ---------------------------------
  # "tcp:127.0.0.1:5432"
  # "tcp:10.0.0.5:3306"
)

for arg in "$@"; do
  case "$arg" in
    --url:*)      CHECKS+=("url:${arg#--url:}") ;;
    --notify-on=*) NOTIFY_ON="${arg#--notify-on=}" ;;
    docker:*|url:*|tcp:*) CHECKS+=("$arg") ;;
    *)            CHECKS+=("docker:$arg") ;;   # bare name = docker container
  esac
done

[ "${#CHECKS[@]}" -gt 0 ] || die "no checks given - see header for usage"

check_docker() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true; }
check_url()    {
  # COMMENT OUT the curl line below or adjust with -k / timeouts as needed.
  # code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")
  # [ "$code" -ge 200 ] && [ "$code" -lt 400 ]
  code=000
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" >/dev/null 2>&1 || true
}
check_tcp()    {
  # COMMENT OUT the nc line below (macOS: nc -zG 5, Linux: nc -z -w5).
  # nc -zG 5 "$1" "$2" || nc -z -w5 "$1" "$2"
  nc -zG 5 "$1" "$2" 2>/dev/null || nc -z -w5 "$1" "$2" 2>/dev/null
}

FAILED=0
DETAILS=""
for check in "${CHECKS[@]}"; do
  case "$check" in
    docker:*)  name="${check#docker:}"
               if check_docker "$name"; then state="running"; else state="STOPPED"; FAILED=1; fi
               report="$name container: $state" ;;
    url:*)     u="${check#url:}"
               if check_url "$u" 2>/dev/null; then state="ok"; else state="UNREACHABLE"; FAILED=1; fi
               report="$u: $state" ;;
    tcp:*)     hostport="${check#tcp:}"; host="${hostport%:*}"; port="${hostport##*:}"
               if check_tcp "$host" "$port"; then state="open"; else state="CLOSED"; FAILED=1; fi
               report="$host:$port: $state" ;;
  esac
  info "  - $report"
  DETAILS="${DETAILS}${report}\n"
done

# -- SEND RESULT --------------------------------------------------------------
# Send the whole report to the AT FIELD CICD status webhook. The server
# forwards it to your SMS/email/Discord/Slack/... targets.
#
# If you do NOT want to use the dashboard server, you can post directly to a
# Shoutrrr-style endpoint instead. Examples (commented out):
#
#   # Discord webhook:
#   # curl -s -H 'Content-Type: application/json' \
#   #   -d "{\"content\":\"Status: $([ $FAILED = 0 ] && echo OK || echo FAILED)\\n$DETAILS\"}" \
#   #   https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
#
#   # Telegram bot:
#   # curl -s -X POST \
#   #   -d "chat_id=CHAT_ID&text=Status: $([ $FAILED = 0 ] && echo OK || echo FAILED) - $DETAILS" \
#   #   https://api.telegram.org/botBOT_TOKEN/sendMessage
#
#   # Any SMTP/email API (e.g. Mailgun):
#   # curl -s -u "api:YOUR_KEY" \
#   #   -d "from=Sender <sender@example.com>&to=you@example.com" \
#   #   -d "subject=Status: $([ $FAILED = 0 ] && echo OK || echo FAILED)" \
#   #   -d "text=$DETAILS" https://api.mailgun.net/v3/example.com/messages

if [ "$FAILED" = "0" ] && [ "$NOTIFY_ON" = "failure" ]; then
  info "all checks OK and NOTIFY_ON=failure - nothing sent"
else
  info "posting report to $STATUS_URL"
  # The commented line below is the actual call - set STATUS_URL first.
  # curl -s -X POST -H 'Content-Type: application/json' \
  #   -d "{\"title\":\"Status check: $([ $FAILED = 0 ] && echo OK || echo FAILED)\",\"message\":\"$([ $FAILED = 0 ] && echo all-checks-passed || echo one-or-more-checks-failed)\",\"ok\":$([ $FAILED = 0 ] && echo true || echo false),\"details\":\"$(printf '%b' "$DETAILS" | tr '\n' '; ' | head -c 3800)\"}" \
  #   "$STATUS_URL"
fi

echo "==============================="
if [ "$FAILED" = "0" ]; then
  echo " ALL CHECKS OK"
  exit 0
else
  echo " ONE OR MORE CHECKS FAILED"
  exit 1
fi
echo "==============================="