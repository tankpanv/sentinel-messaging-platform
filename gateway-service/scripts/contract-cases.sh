#!/usr/bin/env bash
# Contract checks against the local Gateway simulator over HTTP; every request is logged.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4401}"
BASE="http://127.0.0.1:${PORT}"
STATE="$(mktemp /tmp/gateway-contract-state.XXXXXX.json)"
rm -f "$STATE"
LOG="$(mktemp /tmp/gateway-contract-server.XXXXXX.log)"
STREAM="$(mktemp /tmp/gateway-contract-sse.XXXXXX.log)"
MEDIA_DIR="$(mktemp -d /tmp/gateway-contract-media.XXXXXX)"
SERVER_PID=""
cleanup(){ if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi; rm -f "$STATE" "$LOG" "$STREAM"; rm -r "$MEDIA_DIR"; }
trap cleanup EXIT
if curl --max-time .2 -sS "$BASE/health" >/dev/null 2>&1; then echo "port $PORT is already serving; choose another PORT" >&2; exit 1; fi
start_gateway(){
  (cd "$ROOT" && export GATEWAY_STATE_FILE="$STATE" GATEWAY_MEDIA_DIR="$MEDIA_DIR" PORT && exec "$ROOT/node_modules/.bin/tsx" src/index.ts) >>"$LOG" 2>&1 & SERVER_PID=$!
  for _ in $(seq 1 100); do curl -fsS "$BASE/health" >/dev/null 2>&1 && return 0; sleep .1; done
  cat "$LOG" >&2; echo 'gateway did not start' >&2; return 1
}
stop_gateway(){ kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
start_gateway
EARLY_SSE="$(curl -sSN -D - --max-time .25 "$BASE/events" 2>/dev/null || true)"
[[ "$EARLY_SSE" == *'Content-Type: text/event-stream'* ]]

case_no=0
request(){
  local method="$1" path="$2" body="${3:-}" expected="$4" extra="${5:-}"
  case_no=$((case_no+1))
  local args=(-sS -X "$method" -H 'content-type: application/json')
  [[ -n "$body" ]] && args+=(-d "$body")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  local raw code content
  raw="$(curl "${args[@]}" -w $'\n%{http_code}' "$BASE$path")"
  code="${raw##*$'\n'}"; content="${raw%$'\n'*}"
  printf '\nCASE %02d  curl -X %s %s%s%s\nHTTP %s (expected %s)\n%s\n' "$case_no" "$method" "$path" "${body:+ -d '$body'}" "${extra:+ -H '$extra'}" "$code" "$expected" "$content"
  [[ "$code" == "$expected" ]] || { echo "FAILED case $case_no" >&2; exit 1; }
  LAST_BODY="$content"
}
field(){ python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1" <<<"$LAST_BODY"; }
expect_code(){ [[ "$LAST_BODY" == *"\"code\":\"$1\""* ]] || { echo "expected code $1: $LAST_BODY" >&2; exit 1; }; }

request GET /health '' 200
request GET /accounts/acc-1 '' 200
[[ "$LAST_BODY" == *'"platformUserId":null'* && "$LAST_BODY" == *'"status":"idle"'* ]]
request POST /groups '{"creatorAccountId":"acc-1"}' 409; expect_code ACCOUNT_OFFLINE
request POST /accounts/no-such/connect '{}' 404
request POST /accounts/acc-1/connect '{}' 200; P1="$(field platformUserId)"
request POST /accounts/acc-1/connect '{}' 200; [[ "$LAST_BODY" == *"$P1"* ]]
request POST /accounts/acc-2/connect '{}' 200; P2="$(field platformUserId)"
request POST /accounts/acc-3/connect '{}' 200; P3="$(field platformUserId)"
request POST /groups '{"creatorAccountId":"acc-1"}' 200; GROUP="$(field groupId)"
request GET /admin/events '' 200
[[ "$LAST_BODY" != *"$P1"* ]]
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$P1"* ]]
request POST "/groups/$GROUP/invite" '{"readyAfterMs":300}' 200; INVITE="$(field inviteLink)"
request POST "/groups/not-a-group/invite" '{}' 404
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-1","accountId":"acc-4"}' 409; expect_code ACCOUNT_OFFLINE
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-2\",\"inviteLink\":\"$INVITE\"}" 409; expect_code INVITE_NOT_READY
sleep .35
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-2\",\"inviteLink\":\"$INVITE\",\"joinDelayMs\":150}" 202
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-1","accountId":"acc-2"}' 409; expect_code NOT_MEMBER_YET
sleep .2
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$P2"* ]]
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-2\",\"inviteLink\":\"$INVITE\"}" 409; expect_code ALREADY_MEMBER
request GET /admin/events '' 200
JOIN_EVENT_COUNT="$(python3 -c 'import json,sys; print(sum(e.get("type")=="member_joined" and e.get("platformUserId")==sys.argv[1] for e in json.load(sys.stdin)))' "$P2" <<<"$LAST_BODY")"
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-1","accountId":"acc-2"}' 200
request GET /admin/events '' 200
[[ "$(python3 -c 'import json,sys; print(sum(e.get("type")=="member_joined" and e.get("platformUserId")==sys.argv[1] for e in json.load(sys.stdin)))' "$P2" <<<"$LAST_BODY")" == "$JOIN_EVENT_COUNT" ]]
request POST /accounts/acc-4/connect '{}' 200; P4="$(field platformUserId)"
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-4\",\"inviteLink\":\"$INVITE\",\"joinDelayMs\":100}" 202
sleep .15
request POST "/groups/$GROUP/kick" "{\"byAccountId\":\"acc-2\",\"targetPlatformUserId\":\"$P4\",\"delayMs\":1000}" 200
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P4"* ]]
request POST "/groups/$GROUP/invite" '{"ttlMs":100}' 200; EXPIRED="$(field inviteLink)"
sleep .15
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-3\",\"inviteLink\":\"$EXPIRED\"}" 410; expect_code INVITE_EXPIRED
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-2","accountId":"acc-3"}' 403; expect_code NO_PERMISSION
request POST /groups '{"creatorAccountId":"acc-3"}' 200; OTHER_GROUP="$(field groupId)"
request POST "/groups/$OTHER_GROUP/join" "{\"accountId\":\"acc-3\",\"inviteLink\":\"$INVITE\"}" 404
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-3\",\"inviteLink\":\"$INVITE\",\"neverArrive\":true}" 202
request POST "/groups/$GROUP/kick" "{\"byAccountId\":\"acc-1\",\"targetPlatformUserId\":\"$P3\",\"simulateTimeout\":true}" 504; expect_code NETWORK_TIMEOUT
sleep .6
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P3"* ]]
request POST "/groups/$GROUP/kick" "{\"byAccountId\":\"acc-1\",\"targetPlatformUserId\":\"$P2\",\"delayMs\":1000}" 200
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P2"* ]]
request POST "/groups/$GROUP/send" '{"accountId":"acc-2","clientMsgId":"not-member","text":"x"}' 403; expect_code SENDER_NOT_IN_GROUP
request POST "/groups/$GROUP/external-member" '{"platformUserId":"external-user-1","action":"joined"}' 202
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *'external-user-1'* ]]
request POST "/groups/$GROUP/external-member" '{"platformUserId":"external-user-1","action":"left"}' 202
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *'external-user-1'* ]]
request POST "/groups/$GROUP/external-member" '{"action":"bad"}' 400
request POST /users '{"displayName":"合同用户","platformUserId":"gateway-contract-user"}' 201; EXT_ACCOUNT_ID="$(field id)"; EXT_PLATFORM_ID="$(field platformUserId)"
request POST /users '{"displayName":"重复用户","platformUserId":"gateway-contract-user"}' 409; expect_code PLATFORM_USER_ID_CONFLICT
request GET "/users/$EXT_ACCOUNT_ID" '' 200; [[ "$LAST_BODY" == *'"displayName":"合同用户"'* && "$LAST_BODY" == *"$EXT_PLATFORM_ID"* ]]
request PATCH "/users/$EXT_ACCOUNT_ID" '{"displayName":"合同用户（已更新）"}' 200; [[ "$LAST_BODY" == *'（已更新）'* ]]
request POST "/users/$EXT_ACCOUNT_ID/groups/$GROUP/join" '{}' 201
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$EXT_PLATFORM_ID"* ]]
request POST "/users/$EXT_ACCOUNT_ID/groups/$GROUP/messages" '{"text":"Gateway 用户合同消息","clientMsgId":"gateway-user-contract"}' 202
request GET "/groups/$GROUP/messages" '' 200; [[ "$LAST_BODY" == *'Gateway 用户合同消息'* && "$LAST_BODY" == *"$EXT_PLATFORM_ID"* ]]
request POST "/users/$EXT_ACCOUNT_ID/groups/$GROUP/leave" '{}' 200
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$EXT_PLATFORM_ID"* ]]
request DELETE "/users/$EXT_ACCOUNT_ID" '' 200
request GET "/users/$EXT_ACCOUNT_ID" '' 404; expect_code USER_NOT_FOUND
request GET /groups/not-a-group/members '' 404
request POST "/groups/$GROUP/leave" '{"accountId":"acc-2","fail":true}' 500; expect_code LEAVE_FAILED
request POST "/groups/$GROUP/leave" '{"accountId":"acc-2"}' 200
request POST "/groups/$GROUP/leave" '{"accountId":"acc-2"}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"send-a","text":"hello","delayMs":700}' 202
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"send-order-later","text":"newer sentAt, earlier event","delayMs":100}' 202
request GET "/groups/$GROUP/messages/by-client-id/send-a" '' 404
sleep .2
request GET "/groups/$GROUP/messages/by-client-id/send-order-later" '' 200
sleep .6
request GET "/groups/$GROUP/messages/by-client-id/send-a" '' 200
SENT_MSG_ID="$(field msgId)"
request GET "/admin/events?msgId=$SENT_MSG_ID" '' 200
[[ "$LAST_BODY" == *'"type":"message_sent"'* && "$LAST_BODY" == *'"type":"message"'* && "$LAST_BODY" == *"$SENT_MSG_ID"* ]]
[[ "$LAST_BODY" == *"$P1"* ]]
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"slow-response","text":"hello","responseDelayMs":1100}' 202
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"send-dup","text":"one"}' 202
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"send-dup","text":"two"}' 202
sleep .2
request GET "/groups/$GROUP/messages/by-client-id/send-dup" '' 200
EARLIEST_MSG_ID="$(field msgId)"
request GET "/admin/groups/$GROUP/messages" '' 200
[[ "$(python3 -c 'import json,sys; print(sum(m.get("clientMsgId")=="send-dup" for m in json.load(sys.stdin)))' <<<"$LAST_BODY")" == 2 ]]
FIRST_DUP_ID="$(python3 -c 'import json,sys; print(next(m["msgId"] for m in json.load(sys.stdin) if m.get("clientMsgId")=="send-dup"))' <<<"$LAST_BODY")"
[[ "$EARLIEST_MSG_ID" == "$FIRST_DUP_ID" ]]
request POST "/groups/$GROUP/write-status" '{"writable":false}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"no","text":"x"}' 403; expect_code GROUP_WRITE_FORBIDDEN
request POST "/groups/$GROUP/write-status" '{"writable":true}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"async-fail","text":"x","simulateFailed":true,"failCode":"GROUP_WRITE_FORBIDDEN"}' 202
sleep .2
request GET /admin/events '' 200
[[ "$LAST_BODY" == *'"type":"message_failed"'* && "$LAST_BODY" == *'"clientMsgId":"async-fail"'* ]]
[[ "$(python3 -c 'import json,sys; ids=[e["eventId"] for e in json.load(sys.stdin)]; print(ids==sorted(ids) and len(ids)==len(set(ids)))' <<<"$LAST_BODY")" == True ]]
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-4\",\"inviteLink\":\"$INVITE\"}" 202
sleep .15
request POST "/groups/$GROUP/send" '{"accountId":"acc-4","clientMsgId":"async-terminal","text":"x","simulateFailed":true,"failCode":"ACCOUNT_SUSPENDED"}' 202
sleep .2
request GET /accounts/acc-4 '' 200; [[ "$LAST_BODY" == *'"status":"suspended"'* ]]
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P4"* ]]
request POST "/groups/$GROUP/external-message" '{"msgId":"external-1","text":"incoming"}' 202
request POST /media '{"base64":"aGVsbG8=","contentType":"text/plain","ttlSeconds":60}' 201; LONG_MEDIA="$(field mediaUrl)"
request POST "/groups/$GROUP/external-message" "{\"msgId\":\"media-message\",\"text\":\"with media\",\"mediaUrl\":\"$LONG_MEDIA\"}" 202
request GET /admin/events?msgId=media-message '' 200; [[ "$LAST_BODY" == *"$LONG_MEDIA"* ]]
request GET /admin/events '' 200
CHECKPOINT="$(python3 -c 'import json,sys; print(max(e["eventId"] for e in json.load(sys.stdin)))' <<<"$LAST_BODY")"
request POST "/groups/$GROUP/external-message" '{"msgId":"resume-new","text":"arrived while client disconnected"}' 202
RESUMED_SSE="$(curl -sSN --max-time 3 "$BASE/events?since=$CHECKPOINT" 2>/dev/null || true)"
[[ "$RESUMED_SSE" == *'resume-new'* && "$RESUMED_SSE" != *'external-1'* ]]
request POST "/groups/$GROUP/external-message" '{"msgId":"late-old","sentAt":"2020-01-01T00:00:00.000Z","text":"offline-delayed"}' 202
request GET "/groups/$GROUP/messages/by-client-id/missing" '' 404
request GET "/groups/not-a-group/messages/by-client-id/missing" '' 404
request GET /admin/events '' 200
EVENT_ID="$(python3 -c 'import json,sys; print(next(e["eventId"] for e in json.load(sys.stdin) if e.get("msgId")=="late-old"))' <<<"$LAST_BODY")"
request POST "/admin/events/$EVENT_ID/redeliver" '{}' 200
[[ "$(field eventId)" -gt "$EVENT_ID" ]]
REDELIVER_ID="$(field eventId)"
request GET /admin/events '' 200
[[ "$(python3 -c 'import json,sys; x=[e for e in json.load(sys.stdin) if e.get("msgId")=="late-old"]; print(len(x))' <<<"$LAST_BODY")" == 2 ]]
[[ "$LAST_BODY" == *'2020-01-01T00:00:00.000Z'* ]]
REDLIVER_MSG="$(python3 -c 'import json,sys; print(next(e for e in json.load(sys.stdin) if e["eventId"]==int(sys.argv[1]))["sentAt"])' "$REDELIVER_ID" <<<"$LAST_BODY")"
[[ "$REDLIVER_MSG" == '2020-01-01T00:00:00.000Z' ]]
curl -sSN --max-time 2 "$BASE/events" >"$STREAM" 2>/dev/null & STREAM_PID=$!
sleep .1
request POST "/admin/events/$EVENT_ID/replay" '{}' 200
request POST "/admin/events/$EVENT_ID/replay" '{}' 200
sleep .1
kill "$STREAM_PID" 2>/dev/null || true
wait "$STREAM_PID" 2>/dev/null || true
cat "$STREAM"
[[ "$(grep -c "^id: $EVENT_ID$" "$STREAM")" -ge 2 ]]
SSE="$(curl -sSN --max-time 1 "$BASE/events?since=0" || true)"
printf '\nCASE SSE replay since=0\n%s\n' "$SSE"
[[ "$SSE" == *'id: '* && "$SSE" == *'event: member_joined'* && "$SSE" == *'"eventId"'* ]]
[[ "$SSE" == *'event: member_left'* && "$SSE" == *'event: message_sent'* && "$SSE" == *'event: message_failed'* && "$SSE" == *'event: message'* ]]
BAD_SSE="$(curl -sS -w $'\n%{http_code}' "$BASE/events?since=NaN")"; [[ "$BAD_SSE" == *$'\n400' ]]
request GET /admin/events '' 200
LATEST_EVENT_ID="$(python3 -c 'import json,sys; print(max(e["eventId"] for e in json.load(sys.stdin)))' <<<"$LAST_BODY")"
EXCLUSIVE_SSE="$(curl -sSN --max-time .25 "$BASE/events?since=$LATEST_EVENT_ID" 2>/dev/null || true)"
[[ -z "$EXCLUSIVE_SSE" ]]
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"restart-pending","text":"survives restart","delayMs":700}' 202
stop_gateway
start_gateway
request GET /accounts/acc-1 '' 200; [[ "$LAST_BODY" == *'"status":"online"'* && "$LAST_BODY" == *"$P1"* ]]
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$P1"* ]]
RECOVERED_SSE="$(curl -sSN --max-time .25 "$BASE/events?since=0" 2>/dev/null || true)"
[[ "$RECOVERED_SSE" == *'late-old'* && "$RECOVERED_SSE" == *'event: message_sent'* ]]
sleep .75
request GET "/groups/$GROUP/messages/by-client-id/restart-pending" '' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"timeout-no","text":"x","simulateTimeout":true}' 504; expect_code NETWORK_TIMEOUT
request GET "/groups/$GROUP/messages/by-client-id/timeout-no" '' 404
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"timeout-yes","text":"x","simulateTimeout":true,"acceptOnTimeout":true,"settleDelayMs":300}' 504
sleep .4
request GET "/groups/$GROUP/messages/by-client-id/timeout-yes" '' 200
sleep 2.1
request GET "/groups/$GROUP/messages/by-client-id/timeout-no" '' 404
request POST /accounts/acc-1/rate-limit '{"retryAfterSeconds":1}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"limited","text":"x"}' 429; expect_code RATE_LIMITED
[[ "$LAST_BODY" == *'"retryAfterSeconds":1'* ]]
sleep .2
request POST /accounts/acc-1/connect '{}' 200
request GET /accounts/acc-1 '' 200; [[ "$LAST_BODY" == *'"status":"rate_limited"'* ]]
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"limited-again","text":"x"}' 429; expect_code RATE_LIMITED
sleep 1.1
request GET /accounts/acc-1 '' 200
[[ "$LAST_BODY" == *'"status":"online"'* ]]
request GET /admin/events '' 200; [[ "$LAST_BODY" == *'"status":"online"'* ]]
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-2\",\"inviteLink\":\"$INVITE\"}" 202
sleep .2
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$P2"* ]]
request POST /accounts/acc-2/status '{"status":"suspended"}' 200
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P2"* ]]
request POST /accounts/acc-2/status '{"status":"suspended"}' 200
request POST /accounts/acc-2/status '{"status":"session_expired"}' 403; expect_code ACCOUNT_SUSPENDED
request POST /accounts/acc-2/connect '{}' 403; expect_code ACCOUNT_SUSPENDED
request POST /accounts/acc-2/disconnect '{}' 403; expect_code ACCOUNT_SUSPENDED
request POST /accounts/acc-2/rate-limit '{"retryAfterSeconds":1}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/send" '{"accountId":"acc-2","clientMsgId":"terminal","text":"x"}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/leave" '{"accountId":"acc-2"}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-2","accountId":"acc-3"}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-1","accountId":"acc-2"}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/kick" '{"byAccountId":"acc-2","targetPlatformUserId":"platform-3"}' 403; expect_code ACCOUNT_SUSPENDED
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-2\",\"inviteLink\":\"$INVITE\"}" 403; expect_code ACCOUNT_SUSPENDED
request POST /groups '{"creatorAccountId":"acc-2"}' 403; expect_code ACCOUNT_SUSPENDED
request POST /accounts/acc-2/status '{"status":"disconnected"}' 400; expect_code VALIDATION_ERROR
request POST "/groups/$OTHER_GROUP/leave" '{"accountId":"acc-3"}' 200
request POST "/groups/$OTHER_GROUP/kick" '{"byAccountId":"acc-3","targetPlatformUserId":"external-user"}' 409; expect_code OWNER_LEFT
request POST /accounts/acc-4/status '{"status":"online"}' 400
request POST /accounts/acc-4/status '{"status":"suspended"}' 200
request POST /accounts/acc-4/connect '{}' 403; expect_code ACCOUNT_SUSPENDED
request POST /accounts/acc-5/connect '{}' 200; P5="$(field platformUserId)"
request POST "/groups/$GROUP/invite" '{}' 200; SESSION_INVITE="$(field inviteLink)"
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-5\",\"inviteLink\":\"$SESSION_INVITE\"}" 202
sleep .15
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" == *"$P5"* ]]
request POST /accounts/acc-5/status '{"status":"session_expired"}' 200
request GET "/groups/$GROUP/members" '' 200; [[ "$LAST_BODY" != *"$P5"* ]]
request POST /accounts/acc-5/connect '{}' 401; expect_code SESSION_EXPIRED
request POST "/groups/$GROUP/send" '{"accountId":"acc-5","clientMsgId":"expired-send","text":"x"}' 401; expect_code SESSION_EXPIRED
request POST "/groups/$GROUP/leave" '{"accountId":"acc-5"}' 401; expect_code SESSION_EXPIRED
request POST /accounts/acc-5/disconnect '{}' 401; expect_code SESSION_EXPIRED
request POST /accounts/acc-5/rate-limit '{"retryAfterSeconds":1}' 401; expect_code SESSION_EXPIRED
SSE_TERMINAL="$(curl -sSN --max-time 2 "$BASE/events?since=0" 2>/dev/null || true)"
[[ "$SSE_TERMINAL" == *'event: account_status'* ]]
request POST "/media" '{"base64":"aGVsbG8=","contentType":"text/plain","ttlSeconds":1}' 201; MEDIA="$(field mediaUrl)"
request POST /media '{"base64":"x","contentType":"not-a-media-type"}' 400; expect_code VALIDATION_ERROR
request GET "${MEDIA#http://127.0.0.1:$PORT}" '' 200
sleep 1.1
request GET "${MEDIA#http://127.0.0.1:$PORT}" '' 404
request POST /media '{"base64":"aGVsbG8=","contentType":"text/plain","ttlSeconds":1}' 201; DELAYED_MEDIA="$(field mediaUrl)"
request POST "/groups/$GROUP/send" "{\"accountId\":\"acc-1\",\"clientMsgId\":\"expired-media-send\",\"text\":\"\",\"mediaId\":\"${DELAYED_MEDIA##*/}\",\"delayMs\":1500}" 202
sleep 1.7
request GET /admin/events '' 200
[[ "$LAST_BODY" == *'"clientMsgId":"expired-media-send","code":"MEDIA_NOT_FOUND"'* && "$LAST_BODY" != *"$DELAYED_MEDIA"* ]]
request POST /media '{"base64":"aGVsbG8=","contentType":"text/plain","ttlSeconds":1}' 201; EXPIRED_MESSAGE_MEDIA="$(field mediaUrl)"
request POST "/groups/$GROUP/external-message" "{\"msgId\":\"expiring-media-message\",\"senderPlatformUserId\":\"outside-media\",\"text\":\"with expiring media\",\"mediaId\":\"${EXPIRED_MESSAGE_MEDIA##*/}\"}" 202
sleep 1.1
stop_gateway
start_gateway
request GET /admin/events?msgId=expiring-media-message '' 200; [[ "$LAST_BODY" != *"$EXPIRED_MESSAGE_MEDIA"* ]]
request GET "/admin/groups/$GROUP/messages" '' 200; [[ "$LAST_BODY" != *"$EXPIRED_MESSAGE_MEDIA"* ]]
request POST /admin/send-fault '{"accountId":"acc-1","code":"NETWORK_TIMEOUT","accept":true}' 200
request GET /admin/events '' 200; BEFORE_LATE_EVENT="$(python3 -c 'import json,sys; print(max(e["eventId"] for e in json.load(sys.stdin)))' <<<"$LAST_BODY")"
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"faulted","text":"x"}' 504
request GET "/groups/$GROUP/messages/by-client-id/faulted" '' 404
request POST /admin/send-fault '{"accountId":"acc-1","code":"SERVICE_UNAVAILABLE","accept":false}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"unavailable","text":"x"}' 503
request GET "/groups/$GROUP/messages/by-client-id/unavailable" '' 404
request GET "/groups/$GROUP/messages/by-client-id/faulted" '' 503 'x-simulate-unavailable: 1'; expect_code SERVICE_UNAVAILABLE
request POST "/accounts/acc-1/disconnect" '{}' 200
sleep 1.6
request GET "/groups/$GROUP/messages/by-client-id/faulted" '' 200
FAULT_MSG_ID="$(field msgId)"
FAULT_SENT_AT="$(field sentAt)"
request GET "/admin/groups/$GROUP/messages" '' 200
[[ "$(python3 -c 'import json,sys; print(next(m["sentAt"] for m in json.load(sys.stdin) if m.get("clientMsgId")=="faulted"))' <<<"$LAST_BODY")" == "$FAULT_SENT_AT" ]]
request GET "/admin/events?msgId=$FAULT_MSG_ID" '' 200
[[ "$(python3 -c 'import json,sys; print(min(e["eventId"] for e in json.load(sys.stdin)))' <<<"$LAST_BODY")" -gt "$BEFORE_LATE_EVENT" ]]
request POST "/accounts/acc-1/connect" '{}' 200; [[ "$LAST_BODY" == *"$P1"* ]]
request POST "/accounts/acc-1/disconnect" '{}' 200
request POST "/groups/$GROUP/send" '{"accountId":"acc-1","clientMsgId":"offline","text":"x"}' 409; expect_code ACCOUNT_OFFLINE
request POST "/groups/$GROUP/join" "{\"accountId\":\"acc-1\",\"inviteLink\":\"$INVITE\"}" 409; expect_code ACCOUNT_OFFLINE
request POST "/groups/$GROUP/promote" '{"byAccountId":"acc-1","accountId":"acc-3"}' 409; expect_code ACCOUNT_OFFLINE
request POST "/groups/$GROUP/kick" "{\"byAccountId\":\"acc-1\",\"targetPlatformUserId\":\"$P2\"}" 409; expect_code ACCOUNT_OFFLINE
request POST "/groups/$GROUP/leave" '{"accountId":"acc-1"}' 409; expect_code ACCOUNT_OFFLINE
request GET /health '' 503 'x-simulate-unavailable: 1'; expect_code SERVICE_UNAVAILABLE
printf '\nPASS: %s simulated Gateway curl contract cases completed. This does not verify a real external gateway.\n' "$case_no"
