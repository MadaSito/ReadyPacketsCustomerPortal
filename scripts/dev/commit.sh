#!/usr/bin/env bash
# Serialized commit of ONLY the paths you own. Usage: scripts/dev/commit.sh "<message>" <path> [<path>...]
set -euo pipefail
cd "$(dirname "$0")/../.."
msg="$1"; shift
[ $# -ge 1 ] || { echo "usage: commit.sh \"message\" <paths...>" >&2; exit 2; }
exec 9>/tmp/rp-git.lock
flock 9
git add -- "$@"
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
git commit -q -m "$msg" -m "Co-authored-by: Perplexity <noreply@perplexity.ai>" -- "$@"
git log --oneline -1
