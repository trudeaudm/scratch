#!/usr/bin/env bash
# §9 mainnet rehearsal entrypoint — delegates to the Node orchestrator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  npm install --silent
fi
exec node run.mjs "$@"
