#!/usr/bin/env bash
# ReadyPackets native release upgrade (Ubuntu 24.04 LTS / 26.04 LTS).
#
# Usage:
#   sudo bash deploy/upgrade.sh [--yes] <reviewed-full-commit-sha>
#
# Interactive by default: pauses at DRAINED, BACKUP-VERIFIED and REOPEN while enforcing every machine
# invariant (root custody, checked-out commit match, clean service drain, verified pre-upgrade archive
# on disk, migrations, Nginx config test and loopback/edge readiness). Pass --yes only for non-interactive
# automation after completing the operator pre-checks in docs/operations/UPGRADE.md.
set -euo pipefail
set +x
export PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin LC_ALL=C.UTF-8
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")

if [[ $EUID == 0 ]]; then
    custody_top=$(realpath -- "$deploy_src/..")
    custody_dir=$custody_top
    while :; do
        custody_mode=$(stat -c '%u:%A' -- "$custody_dir")
        if [[ ! $custody_mode =~ ^0:d....-..-. ]] &&
           [[ $custody_dir == "$custody_top" || ! $custody_mode =~ ^0:d........[tT]$ ]]; then
            printf 'ReadyPackets: %s (owner:mode %s) must belong to root and must not be writable by anyone else.\nUpdate the source clone as root with umask 022:\n  sudo sh -c "umask 022 && cd /opt/readypackets-src && git fetch --prune origin && git checkout --detach <commit>"\n' \
                "$custody_dir" "$custody_mode" >&2
            exit 1
        fi
        [[ $custody_dir != / ]] || break
        custody_dir=$(dirname -- "$custody_dir")
    done
    custody_bad=$(find "$custody_top" \( ! -user root -o -perm /022 -o ! \( -type d -o -type f \) \) -print -quit)
    if [[ -n $custody_bad ]]; then
        printf 'ReadyPackets: the source clone contains a non-root, group/world-writable, or non-regular entry (%s, %s).\nRepair or re-clone as root with umask 022 before upgrading.\n' \
            "$custody_bad" "$(stat -c '%u:%A' -- "$custody_bad")" >&2
        exit 1
    fi
    unset custody_top custody_dir custody_bad custody_mode
fi

# shellcheck source=deploy/lib.sh
source "$deploy_src/lib.sh"

usage() {
    cat <<'USAGE'
Usage:
  sudo bash deploy/upgrade.sh [--yes] <reviewed-full-commit-sha>

Options:
  --yes, -y   Skip interactive confirmation prompts (all custody, drain, backup and health gates still run)
  -h, --help  Show this help text
USAGE
}

assume_yes=0
target_ref=''
while (($#)); do
    case $1 in
        --yes|-y) assume_yes=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --*) usage >&2; exit 64 ;;
        *)
            [[ -z $target_ref ]] || { usage >&2; exit 64; }
            target_ref=$1
            shift
            ;;
    esac
done
[[ -n $target_ref ]] || { usage >&2; exit 64; }

lock_deploy
if ((!assume_yes)); then
    [[ -r /dev/tty && -w /dev/tty ]] || die 'no interactive terminal; pass --yes only after completing docs/operations/UPGRADE.md pre-checks'
fi
check_host
resolve_release "$target_ref"

head_commit=$(git -C "$repo" rev-parse --verify HEAD)
[[ "$head_commit" == "$commit" ]] ||
    die "checked-out HEAD ($head_commit) does not match target commit ($commit); check out $commit in $repo first so matching deploy templates and units are used"
[[ -z $(git -C "$repo" status --porcelain --untracked-files=no) ]] ||
    die "tracked files in $repo are modified; reset or clean the repository before upgrading"

[[ -L "$base/current" && ! -e "$maintenance" && ! -e "$conf/upgrade-state" ]] ||
    die 'active installation required; reconcile any incomplete operation first'
old=$(readlink -f "$base/current")
[[ "$old" =~ ^"$base"/releases/[0-9a-f]{40}$ ]] || die 'unexpected current release layout'
[[ "$old" != "$release" ]] || die 'release is already installed'
[[ -L "$site" ]] || die 'the managed nginx site is required'
# The web server files are rendered again further down; what they need is checked before anything is stopped.
grep -qxF "RP_CANONICAL_ORIGIN=https://$origin" "$conf/portal.env" ||
    die "the environment file and $site_conf name different portal hosts"
[[ -r "$tls_dir/fullchain.pem" && -r "$tls_dir/privkey.pem" ]] ||
    die "the web certificate is missing from $tls_dir"
nginx -t 2>/dev/null || die 'the current web server configuration does not pass "nginx -t"; repair it before upgrading'
prepare_dirs
credentials_ok
secret_ok rp_backup_key
assert_service_identity

