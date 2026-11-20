#!/usr/bin/env bash
# Idempotent Native VPS Installer for ReadyPackets Customer Portal.
# Owner: recovery_ops_engineer.
#
# Usage:
#   install-vps.sh \
#     --archive <path/to/readypackets-release.tar.gz> \
#     --sha256 <64-hex-sha256> \
#     --release-id <release-id> \
#     [--root <filesystem-prefix>] \
#     [--env-file <path>] \
#     [--sandbox-mode]
#
# Never contacts production or external registries unless `--install-deps` is needed for an unbundled archive.
# Never `source`s configuration files. Uses frozen lockfile if installing dependencies.

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
SECRETS_DIR="${ETC_DIR}/secrets"
DEFAULT_STORAGE_DIR="${ROOT_PREFIX}/var/lib/readypackets/storage"
DEFAULT_SANDBOX_DIR="${ROOT_PREFIX}/var/lib/readypackets-recovery"
RELEASES_DIR="${APP_BASE}/releases"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
CURRENT_LINK="${APP_BASE}/current"
TARGET_ENV_FILE="${ENV_FILE:-${ETC_DIR}/portal.env}"

rp_log "info" "Verifying release archive SHA-256 before extraction"
rp_verify_sha256 "$ARCHIVE_PATH" "$EXPECTED_SHA256"

if (( SANDBOX_MODE == 0 )); then
  [[ "$(id -u)" -eq 0 ]] || rp_die 77 "install-vps.sh requires root privileges unless --sandbox-mode is set."
  if ! getent group readypackets >/dev/null 2>&1; then
    groupadd --system readypackets
  fi
  if ! id -u readypackets >/dev/null 2>&1; then
    useradd --system --gid readypackets --home-dir /nonexistent --shell /usr/sbin/nologin readypackets
  fi
fi

install -d -m 0755 "$APP_BASE" "$RELEASES_DIR"
install -d -m 0750 "$ETC_DIR"
install -d -m 0750 "$SECRETS_DIR"
install -d -m 0700 "$DEFAULT_STORAGE_DIR" "$DEFAULT_SANDBOX_DIR"

if (( SANDBOX_MODE == 0 )); then
  chown root:readypackets "$ETC_DIR" "$SECRETS_DIR"
  chown readypackets:readypackets "$DEFAULT_STORAGE_DIR" "$DEFAULT_SANDBOX_DIR"
fi

# Parse operator env file strictly as data (never sourced).
rp_load_env_file "$TARGET_ENV_FILE"

if [[ -n "${RP_STORAGE_DIR:-}" ]]; then
  install -d -m 0700 "$RP_STORAGE_DIR"
  (( SANDBOX_MODE == 0 )) && chown readypackets:readypackets "$RP_STORAGE_DIR" || true
fi
if [[ -n "${RP_RECOVERY_SANDBOX_DIR:-}" ]]; then
  install -d -m 0700 "$RP_RECOVERY_SANDBOX_DIR"
  (( SANDBOX_MODE == 0 )) && chown readypackets:readypackets "$RP_RECOVERY_SANDBOX_DIR" || true
fi

# Idempotent unpack into immutable release directory.
if [[ ! -d "$RELEASE_DIR" ]]; then
  STAGE_DIR="${RELEASES_DIR}/.staging-${RELEASE_ID}.$$"
  install -d -m 0755 "$STAGE_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$STAGE_DIR"
  if [[ ! -d "${STAGE_DIR}/node_modules" && -f "${STAGE_DIR}/pnpm-lock.yaml" ]]; then
    if (( SANDBOX_MODE == 0 )); then
      rp_log "info" "Installing production dependencies with frozen lockfile"
      (cd "$STAGE_DIR" && pnpm install --frozen-lockfile --prod)
    fi
  fi
  mv -- "$STAGE_DIR" "$RELEASE_DIR"
else
  rp_log "info" "Release directory ${RELEASE_DIR} already unpacked; continuing idempotently"
fi

if (( SANDBOX_MODE == 0 )); then
  rp_log "info" "Validating configuration via scripts/ops/keys/doctor.ts"
  (cd "$RELEASE_DIR" && pnpm tsx scripts/ops/keys/doctor.ts >/dev/null)
  rp_log "info" "Applying forward-only database migrations"
  (cd "$RELEASE_DIR" && pnpm tsx scripts/ops/migrate.ts)
fi

rp_atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"

if (( SANDBOX_MODE == 0 )); then
  if [[ -f "${RELEASE_DIR}/deploy/systemd/readypackets-portal.service" ]]; then
    install -m 0644 "${RELEASE_DIR}/deploy/systemd/readypackets-portal.service" /etc/systemd/system/readypackets-portal.service
    install -m 0644 "${RELEASE_DIR}/deploy/systemd/readypackets-worker.service" /etc/systemd/system/readypackets-worker.service
    systemctl daemon-reload
    systemctl enable --now readypackets-portal.service readypackets-worker.service
  fi
  rp_log "info" "Waiting for readiness probe at ${READY_URL}"
  rp_wait_http_ready "$READY_URL" 30 1 || rp_die 70 "Readiness check failed after initial installation."
fi

rp_log "info" "Installation of release ${RELEASE_ID} completed"
