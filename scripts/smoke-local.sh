#!/usr/bin/env bash
set -euo pipefail
API_URL="${API_URL:-http://127.0.0.1:28080}"
json() { curl -fsS "$@"; }
json "$API_URL/api/health" | grep -q '"ok":true'
admin_token="$(json -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}' "$API_URL/api/auth/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')"
viewer_token="$(json -H 'content-type: application/json' -d '{"username":"viewer","password":"viewer"}' "$API_URL/api/auth/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')"
json -H "authorization: Bearer $admin_token" "$API_URL/api/accounts" | grep -q 'acc-1'
if curl -sS -o /tmp/sentinel-viewer-write.json -w '%{http_code}' -X POST -H "authorization: Bearer $viewer_token" "$API_URL/api/accounts/acc-1/connect" | grep -q '^403$'; then :; else echo 'viewer RBAC smoke check failed' >&2; exit 1; fi
json -X POST -H "authorization: Bearer $admin_token" "$API_URL/api/accounts/acc-1/connect" | grep -q online
json -X POST -H "authorization: Bearer $admin_token" "$API_URL/api/accounts/acc-2/connect" | grep -q online
job="$(json -X POST -H "authorization: Bearer $admin_token" -H 'content-type: application/json' -d '{"creatorAccountId":"acc-1","memberAccountIds":["acc-2"]}' "$API_URL/api/groups" | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])')"
for _ in $(seq 1 30); do status="$(json -H "authorization: Bearer $admin_token" "$API_URL/api/jobs/$job" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"; [[ "$status" != running ]] && break; sleep .2; done
[[ "$status" == finished ]] || { echo "group job failed: $status" >&2; exit 1; }
echo 'local smoke checks passed'