# Re-enable the installer-managed swap file if present and currently inactive so low-RAM hosts can build safely.
swap_file=/swapfile.readypackets
if [[ -f $swap_file && ! -L $swap_file && $(stat -c '%a:%u:%h' -- "$swap_file") == 600:0:1 ]]; then
    if ! swapon --show=NAME --noheadings | grep -qxF -- "$swap_file"; then
        swapon -- "$swap_file" 2>/dev/null || true
    fi
fi

# Verify disk headroom before building or stopping services.
if [[ ! -d "$release" ]]; then
    opt_free_kb=$(df --output=avail -k "$base/releases" | tail -1 | tr -d ' ')
    ((opt_free_kb >= 3000000)) ||
        die "at least 3 GB of free space is required on $(df --output=target "$base/releases" | tail -1) to stage and build the release"
fi
storage_used_kb=$(du -sk -- "$storage" 2>/dev/null | awk '{ print $1 }')
storage_used_kb=${storage_used_kb:-0}
var_needed_kb=$((storage_used_kb * 2 + 1048576))
var_free_kb=$(df --output=avail -k "$storage" | tail -1 | tr -d ' ')
((var_free_kb >= var_needed_kb)) ||
    die "at least $((var_needed_kb / 1024)) MB of free space is required on $(df --output=target "$storage" | tail -1) for the pre-upgrade backup"

install_media_tools

db_schema=$("$node" -e '
const fs = require("node:fs");
const u = new URL(fs.readFileSync(0, "utf8").trim());
const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) process.exit(1);
process.stdout.write(name);
' < "$conf/secrets/database_url") || die 'could not read schema name from database_url'
mysql_schema() { mysql --no-defaults --protocol=socket --batch --raw --skip-column-names "$db_schema" "$@"; }

build_release

maint_active=$(mysql_schema -e 'SELECT COALESCE((SELECT active FROM job_maintenance WHERE id = 1), 0)')
running_jobs=$(mysql_schema -e "SELECT COUNT(*) FROM job_runs WHERE state = 'running'")
unknown_jobs=$(mysql_schema -e "SELECT COUNT(*) FROM job_runs WHERE state = 'unknown' AND reconciled_at IS NULL")
((unknown_jobs == 0)) ||
    die "there are $unknown_jobs unresolved 'unknown' job attempt(s) in job_runs; reconcile them in Administration -> Jobs (/admin/jobs) before upgrading"

if ((assume_yes && running_jobs > 0 && maint_active == 1)); then
    for _ in $(seq 1 30); do
        sleep 1
        running_jobs=$(mysql_schema -e "SELECT COUNT(*) FROM job_runs WHERE state = 'running'")
        ((running_jobs == 0)) && break
    done
fi

printf '\nUpgrade pre-drain summary:\n'
printf '  Current release    : %s\n' "${old##*/}"
printf '  Target release     : %s\n' "$commit"
printf '  Portal maintenance : %s\n' "$( ((maint_active == 1)) && printf 'on' || printf 'off' )"
printf '  Running jobs       : %s\n' "$running_jobs"
printf '  Unresolved unknown : %s\n\n' "$unknown_jobs"

if ((!assume_yes)); then
    printf '%s\n' 'Recommended before fencing traffic (when an administrator has enrolled MFA):'
    printf '%s\n' '  Open Administration -> Maintenance (/admin/maintenance), click "Start maintenance", and confirm Drain status reads "Queue drained".'
    confirm 'Have you verified no external writers are active and approved fencing public traffic now?' DRAINED
fi

timer_enabled=no
if systemctl is-enabled --quiet "$timer"; then timer_enabled=yes; fi
phase=draining
record_phase() {
    local state
    state=$(mktemp "$conf/.upgrade-state.XXXXXXXX")
    printf 'phase=%s\nold=%s\ncandidate=%s\nbackup_timer_enabled=%s\n' "$phase" "$old" "$release" "$timer_enabled" > "$state"
    mv -fT -- "$state" "$conf/upgrade-state"
}
record_phase
on_upgrade_exit() {
    local status=$?
    if ((status != 0)); then
        touch "$maintenance" || true
        if [[ "$phase" == migration_started || "$phase" == verifying ]]; then
            systemctl disable --now "$timer" "$web" "$worker" || true
        fi
        printf 'Upgrade interrupted (%s); keep traffic fenced. Follow docs/operations/UPGRADE.md.\n' "$phase" >&2
    fi
}
trap on_upgrade_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
touch "$maintenance"
systemctl disable --now "$timer"
# Stop first, read the exit record, disable afterwards. systemd forgets the exit record of a stopped unit as
# soon as nothing refers to it any more, and "disable" removes the last reference (multi-user.target).
systemctl stop "$web" "$worker"
for unit in "$web" "$worker"; do
    stop_record=$(systemctl show "$unit" -p ActiveState -p Result -p ExecMainCode -p ExecMainStatus | sort | tr '\n' ' ')
    # ExecMainCode=1 is "exited by itself" (not killed by a signal); ExecMainStatus=0 is its exit status.
    [[ $stop_record == 'ActiveState=inactive ExecMainCode=1 ExecMainStatus=0 Result=success ' ]] ||
        die "clean shutdown not proved for $unit (${stop_record% }); inspect its journal and fenced jobs"
