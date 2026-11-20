#!/usr/bin/env bash
# Code-Symlink Rollback Script for ReadyPackets Native VPS Profile.
# Owner: recovery_ops_engineer.
#
# Honest boundary:
#  - Atomically flips `/opt/readypackets/current` back to `/opt/readypackets/previous` (or `--to-release <id>`).
#  - Does NOT reverse forward-only database migrations or roll back database rows in place.
#  - Data/schema rollback requires restoring the pre-upgrade encrypted archive into an isolated database/storage
#    target (`scripts/ops/restore/restore-isolated.ts`) and performing controlled cutover per
#    `docs/runbooks/upgrade-rollback.md`.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/install/common.sh
source "${SCRIPT_DIR}/common.sh"

ROOT_PREFIX=""
TO_RELEASE=""
SANDBOX_MODE=0
READY_URL="http://127.0.0.1:5000/readyz"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT_PREFIX="${2:-}"
      shift 2
      ;;
    --to-release)
      TO_RELEASE="${2:-}"
      shift 2
      ;;
    --ready-url)
      READY_URL="${2:-}"
      shift 2
      ;;
    --sandbox-mode)
      SANDBOX_MODE=1
      shift
      ;;
    *)
      rp_die 64 "Unknown option: $1"
      ;;
  esac
done

APP_BASE="${ROOT_PREFIX}/opt/readypackets"
RELEASES_DIR="${APP_BASE}/releases"
CURRENT_LINK="${APP_BASE}/current"
PREVIOUS_LINK="${APP_BASE}/previous"

TARGET_DIR=""
if [[ -n "$TO_RELEASE" ]]; then
  if [[ ! "$TO_RELEASE" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
    rp_die 64 "Invalid --to-release '${TO_RELEASE}'."
  fi
  TARGET_DIR="${RELEASES_DIR}/${TO_RELEASE}"
else
  [[ -L "$PREVIOUS_LINK" ]] || rp_die 66 "No previous release symlink found at ${PREVIOUS_LINK}."
  TARGET_DIR="$(readlink "$PREVIOUS_LINK")"
fi

[[ -d "$TARGET_DIR" ]] || rp_die 66 "Rollback target release directory does not exist: ${TARGET_DIR}"

rp_log "warn" "Rolling back code symlink to ${TARGET_DIR}. Note: database migrations and data are NOT rolled back in place; use restore-isolated.ts for data/schema rollback."
rp_atomic_symlink "$TARGET_DIR" "$CURRENT_LINK"

if (( SANDBOX_MODE == 0 )); then
  systemctl restart readypackets-portal.service readypackets-worker.service
  rp_wait_http_ready "$READY_URL" 30 1 || rp_die 70 "Readiness check failed after code rollback."
fi

rp_log "info" "Code rollback to ${TARGET_DIR} completed"
