#!/usr/bin/env bash
# Usage: sudo bash deploy/install.sh <reviewed-full-commit-sha>
set -euo pipefail
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")
source "$deploy_src/lib.sh"
[[ $# == 1 ]] || die 'usage: install.sh <reviewed-full-commit-sha>'
lock_deploy
check_host
resolve_release "$1"
confirm 'Install ReadyPackets for my.readypackets.com on this host?' INSTALL
[[ ! -e "$conf/upgrade-state" && ! -e "$conf/install-migration-pending" ]] ||
    die 'a previous operation needs manual reconciliation; see INSTALL.md'
if [[ -e "$base/current" && $(readlink -f "$base/current") != "$release" ]]; then
    die 'a different release is active; use upgrade.sh'
fi
[[ ! -e "$nginx_dir/sites-enabled/default" && ! -L "$nginx_dir/sites-enabled/default" ]] ||
    die 'disable the stock nginx default site first; see INSTALL.md'
for name in fullchain.pem privkey.pem; do
    [[ -r "/etc/letsencrypt/live/readypackets-portal/$name" ]] || die 'issue the dual-host certificate first; see INSTALL.md'
done
prepare_dirs
write_env

write_url() {
    local name=$1 url
    if [[ ! -e "$conf/secrets/$name" && ! -L "$conf/secrets/$name" ]]; then
        read -r -s -p "Paste $name (input hidden): " url </dev/tty
        printf '\n' >&2
        printf '%s' "$url" | validate_dsn "$name"
        (set -C; printf '%s\n' "$url" > "$conf/secrets/$name")
    fi
}
write_url database_url
write_url migrator_database_url
write_url backup_database_url
credentials_ok

keys_present=0
for key in "${app_keys[@]}"; do
    if [[ -e "$conf/secrets/$key" || -L "$conf/secrets/$key" ]]; then
        secret_ok "$key"
        ((keys_present+=1))
    fi
done
if ((keys_present == 0)); then
    (
        # Independent of release code, dependency builds and the build account.
        generated=$(mktemp -d "$conf/secrets/.keys.XXXXXXXX")
        trap 'rm -rf -- "$generated"' EXIT
        key_id="k$(date -u +%Y%m%d)"
        material=$(openssl rand -base64 32)
        printf '{"current":"%s","keys":{"%s":"%s"}}\n' "$key_id" "$key_id" "$material" \
            > "$generated/rp_data_keyring"
        unset material
        for key in "${app_keys[@]}"; do
            if [[ "$key" != rp_data_keyring ]]; then openssl rand -base64 32 > "$generated/$key"; fi
        done
        for key in "${app_keys[@]}"; do
            ln -- "$generated/$key" "$conf/secrets/$key"
        done
    )
elif ((keys_present != ${#app_keys[@]})); then
    die 'partial key set; reconcile custody before retrying, never replace existing keys'
fi
if [[ ! -e "$conf/secrets/rp_backup_key" && ! -L "$conf/secrets/rp_backup_key" ]]; then
    (
        backup_key=$(mktemp "$conf/secrets/.backup-key.XXXXXXXX")
        trap 'rm -f -- "$backup_key"' EXIT
        openssl rand -base64 32 > "$backup_key"
        ln -- "$backup_key" "$conf/secrets/rp_backup_key"
    )
fi
secret_ok rp_backup_key
build_release

# Record ambiguity before any potentially nontransactional database operation.
if [[ ! -e "$base/current" ]]; then
    touch "$maintenance"
    printf '%s\n' "$release" > "$conf/install-migration-pending"
    migrate_release "$release"
    point_release "$release" current
    rm -f -- "$conf/install-migration-pending"
fi

install_unit_files
install -m 0644 "$deploy_src/nginx/readypackets-tls.conf" "$nginx_dir/snippets/readypackets-tls.conf"
install -m 0644 "$deploy_src/nginx/readypackets-portal.conf" "$nginx_dir/sites-available/readypackets-portal.conf"
ln -sfn -- "$nginx_dir/sites-available/readypackets-portal.conf" "$site"
rm -f -- "$acme_site"
nginx -t
systemctl reload nginx

if [[ ! -e "$conf/admin-bootstrap-done" ]]; then
    read -r -p 'Run admin:create now? [y/N] ' admin_now </dev/tty
    if [[ "$admin_now" =~ ^[Yy]$ ]]; then
        bootstrap_admin
        touch "$conf/admin-bootstrap-done"
    else
        printf 'First-admin creation skipped. Rerun this exact install to bootstrap later.\n' >&2
    fi
fi
systemctl start "$worker" "$web"
check_http local
check_http edge
systemctl enable "$worker" "$web"
rm -f -- "$maintenance"
printf 'ReadyPackets is healthy. Backup timer installed but disabled; verify a manual backup before enabling it.\n'
