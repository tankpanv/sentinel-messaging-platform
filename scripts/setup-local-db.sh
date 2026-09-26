#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
[ -f "$ROOT_DIR/.env" ] && . "$ROOT_DIR/.env"
set +a
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${APP_DB_NAME:=sentinel}"
: "${APP_DB_USER:=sentinel}"
: "${APP_DB_PASSWORD:=sentinel}"
export PGHOST PGPORT PGUSER PGDATABASE
if ! command -v psql >/dev/null 2>&1; then echo 'psql 未安装，请先安装 PostgreSQL 客户端。' >&2; exit 1; fi
if ! pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then echo "PostgreSQL 未在 $PGHOST:$PGPORT 监听。请启动 PostgreSQL 或修改 .env。" >&2; exit 1; fi
psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
  ELSE
    ALTER ROLE ${APP_DB_USER} WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${APP_DB_NAME} OWNER ${APP_DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${APP_DB_NAME}')\gexec
SQL
DATABASE_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${PGHOST}:${PGPORT}/${APP_DB_NAME}" npm --prefix "$ROOT_DIR/backend" run migrate
