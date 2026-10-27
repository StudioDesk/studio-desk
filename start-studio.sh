#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! node -e "if(Number(process.versions.node.split('.')[0])<24) process.exit(1)"; then
  echo "Install Node.js 24 or later from https://nodejs.org/ and run this launcher again."
  exit 1
fi
exec node scripts/supervisor.mjs
