#!/usr/bin/env bash
# Shared non-sourcing helpers for ReadyPackets VPS installation, upgrade, and rollback scripts.
# Owner: recovery_ops_engineer.
#
# Security invariants:
#  - Never `source` or `eval` operator configuration files. `rp_load_env_file` parses `KEY=VALUE` strictly as data.
#  - Refuses world-readable or group/world-writable environment files.
#  - Verifies SHA-256 release archive checksums before unpacking any tarball.

set -euo pipefail
umask 077

rp_log() {
  local level="$1"
  shift
  printf '{"timestamp":"%s","level":"%s","component":"ops.install","message":"%s"}\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$*" >&2
}

rp_die() {
  local code="$1"
  shift
  rp_log "error" "$*"
  exit "$code"
}

# Check octal permissions on a sensitive config/secret file (must not be group-writable or world-accessible).
rp_assert_safe_file_mode() {
  local target="$1"
  [[ -f "$target" ]] || rp_die 78 "Required configuration file does not exist: ${target}"
  [[ ! -L "$target" ]] || rp_die 78 "Configuration file must not be a symlink: ${target}"

  local mode=""
  if stat --version >/dev/null 2>&1; then
    mode="$(stat -c '%a' "$target")"
  else
    mode="$(stat -f '%Lp' "$target")"
  fi

  # Pad to 3 digits and reject group-write (bit 2 in group) or any world bit != 0.
  mode="$(printf '%03d' "$((10#${mode}))")"
  local group_digit="${mode:1:1}"
  local other_digit="${mode:2:1}"

  if (( (group_digit & 2) != 0 )) || (( other_digit != 0 )); then
    rp_die 78 "Unsafe permissions (${mode}) on ${target}; expected 0600 or 0640."
  fi
}

# Parse a systemd-compatible KEY=VALUE data file WITHOUT sourcing or evaluating shell syntax.
rp_load_env_file() {
  local env_file="$1"
  rp_assert_safe_file_mode "$env_file"

  local line_no=0
  local raw_line=""
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    line_no=$((line_no + 1))
    # Reject CR or NUL control characters.
    if [[ "$raw_line" == *$'\r'* ]]; then
      rp_die 78 "CR character forbidden in ${env_file} at line ${line_no}."
    fi

    # Trim leading whitespace.
    local trimmed="${raw_line#"${raw_line%%[![:space:]]*}"}"
    if [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]]; then
      continue
    fi

    if [[ "$trimmed" != *=* ]]; then
      rp_die 78 "Malformed assignment in ${env_file} at line ${line_no} (expected KEY=VALUE)."
    fi

    local key="${trimmed%%=*}"
    local val="${trimmed#*=}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      rp_die 78 "Invalid variable identifier '${key}' in ${env_file} at line ${line_no}."
    fi

    # Reject shell command-substitution tokens (`...` or $(...)) rather than silently misinterpreting them.
    if [[ "$val" == *'`'* || "$val" == *'$('* ]]; then
      rp_die 78 "Shell command-substitution syntax forbidden in ${env_file} at line ${line_no}."
    fi

    # Strip matching optional outer double or single quotes without interpreting escapes as code.
    if [[ "${#val}" -ge 2 ]]; then
      if [[ "${val:0:1}" == '"' && "${val: -1}" == '"' ]]; then
        val="${val:1:${#val}-2}"
      elif [[ "${val:0:1}" == "'" && "${val: -1}" == "'" ]]; then
        val="${val:1:${#val}-2}"
      fi
    fi

    export "${key}=${val}"
  done <"$env_file"
}

# Verify SHA-256 of a release tarball against a known 64-hex digest.
rp_verify_sha256() {
  local archive="$1"
  local expected_hex="$2"

  [[ -f "$archive" ]] || rp_die 66 "Release archive not found: ${archive}"
  if [[ ! "$expected_hex" =~ ^[0-9a-fA-F]{64}$ ]]; then
    rp_die 64 "Expected SHA-256 checksum must be exactly 64 hexadecimal characters."
  fi

  local actual_hex=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hex="$(sha256sum -- "$archive" | awk '{print tolower($1)}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hex="$(shasum -a 256 -- "$archive" | awk '{print tolower($1)}')"
  else
    rp_die 69 "Neither sha256sum nor shasum is installed."
  fi

  local normalized_expected
  normalized_expected="$(printf '%s' "$expected_hex" | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual_hex" != "$normalized_expected" ]]; then
    rp_die 65 "Release archive SHA-256 mismatch for ${archive} (expected ${normalized_expected}, got ${actual_hex})."
  fi
}

# Atomically switch a directory symlink using ln -sfn + mv -Tf.
rp_atomic_symlink() {
  local target_dir="$1"
  local link_path="$2"
  local tmp_link="${link_path}.tmp.$$"

  ln -sfn -- "$target_dir" "$tmp_link"
  mv -Tf -- "$tmp_link" "$link_path"
}

# Poll a readiness endpoint with bounded retries.
rp_wait_http_ready() {
  local ready_url="$1"
  local max_attempts="${2:-20}"
  local delay_seconds="${3:-1}"

  local attempt=1
  while (( attempt <= max_attempts )); do
    if curl --silent --fail --max-time 3 "$ready_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
  return 1
}
