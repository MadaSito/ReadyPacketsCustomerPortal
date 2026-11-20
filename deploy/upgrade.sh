#!/usr/bin/env bash
# Usage: sudo bash deploy/upgrade.sh <reviewed-full-commit-sha>
set -euo pipefail
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")
source "$deploy_src/lib.sh"
[[ $# == 1 ]] || die 'usage: upgrade.sh <reviewed-full-commit-sha>'
lock_deploy
check_host
resolve_release "$1"
[[ -L "$base/current" && ! -e "$maintenance" && ! -e "$conf/upgrade-state" ]] ||
    die 'active installation required; reconcile any incomplete operation first'
old=$(readlink -f "$base/current")
[[ "$old" =~ ^"$base"/releases/[0-9a-f]{40}$ ]] || die 'unexpected current release layout'
[[ "$old" != "$release" ]] || die 'release is already installed'
[[ -L "$site" ]] || die 'the managed nginx site is required'
secret_ok migrator_database_url
secret_ok backup_database_url
secret_ok rp_backup_key
build_release

printf '%s\n' 'In the portal, enable Jobs maintenance and verify queue_drained with no unreconciled unknown attempts.'
confirm 'Have you verified the drain, stopped other writers and disabled the in-app backup schedule?' DRAINED
timer_enabled=no
if systemctl is-enabled --quiet "$timer"; then timer_enabled=yes; fi
phase=draining
record_phase() {
    printf 'phase=%s\nold=%s\ncandidate=%s\nbackup_timer_enabled=%s\n' "$phase" "$old" "$release" "$timer_enabled" > "$conf/upgrade-state"
}
record_phase
trap 'status=$?; if ((status != 0)); then printf "Upgrade interrupted (%s); keep traffic fenced. Follow INSTALL.md.\n" "$phase" >&2; fi' EXIT
touch "$maintenance"
systemctl disable --now "$timer"
systemctl disable "$web" "$worker"
systemctl stop "$web" "$worker"
for unit in "$web" "$worker"; do
    [[ $(systemctl show "$unit" -p ActiveState --value) == inactive &&
       $(systemctl show "$unit" -p Result --value) == success &&
       $(systemctl show "$unit" -p ExecMainCode --value) == 1 &&
       $(systemctl show "$unit" -p ExecMainStatus --value) == 0 ]] ||
        die "clean shutdown not proved for $unit; inspect its journal and fenced jobs"
done
for trigger in cli pre_upgrade; do
    [[ $(systemctl show "readypackets-backup@$trigger.service" -p ActiveState --value) == inactive ]] ||
        die 'an existing backup is running or failed; inspect its journal before proceeding'
done

phase=backup
record_phase
systemctl start readypackets-backup@pre_upgrade.service
journalctl --unit=readypackets-backup@pre_upgrade.service --lines=25 --no-pager
confirm 'Have you independently recorded the verified archive ID and secured a copy for recovery?' BACKUP-VERIFIED

phase=migration_started
record_phase
migrate_release "$release"
point_release "$old" previous
point_release "$release" current
phase=verifying
record_phase
systemctl start "$worker" "$web"
check_http local
check_http edge
confirm 'Have you checked the candidate service journals and approved reopening traffic? Jobs maintenance remains enabled.' REOPEN
systemctl enable "$worker" "$web"
if [[ "$timer_enabled" == yes ]]; then systemctl enable --now "$timer"; fi
rm -f -- "$maintenance" "$conf/upgrade-state"
printf 'Upgrade verified. Reconcile the Jobs maintenance view and clear maintenance with fresh MFA.\n'
