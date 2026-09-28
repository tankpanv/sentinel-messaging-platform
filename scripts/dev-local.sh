#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${DEV_LOCAL_PID_FILE:-$ROOT_DIR/.dev-local.pid}"
LOG_FILE="${DEV_LOCAL_LOG_FILE:-$ROOT_DIR/.dev-local.log}"

declare -A ENV_OVERRIDES=()
for key in BACKEND_PORT GATEWAY_PORT AGENT_PORT FRONTEND_PORT GATEWAY_URL AGENT_URL DATABASE_URL JWT_SECRET VITE_BACKEND_URL VITE_GATEWAY_URL ENABLE_GATEWAY_SIMULATION AGENT_PROVIDER; do
  if [[ ${!key+x} ]]; then ENV_OVERRIDES["$key"]="${!key}"; fi
done
set -a
[ -f "$ROOT_DIR/.env" ] && . "$ROOT_DIR/.env"
set +a
for key in "${!ENV_OVERRIDES[@]}"; do printf -v "$key" '%s' "${ENV_OVERRIDES[$key]}"; export "$key"; done

: "${BACKEND_PORT:=${PORT:-28080}}"
: "${GATEWAY_PORT:=28081}"
: "${AGENT_PORT:=28082}"
: "${FRONTEND_PORT:=25173}"
: "${GATEWAY_URL:=http://127.0.0.1:${GATEWAY_PORT}}"
: "${AGENT_URL:=http://127.0.0.1:${AGENT_PORT}}"
: "${DATABASE_URL:=postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel}"
: "${VITE_BACKEND_URL:=http://127.0.0.1:${BACKEND_PORT}}"
: "${ENABLE_GATEWAY_SIMULATION:=true}"
: "${AGENT_PROVIDER:=mock}"
export BACKEND_PORT GATEWAY_PORT AGENT_PORT FRONTEND_PORT DATABASE_URL GATEWAY_URL AGENT_URL JWT_SECRET VITE_BACKEND_URL VITE_GATEWAY_URL ENABLE_GATEWAY_SIMULATION AGENT_PROVIDER
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=${ROOT_DIR}/scripts/otel.mjs"

services=("$BACKEND_PORT:backend" "$GATEWAY_PORT:gateway" "$AGENT_PORT:agent" "$FRONTEND_PORT:frontend")

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN && return 0
  fi
  command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

port_owner() {
  if command -v lsof >/dev/null 2>&1; then
    local owner
    owner="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -n 1 || true)"
    [[ -n "$owner" ]] && { printf '%s' "$owner"; return; }
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -v -n tcp "$1" 2>&1 | tail -n +2 | head -n 1 || true
  else
    ss -H -ltnp "( sport = :$1 )" 2>/dev/null | head -n 1 || true
  fi
}

read_pid() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid; pid="$(head -n 1 "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

running_pid() {
  local pid; pid="$(read_pid || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { printf '%s\n' "$pid"; return 0; }
  return 1
}

