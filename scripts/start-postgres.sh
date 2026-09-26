#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${POSTGRES_CONTAINER_NAME:=sentinel-postgres-local}"
: "${POSTGRES_IMAGE:=postgres:16-alpine}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_ADMIN_USER:=postgres}"
: "${POSTGRES_ADMIN_PASSWORD:=postgres}"
POSTGRES_ADMIN_PASSWORD_FROM_ENV="${POSTGRES_ADMIN_PASSWORD_FROM_ENV:-$POSTGRES_ADMIN_PASSWORD}"
: "${POSTGRES_DB:=sentinel}"
: "${POSTGRES_APP_USER:=sentinel}"
: "${POSTGRES_APP_PASSWORD:=sentinel}"
: "${POSTGRES_VOLUME:=sentinel-postgres-data}"
for db_identifier in "$POSTGRES_ADMIN_USER" "$POSTGRES_DB" "$POSTGRES_APP_USER"; do
  [[ "$db_identifier" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || { echo "错误：数据库名和用户名只允许字母、数字、下划线。" >&2; exit 1; }
done
[[ "$POSTGRES_APP_PASSWORD" != *"'"* ]] || { echo "错误：应用密码不能包含单引号。" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || { echo "错误：未找到 docker，请先安装并启动 Docker。" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "错误：Docker daemon 未运行。" >&2; exit 1; }

echo "[1/6] 拉取 PostgreSQL 镜像: $POSTGRES_IMAGE"
docker pull "$POSTGRES_IMAGE" >/dev/null

# 如果指定宿主端口已被现有 PostgreSQL 容器占用，复用该容器，避免破坏其他本地项目。
existing_container="$(docker ps --filter "publish=${POSTGRES_PORT}" --filter "status=running" --format '{{.Names}}' | head -n1 || true)"
if [[ -n "$existing_container" && "$existing_container" != "$POSTGRES_CONTAINER_NAME" ]]; then
  existing_image="$(docker inspect "$existing_container" --format '{{.Config.Image}}' 2>/dev/null || true)"
  if [[ "$existing_image" == postgres* || "$existing_image" == *postgres* ]]; then
    echo "检测到端口 ${POSTGRES_PORT} 已由 PostgreSQL 容器 $existing_container 使用，复用该容器。"
    POSTGRES_CONTAINER_NAME="$existing_container"
    existing_password="$(docker inspect "$existing_container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n1 || true)"
    if [[ -n "$existing_password" && ( -z "${POSTGRES_ADMIN_PASSWORD_FROM_ENV:-}" || "${POSTGRES_ADMIN_PASSWORD_FROM_ENV}" == "postgres" ) ]]; then
      POSTGRES_ADMIN_PASSWORD="$existing_password"
    fi
  fi
fi

echo "[2/6] 准备 PostgreSQL 数据卷: $POSTGRES_VOLUME"
docker volume create "$POSTGRES_VOLUME" >/dev/null

if [[ "$(docker inspect -f '{{.State.Status}}' "$POSTGRES_CONTAINER_NAME" 2>/dev/null || true)" == "created" ]]; then docker rm "$POSTGRES_CONTAINER_NAME" >/dev/null; fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$POSTGRES_CONTAINER_NAME"; then
  echo "[3/6] 复用容器: $POSTGRES_CONTAINER_NAME"
  docker start "$POSTGRES_CONTAINER_NAME" >/dev/null 2>&1 || true
else
  echo "[3/6] 创建容器: $POSTGRES_CONTAINER_NAME"
  docker run -d \
    --name "$POSTGRES_CONTAINER_NAME" \
    --restart unless-stopped \
    -e POSTGRES_USER="$POSTGRES_ADMIN_USER" \
    -e POSTGRES_PASSWORD="$POSTGRES_ADMIN_PASSWORD" \
    -e POSTGRES_DB=postgres \
    -p "${POSTGRES_PORT}:5432" \
    -v "$POSTGRES_VOLUME:/var/lib/postgresql/data" \
    "$POSTGRES_IMAGE" >/dev/null
fi

echo "[4/6] 等待 PostgreSQL 就绪"
for attempt in $(seq 1 60); do
  if docker exec "$POSTGRES_CONTAINER_NAME" pg_isready -U "$POSTGRES_ADMIN_USER" -d postgres >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then
    docker logs --tail 80 "$POSTGRES_CONTAINER_NAME" >&2 || true
    echo "错误：PostgreSQL 60 秒内未就绪。" >&2
    exit 1
  fi
  sleep 1
done

# 通过容器内 socket 执行，避免宿主机没有 psql 客户端或认证配置不同。
echo "[5/6] 创建数据库和应用用户"
docker exec -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$POSTGRES_CONTAINER_NAME" \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_ADMIN_USER" -d postgres \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$POSTGRES_APP_USER') THEN CREATE ROLE $POSTGRES_APP_USER LOGIN PASSWORD '$POSTGRES_APP_PASSWORD'; ELSE ALTER ROLE $POSTGRES_APP_USER WITH LOGIN PASSWORD '$POSTGRES_APP_PASSWORD'; END IF; END \$\$;"
if ! docker exec -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$POSTGRES_CONTAINER_NAME" psql -U "$POSTGRES_ADMIN_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'" | grep -q 1; then
  docker exec -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$POSTGRES_CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_ADMIN_USER" -d postgres -c "CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_APP_USER"
fi

echo "[6/6] 验证应用账号连接并执行迁移"
docker exec \
  -e PGPASSWORD="$POSTGRES_APP_PASSWORD" \
  "$POSTGRES_CONTAINER_NAME" \
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_APP_USER" -d "$POSTGRES_DB" -c 'select current_database(), current_user;' >/dev/null

APP_DATABASE_URL="postgresql://${POSTGRES_APP_USER}:${POSTGRES_APP_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
DATABASE_URL="$APP_DATABASE_URL" \
  npm --prefix "$ROOT_DIR/backend" run migrate

if [[ ! -f "$ENV_FILE" ]]; then cp "$ROOT_DIR/.env.example" "$ENV_FILE"; fi
# 只更新本地开发连接配置，保留其他环境变量。
python3 - "$ENV_FILE" "$APP_DATABASE_URL" <<'PY'
from pathlib import Path
import re, sys
path, database_url = Path(sys.argv[1]), sys.argv[2]
text = path.read_text() if path.exists() else ''
line = f'DATABASE_URL={database_url}'
if re.search(r'^DATABASE_URL=.*$', text, re.MULTILINE):
    text = re.sub(r'^DATABASE_URL=.*$', line, text, flags=re.MULTILINE)
else:
    text += ('\n' if text and not text.endswith('\n') else '') + line + '\n'
path.write_text(text)
PY

echo
echo "PostgreSQL 已启动并验证成功。"
echo "容器: $POSTGRES_CONTAINER_NAME"
echo "连接: $APP_DATABASE_URL"
echo "下一步可执行: npm run dev"
