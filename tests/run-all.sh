#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm run build
node tests/backend/state-table-cases.mjs
node tests/backend/migration-cases.mjs
bash tests/gateway/contract-cases.sh
bash tests/gateway/unified-users-cases.sh
bash tests/agent/contract-cases.sh
bash tests/agent/pipeline-cases.sh
bash tests/backend/integration-cases.sh
bash tests/frontend/playwright-cases.sh
npm run test:c3:only
echo 'All isolated contract, integration, and browser cases passed.'