status() {
  local pid
  if pid="$(running_pid)"; then
    echo "本地服务正在运行（supervisor PID $pid）"
    echo "前端: http://127.0.0.1:${FRONTEND_PORT}"
    echo "后端: http://127.0.0.1:${BACKEND_PORT}"
    echo "网关: ${GATEWAY_URL}"
    echo "Agent: ${AGENT_URL}"
    return 0
  fi
  [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
  echo "本地服务未运行"
  return 1
}

stop_services() {
  local pid
  if ! pid="$(running_pid)"; then
    # A crashed supervisor may leave npm children behind. Reuse the same
    # port-scoped cleanup path below instead of declaring stop successful.
    local entry port child found=0
    for entry in "${services[@]}"; do
      port="${entry%%:*}"
      if command -v lsof >/dev/null 2>&1; then
        while read -r child; do [[ "$child" =~ ^[0-9]+$ ]] && { found=1; kill -TERM "$child" 2>/dev/null || true; }; done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
      fi
    done
    sleep 0.5
    for entry in "${services[@]}"; do
      port="${entry%%:*}"
      if command -v lsof >/dev/null 2>&1; then
        while read -r child; do [[ "$child" =~ ^[0-9]+$ ]] && kill -KILL "$child" 2>/dev/null || true; done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
      fi
    done
    rm -f "$PID_FILE"; [[ "$found" == 1 ]] && echo "已清理残留服务" || echo "本地服务未运行"; return 0
  fi
  echo "正在停止本地服务（supervisor PID $pid）..."
  kill -TERM -- "-$pid" 2>/dev/null || true
  pkill -TERM -s "$pid" 2>/dev/null || true
  for _ in {1..30}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || true
    pkill -KILL -s "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  fi
  # npm/tsx can create a child process group after the supervisor exits. Clean
  # only listeners on the four configured service ports so restart is reliable.
  local entry port child
  for entry in "${services[@]}"; do
    port="${entry%%:*}"
    if command -v lsof >/dev/null 2>&1; then
      while read -r child; do [[ "$child" =~ ^[0-9]+$ ]] && kill -TERM "$child" 2>/dev/null || true; done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    fi
  done
  sleep 0.5
  for entry in "${services[@]}"; do
    port="${entry%%:*}"
    if command -v lsof >/dev/null 2>&1; then
      while read -r child; do [[ "$child" =~ ^[0-9]+$ ]] && kill -KILL "$child" 2>/dev/null || true; done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    fi
  done
  rm -f "$PID_FILE"
  echo "本地服务已停止"
}

check_ports() {
  local entry port name
  for entry in "${services[@]}"; do
    port="${entry%%:*}"; name="${entry#*:}"
    if port_busy "$port"; then
      echo "端口 $port 已被占用（$name）：$(port_owner "$port")" >&2
      echo "请停止占用进程，或通过 BACKEND_PORT/GATEWAY_PORT/AGENT_PORT/FRONTEND_PORT 修改端口。" >&2
      return 1
    fi
  done
}

wait_http() {
  local url="$1"
  for _ in {1..60}; do
    if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

run_services() {
  local -a pids=()
  cleanup() {
    trap - EXIT INT TERM
    local child
    for child in "${pids[@]:-}"; do kill -TERM "$child" 2>/dev/null || true; done
    sleep 1
    for child in "${pids[@]:-}"; do kill -KILL "$child" 2>/dev/null || true; done
    wait 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
  (cd "$ROOT_DIR/gateway-service" && OTEL_SERVICE_NAME=sentinel-gateway HOST=0.0.0.0 PORT="$GATEWAY_PORT" GATEWAY_STATE_FILE="$ROOT_DIR/gateway-service/data/state.json" npm run dev) & pids+=("$!")
  (cd "$ROOT_DIR/agent-service" && OTEL_SERVICE_NAME=sentinel-agent PORT="$AGENT_PORT" npm run dev) & pids+=("$!")
  sleep 1
  (cd "$ROOT_DIR/backend" && OTEL_SERVICE_NAME=sentinel-backend PORT="$BACKEND_PORT" npm run dev) & pids+=("$!")
  sleep 1
  (cd "$ROOT_DIR/frontend" && VITE_BACKEND_URL="$VITE_BACKEND_URL" VITE_GATEWAY_PORT="$GATEWAY_PORT" VITE_GATEWAY_URL="${VITE_GATEWAY_URL:-}" npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT") & pids+=("$!")
  wait
}

start_services() {
  if running_pid >/dev/null; then echo "本地服务已经在运行（supervisor PID $(read_pid)）"; status || true; return 0; fi
  rm -f "$PID_FILE"; check_ports
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "正在检查数据库迁移..."
  if ! npm --prefix "$ROOT_DIR/backend" run migrate >>"$LOG_FILE" 2>&1; then
    echo "数据库迁移失败，查看日志：$LOG_FILE" >&2
    return 1
  fi
  if command -v setsid >/dev/null 2>&1; then setsid "$ROOT_DIR/scripts/dev-local.sh" run >>"$LOG_FILE" 2>&1 & else "$ROOT_DIR/scripts/dev-local.sh" run >>"$LOG_FILE" 2>&1 & fi
  local pid=$!; echo "$pid" > "$PID_FILE"; sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then echo "本地服务启动失败，查看日志：$LOG_FILE" >&2; rm -f "$PID_FILE"; return 1; fi
  if ! wait_http "${GATEWAY_URL}/health" || ! wait_http "${AGENT_URL}/health" || ! wait_http "http://127.0.0.1:${BACKEND_PORT}/api/health" || ! wait_http "http://127.0.0.1:${FRONTEND_PORT}/"; then
    echo "本地服务未能全部就绪，正在清理；查看日志：$LOG_FILE" >&2
    stop_services
    return 1
  fi
  echo "本地服务已启动（supervisor PID $pid）"; status || true
}

case "${1:-start}" in
  start) start_services ;;
  stop) stop_services ;;
  restart) stop_services; start_services ;;
  status) status ;;
  run) run_services ;;
  *) echo "用法：$0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
