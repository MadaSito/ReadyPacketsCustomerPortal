#!/usr/bin/env bash
# Idempotent Native VPS Upgrade Script for ReadyPackets Customer Portal.
# Owner: recovery_ops_engineer.
#
# Workflow:
#  1. Verify SHA-256 checksum of new release archive before touching running state.
#  2. Parse `/etc/readypackets/portal.env` strictly as data (never `source`d).
#  3. Unpack candidate release under `/opt/readypackets/releases/<release-id>` (frozen lockfile if unbundled).
#  4. Validate config (`doctor.ts`) against candidate release.
#  5. Stop worker gracefully (drain) and execute mandatory pre-upgrade encrypted backup + byte-level verification.
#     Refuses and aborts upgrade if the encrypted backup or verification fails.
#  6. Apply forward-only database migrations (`scripts/ops/migrate.ts`).
#  7. Record `/opt/readypackets/previous` symlink, atomically flip `/opt/readypackets/current`, restart services.
#  8. Probe `/readyz`; if readiness fails, automatically roll back the `current` code symlink and emit an explicit
#     operator warning regarding forward-only schema migrations vs isolated restore cutover.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/install/common.sh
source "${SCRIPT_DIR}/common.sh"

ARCHIVE_PATH=""
EXPECTED_SHA256=""
RELEASE_ID=""
ROOT_PREFIX=""
ENV_FILE=""
SANDBOX_MODE=0
READY_URL="http://127.0.0.1:5000/readyz"
BACKUP_HOOK_CMD=""
HEALTH_HOOK_CMD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_PATH="${2:-}"
      shift 2
      ;;
    --sha256)
      EXPECTED_SHA256="${2:-}"
      shift 2
      ;;
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --root)
      ROOT_PREFIX="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
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
    --sandbox-backup-cmd)
      BACKUP_HOOK_CMD="${2:-}"
      shift 2
      ;;
    --sandbox-health-cmd)
      HEALTH_HOOK_CMD="${2:-}"
      shift 2
      ;;
    *)
      rp_die 64 "Unknown option: $1"
      ;;
  esac
done

[[ -n "$ARCHIVE_PATH" && -n "$EXPECTED_SHA256" && -n "$RELEASE_ID" ]] || \
  rp_die 64 "Required flags: --archive <tar.gz> --sha256 <hex64> --release-id <id>"

if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
  rp_die 64 "Invalid --release-id '${RELEASE_ID}'."
fi

APP_BASE="${ROOT_PREFIX}/opt/readypackets"
ETC_DIR="${ROOT_PREFIX}/etc/readypackets"
RELEASES_DIR="${APP_BASE}/releases"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
CURRENT_LINK="${APP_BASE}/current"
PREVIOUS_LINK="${APP_BASE}/previous"
TARGET_ENV_FILE="${ENV_FILE:-${ETC_DIR}/portal.env}"

[[ -L "$CURRENT_LINK" ]] || rp_die 66 "No existing installation symlink at ${CURRENT_LINK}; run install-vps.sh first."
PRIOR_RELEASE_DIR="$(readlink "$CURRENT_LINK")"

rp_log "info" "Verifying candidate release SHA-256"
rp_verify_sha256 "$ARCHIVE_PATH" "$EXPECTED_SHA256"
rp_load_env_file "$TARGET_ENV_FILE"

if [[ ! -d "$RELEASE_DIR" ]]; then
  STAGE_DIR="${RELEASES_DIR}/.staging-${RELEASE_ID}.$$"
  install -d -m 0755 "$STAGE_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$STAGE_DIR"
  if [[ ! -d "${STAGE_DIR}/node_modules" && -f "${STAGE_DIR}/pnpm-lock.yaml" && $SANDBOX_MODE -eq 0 ]]; then
    (cd "$STAGE_DIR" && pnpm install --frozen-lockfile --prod)
  fi
  mv -- "$STAGE_DIR" "$RELEASE_DIR"
fi

if (( SANDBOX_MODE == 0 )); then
  rp_log "info" "Validating candidate configuration via doctor.ts"
  (cd "$RELEASE_DIR" && pnpm tsx scripts/ops/keys/doctor.ts >/dev/null)

  rp_log "info" "Draining readypackets-worker.service prior to pre-upgrade backup"
  systemctl stop readypackets-worker.service

  rp_log "info" "Taking mandatory pre-upgrade encrypted backup + byte-level verification"
  if ! (cd "$PRIOR_RELEASE_DIR" && pnpm tsx scripts/ops/backup/run-backup.ts --trigger pre_upgrade --verify); then
    systemctl start readypackets-worker.service || true
    rp_die 75 "Pre-upgrade encrypted backup or verification failed; aborting upgrade before schema change."
  fi

  rp_log "info" "Applying forward-only database migrations from candidate release"
  (cd "$RELEASE_DIR" && pnpm tsx scripts/ops/migrate.ts)
else
  if [[ -n "$BACKUP_HOOK_CMD" ]]; then
    "$BACKUP_HOOK_CMD" || rp_die 75 "Sandbox pre-upgrade backup hook failed; aborting upgrade."
  fi
fi

# Preserve previous symlink and atomically flip current.
rp_atomic_symlink "$PRIOR_RELEASE_DIR" "$PREVIOUS_LINK"
rp_atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"

READY_OK=1
if (( SANDBOX_MODE == 0 )); then
  systemctl restart readypackets-portal.service
  systemctl start readypackets-worker.service
  if ! rp_wait_http_ready "$READY_URL" 30 1; then
    READY_OK=0
  fi
elif [[ -n "$HEALTH_HOOK_CMD" ]]; then
  if ! "$HEALTH_HOOK_CMD"; then
    READY_OK=0
  fi
fi

if (( READY_OK == 0 )); then
  rp_log "error" "Post-upgrade readiness check failed; rolling code symlink back to ${PRIOR_RELEASE_DIR}"
  rp_atomic_symlink "$PRIOR_RELEASE_DIR" "$CURRENT_LINK"
  if (( SANDBOX_MODE == 0 )); then
    systemctl restart readypackets-portal.service readypackets-worker.service || true
  fi
  rp_die 70 "Upgrade failed health verification. Code symlink rolled back; forward-only DB migrations are NOT reversed automatically — consult docs/runbooks/upgrade-rollback.md for isolated restore cutover if schema rollback is required."
fi

rp_log "info" "Upgrade to release ${RELEASE_ID} completed and verified ready"
