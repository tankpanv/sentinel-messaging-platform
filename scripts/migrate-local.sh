#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then set -a; source "$ROOT_DIR/.env"; set +a; fi
: "${DATABASE_URL:=postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel}"
export DATABASE_URL
npm --prefix "$ROOT_DIR/backend" run migrate
