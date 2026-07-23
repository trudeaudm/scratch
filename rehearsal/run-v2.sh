#!/usr/bin/env bash
# v2 mainnet rehearsal entrypoint — delegates to run-v2.mjs (Deploy3 stack).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  npm install --silent
fi
exec node --use-system-ca run-v2.mjs "$@"
