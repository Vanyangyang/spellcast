#!/usr/bin/env bash
# Unix wrapper. Windows / 跨平台请用：node scripts/start.mjs 或 npm start
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/start.mjs
