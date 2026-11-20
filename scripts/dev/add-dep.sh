#!/usr/bin/env bash
# Serialized dependency add. Usage: scripts/dev/add-dep.sh [-D] <pkg> [<pkg>...]
# Record the reason in docs/engineering/DEPENDENCIES.md. Prefer node: built-ins and existing deps.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/dev/env.sh
exec flock /tmp/rp-pnpm.lock pnpm add "$@"