done
systemctl disable "$web" "$worker"
running_jobs=$(mysql_schema -e "SELECT COUNT(*) FROM job_runs WHERE state = 'running'")
unknown_jobs=$(mysql_schema -e "SELECT COUNT(*) FROM job_runs WHERE state = 'unknown' AND reconciled_at IS NULL")
((running_jobs == 0 && unknown_jobs == 0)) ||
    die "queue is not cleanly drained after stopping services (running=$running_jobs, unknown=$unknown_jobs); inspect job_runs before upgrading"

for trigger in cli pre_upgrade; do
    [[ $(systemctl show "readypackets-backup@$trigger.service" -p ActiveState --value) == inactive ]] ||
        die 'an existing backup is running or failed; inspect its journal before proceeding'
done

phase=backup
record_phase
prev_backup_id=$(mysql_schema -e 'SELECT COALESCE(MAX(id), 0) FROM backup_archives')
[[ $prev_backup_id =~ ^[0-9]+$ ]] || die 'could not read backup_archives watermark'
systemctl start readypackets-backup@pre_upgrade.service
journalctl --unit=readypackets-backup@pre_upgrade.service --lines=25 --no-pager

backup_pub_id='' backup_key='' backup_sha='' backup_bytes=''
IFS=$'\t' read -r backup_pub_id backup_key backup_sha backup_bytes < <(
    mysql_schema -e "SELECT public_id, COALESCE(storage_key, ''), COALESCE(archive_sha256, ''), COALESCE(encrypted_size_bytes, 0) FROM backup_archives WHERE id > $prev_backup_id AND trigger_kind = 'pre_upgrade' AND state = 'completed' AND verification_status = 'verified' ORDER BY id DESC LIMIT 1"
) || true
[[ -n $backup_pub_id && $backup_key =~ ^backups/[0-9a-f]{32}$ && $backup_sha =~ ^[0-9a-f]{64}$ && $backup_bytes =~ ^[1-9][0-9]*$ ]] ||
    die 'pre-upgrade backup did not record a completed, verified archive in backup_archives'
backup_path="$storage/$backup_key"
[[ ! -L "$backup_path" && -f "$backup_path" && $(stat -c '%s' -- "$backup_path") == "$backup_bytes" ]] ||
    die "verified pre-upgrade archive file is missing or size-mismatched on disk: $backup_path"

printf '\nVerified pre-upgrade encrypted backup:\n'
printf '  Backup ID      : %s\n' "$backup_pub_id"
printf '  Encrypted file : %s (%s bytes)\n' "$backup_path" "$backup_bytes"
printf '  SHA-256        : %s\n' "$backup_sha"
printf '  Backup key     : %s/secrets/rp_backup_key (keep a separate off-host copy; never stored inside the archive)\n\n' "$conf"

if ((!assume_yes)); then
    confirm 'Have you recorded the verified backup ID and copied the encrypted file (plus rp_backup_key if needed) off-host?' BACKUP-VERIFIED
fi

phase=migration_started
record_phase
migrate_release "$release"
point_release "$old" previous
point_release "$release" current
phase=verifying
record_phase
install_unit_files
# The Nginx files come from the release's templates too; the site stays fenced while they are replaced.
render_site "$deploy_src/nginx/readypackets-edge.conf.template" "$nginx_dir/snippets/readypackets-edge.conf"
render_site "$deploy_src/nginx/readypackets-tls.conf.template" "$nginx_dir/snippets/readypackets-tls.conf"
render_site "$deploy_src/nginx/readypackets-portal.conf.template" "$nginx_dir/sites-available/readypackets-portal.conf"
nginx -t
systemctl reload nginx
systemctl start "$worker" "$web"
check_http local
check_http edge
if ((!assume_yes)); then
    confirm 'Candidate services passed local and edge health checks while public traffic remains fenced. Reopen public traffic now?' REOPEN
fi
systemctl enable "$worker" "$web"
if [[ "$timer_enabled" == yes ]]; then systemctl enable --now "$timer"; fi
rm -f -- "$maintenance" "$conf/upgrade-state"

maint_active=$(mysql_schema -e 'SELECT COALESCE((SELECT active FROM job_maintenance WHERE id = 1), 0)')
if ((maint_active == 1)); then
    printf 'Upgrade verified and public traffic is open. Open Administration -> Maintenance (/admin/maintenance) and click "End maintenance" with fresh MFA so background workers resume.\n'
else
    printf 'Upgrade verified and public traffic is open.\n'
fi
