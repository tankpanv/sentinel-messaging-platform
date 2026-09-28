#!/usr/bin/env bash
# Unified Gateway user API checks against an isolated local simulated Gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-4402}"
BASE="http://127.0.0.1:${PORT}"
STATE="$(mktemp /tmp/gateway-users-state.XXXXXX.json)"
LOG="$(mktemp /tmp/gateway-users-server.XXXXXX.log)"
rm -f "$STATE"
PID=""
cleanup(){ [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true; [[ -n "$PID" ]] && wait "$PID" 2>/dev/null || true; rm -f "$STATE" "$LOG" /tmp/gateway-users-owner-delete.json; }
trap cleanup EXIT
start(){ (cd "$ROOT/gateway-service" && GATEWAY_STATE_FILE="$STATE" PORT="$PORT" exec ./node_modules/.bin/tsx src/index.ts) >>"$LOG" 2>&1 & PID=$!; for _ in $(seq 1 100); do curl -fsS "$BASE/health" >/dev/null 2>&1 && return; sleep .1; done; cat "$LOG"; exit 1; }
stop(){ kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }
json(){ curl -fsS -H 'content-type: application/json' "$@"; }
start
json -X POST -d '{}' "$BASE/accounts/acc-1/connect" >/dev/null
json -X POST -d '{}' "$BASE/accounts/acc-2/connect" >/dev/null
USERS="$(json "$BASE/users")"
python3 - "$USERS" <<'PY'
import json,sys
users=json.loads(sys.argv[1])
assert any(u['id']=='acc-1' for u in users)
assert all('kind' not in u and 'external' not in u and 'serviceAccount' not in u for u in users)
assert all({'edit','delete','join','leave','send','create_group','operate_group'} <= set(u['capabilities']) for u in users)
PY
CREATED="$(json -X POST -d '{"displayName":"统一用户","platformUserId":"unified-user"}' "$BASE/users")"
USER_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$CREATED")"
json -X PATCH -d '{"displayName":"统一用户（已编辑）"}' "$BASE/users/$USER_ID" | grep -q '已编辑'
json -X PATCH -d '{"displayName":"Gateway 管理员"}' "$BASE/users/acc-1" | grep -q 'Gateway 管理员'
GROUP="$(json -X POST -d '{}' "$BASE/users/$USER_ID/groups" | python3 -c 'import json,sys; print(json.load(sys.stdin)["groupId"])')"
INVITE="$(json -X POST -d '{}' "$BASE/groups/$GROUP/invite" | python3 -c 'import json,sys; print(json.load(sys.stdin)["inviteLink"])')"
json -X POST -d "{\"inviteLink\":\"$INVITE\"}" "$BASE/users/acc-1/groups/$GROUP/join" >/dev/null
sleep .2
json -X POST -d '{"text":"统一用户消息","clientMsgId":"unified-user-message"}' "$BASE/users/$USER_ID/groups/$GROUP/messages" | grep -q '"deliveryStatus":"sent"'
json -X POST -d '{"text":"连接账号消息","clientMsgId":"managed-user-message"}' "$BASE/users/acc-1/groups/$GROUP/messages" | grep -q '"accepted":true'
sleep .2
MESSAGES="$(json "$BASE/groups/$GROUP/messages")"
[[ "$MESSAGES" == *'统一用户消息'* && "$MESSAGES" == *'连接账号消息'* ]]
json -X POST -d "{\"byUserId\":\"$USER_ID\",\"targetUserId\":\"acc-1\"}" "$BASE/groups/$GROUP/promote-user" | grep -q '"promoted":true'
json -X POST -d "{\"byUserId\":\"$USER_ID\",\"targetUserId\":\"acc-1\"}" "$BASE/groups/$GROUP/kick-user" | grep -q '"kicked":true'
[[ "$(json "$BASE/groups/$GROUP/members")" != *'platform-1'* ]]
HTTP="$(curl -sS -o /tmp/gateway-users-owner-delete.json -w '%{http_code}' -X DELETE "$BASE/users/$USER_ID")"
[[ "$HTTP" == 409 ]] && grep -q 'USER_OWNS_GROUP' /tmp/gateway-users-owner-delete.json
stop
start
json "$BASE/users/$USER_ID" | grep -q '统一用户（已编辑）'
json "$BASE/groups/$GROUP" | grep -q 'unified-user'
printf 'PASS: unified user CRUD, group creation, membership, messaging, admin operations, and restart persistence on simulated Gateway %s\n' "$BASE"
