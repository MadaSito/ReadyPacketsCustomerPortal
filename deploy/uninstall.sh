#!/usr/bin/env bash
# Deactivation only: deliberately offers no data-purge operation.
set -euo pipefail
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")
source "$deploy_src/lib.sh"
[[ $# == 0 ]] || die 'usage: uninstall.sh'
lock_deploy
confirm 'Disable ReadyPackets services and nginx site? Data, releases, keys and backups will be retained.' UNINSTALL
for unit in "$timer" "$web" "$worker"; do
    if [[ -f "$unit_dir/$unit" ]]; then systemctl disable --now "$unit"; fi
done
if [[ -f "$unit_dir/readypackets-backup@.service" ]]; then
    systemctl stop readypackets-backup@cli.service readypackets-backup@pre_upgrade.service
fi
for unit in "$web" "$worker" 'readypackets-backup@.service' "$timer"; do
    rm -f -- "$unit_dir/$unit" "$unit_dir/$unit.d/10-runtime.conf"
done
systemctl daemon-reload
rm -f -- "$site" "$acme_site" "$nginx_dir/sites-available/readypackets-portal.conf" "$nginx_dir/snippets/readypackets-tls.conf"
nginx -t
systemctl reload nginx
printf 'ReadyPackets deactivated. Database, storage, keys, certificates, backups and releases were not deleted.\n'
