#!/usr/bin/env bash
# Serialized ESLint for the paths you own. Usage: scripts/dev/lint.sh <path> [<path>...]
set -uo pipefail
cd "$(dirname "$0")/../.."
source scripts/dev/env.sh
[ $# -ge 1 ] || { echo "usage: lint.sh <paths...>" >&2; exit 2; }
exec flock /tmp/rp-lint.lock pnpm exec eslint --max-warnings=0 "$@"
