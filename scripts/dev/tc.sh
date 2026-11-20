#!/usr/bin/env bash
# Serialized whole-project typecheck. Usage: scripts/dev/tc.sh [path-filter-regex]
# With a filter, only diagnostics whose path matches are shown (other modules may be mid-edit).
set -uo pipefail
cd "$(dirname "$0")/../.."
source scripts/dev/env.sh
out=$(flock /tmp/rp-tc.lock node node_modules/typescript7/bin/tsc --noEmit --pretty false 2>&1)
if [ $# -ge 1 ]; then
  filtered=$(printf '%s\n' "$out" | grep -E "^($1)" || true)
  if [ -z "$filtered" ]; then echo "typecheck: no diagnostics matching '$1'"; exit 0; fi
  printf '%s\n' "$filtered"; exit 1
fi
if [ -z "$out" ]; then echo "typecheck: clean"; exit 0; fi
printf '%s\n' "$out"; exit 1
