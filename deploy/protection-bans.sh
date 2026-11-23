#!/usr/bin/env bash
# Run the signed-off release's offline protection tool; see docs/operations/BREAK_GLASS.md.
set -euo pipefail
set +x
export PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin
[[ $EUID == 0 ]] || { printf '%s\n' 'ReadyPackets: run as root from the reviewed native deployment checkout.' >&2; exit 1; }
deploy_src=$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")
# shellcheck source=deploy/lib.sh
source "$deploy_src/lib.sh"
if [[ $# == 1 && $1 == list ]] || [[ $# == 2 && $1 == clear && ( $2 == --all || $2 =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ) ]]; then
    lock_deploy
    ops_run --pipe "$node" dist/ops/protection-bans.js "$@" </dev/null
else
    printf '%s\n' 'Usage: sudo bash deploy/protection-bans.sh list | clear <publicId> | clear --all' >&2
    exit 64
fi
