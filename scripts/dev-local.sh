#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
[ -f "$ROOT_DIR/.env" ] && . "$ROOT_DIR/.env"
set +a
: "${BACKEND_PORT:=4000}"
: "${GATEWAY_PORT:=4001}"
: "${AGENT_PORT:=4002}"
: "${FRONTEND_PORT:=5173}"
: "${GATEWAY_URL:=http://127.0.0.1:${GATEWAY_PORT}}"
: "${AGENT_URL:=http://127.0.0.1:${AGENT_PORT}}"
: "${DATABASE_URL:=postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel}"
export DATABASE_URL GATEWAY_URL AGENT_URL JWT_SECRET
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=${ROOT_DIR}/scripts/otel.mjs"
port_busy(){ (command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$1 )" | tail -n +2 | grep -q LISTEN) || (command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1); }
for entry in "$BACKEND_PORT:backend" "$GATEWAY_PORT:gateway" "$AGENT_PORT:agent" "$FRONTEND_PORT:frontend"; do
  port="${entry%%:*}"; name="${entry#*:}"
  if port_busy "$port"; then echo "端口 $port 已被占用（$name），请停止占用进程或在 .env 中修改端口。" >&2; exit 1; fi
done
pids=()
cleanup(){ trap - EXIT INT TERM; for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; pkill -TERM -P "$pid" 2>/dev/null || true; done; sleep 1; for pid in "${pids[@]:-}"; do kill -KILL "$pid" 2>/dev/null || true; pkill -KILL -P "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM
(cd "$ROOT_DIR/gateway-service" && OTEL_SERVICE_NAME=sentinel-gateway PORT="$GATEWAY_PORT" npm run dev) & pids+=("$!")
(cd "$ROOT_DIR/agent-service" && OTEL_SERVICE_NAME=sentinel-agent PORT="$AGENT_PORT" npm run dev) & pids+=("$!")
sleep 1
(cd "$ROOT_DIR/backend" && OTEL_SERVICE_NAME=sentinel-backend PORT="$BACKEND_PORT" npm run dev) & pids+=("$!")
sleep 1
(cd "$ROOT_DIR/frontend" && npm run dev -- --port "$FRONTEND_PORT") & pids+=("$!")
echo "本地服务已启动：前端 http://127.0.0.1:${FRONTEND_PORT}，后端 http://127.0.0.1:${BACKEND_PORT}，网关 ${GATEWAY_URL}，Agent ${AGENT_URL}"
wait
