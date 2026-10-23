#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer)."
  exit 1
fi
[ -d node_modules ] || npm install
exec node src/manager/index.js
