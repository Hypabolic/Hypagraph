#!/bin/bash
# Preferred way to load Hypagraph in this checkout:
#   pi -e ./extensions/hypagraph.ts --skill ./skills
#
# This script only prints the recommended command (package install is optional).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not on PATH" >&2
  exit 1
fi

if [[ ! -f "$ROOT/extensions/hypagraph.ts" ]]; then
  echo "Missing extensions/hypagraph.ts" >&2
  exit 1
fi

echo "Load Hypagraph with:"
echo "  cd $ROOT"
echo "  pi -e ./extensions/hypagraph.ts --skill ./skills"
echo ""
echo "Smoke-check tools:"
echo "  pi -e ./extensions/hypagraph.ts --skill ./skills -p --no-session 'Reply YES if hypagoal_start is available. Do not call tools.'"
