#!/usr/bin/env bash
# Concurrency-limited test runner (the sandbox has 2 cores shared by the whole team).
# Usage: scripts/dev/test.sh <path-or-filter> [more vitest args]
set -uo pipefail
cd "$(dirname "$0")/../.."
source scripts/dev/env.sh
slot=$(( RANDOM % 2 ))
exec flock "/tmp/rp-test-$slot.lock" pnpm exec vitest run --maxWorkers=1 "$@"
