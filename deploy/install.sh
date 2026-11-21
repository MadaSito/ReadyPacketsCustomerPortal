#!/usr/bin/env bash
# Usage: sudo bash deploy/install.sh [--unattended] <reviewed-full-commit-sha>
#
# --unattended is used by auto-install.sh, which prepares the host first. It asks no questions: the three
# database URL files must already be in place, and the first administrator is created from
# RP_BOOTSTRAP_ADMIN_EMAIL, RP_BOOTSTRAP_ADMIN_NAME and the root-only file named by
# RP_BOOTSTRAP_ADMIN_PASSWORD_FILE.
set -euo pipefail
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")
# shellcheck source=deploy/lib.sh
source "$deploy_src/lib.sh"
unattended=0
if [[ ${1:-} == --unattended ]]; then unattended=1; shift; fi
[[ $# == 1 ]] || die 'usage: install.sh [--unattended] <reviewed-full-commit-sha>'
lock_deploy
check_host
resolve_release "$1"
if ((unattended)); then
    [[ -n ${RP_BOOTSTRAP_ADMIN_EMAIL:-} && -n ${RP_BOOTSTRAP_ADMIN_NAME:-} && -n ${RP_BOOTSTRAP_ADMIN_PASSWORD_FILE:-} ]] ||
        die 'an unattended install needs the first administrator details; use auto-install.sh'
else
    confirm "Install ReadyPackets for $origin on this host?" INSTALL
fi
[[ ! -e "$conf/upgrade-state" && ! -e "$conf/install-migration-pending" ]] ||
    die 'a previous operation needs manual reconciliation; see INSTALL.md'
if [[ -e "$base/current" && $(readlink -f "$base/current") != "$release" ]]; then
    die 'a different release is active; use upgrade.sh'
fi
[[ ! -e "$nginx_dir/sites-enabled/default" && ! -L "$nginx_dir/sites-enabled/default" ]] ||
    die 'disable the stock nginx default site first; see INSTALL.md'
for name in fullchain.pem privkey.pem; do
    [[ -r "$tls_dir/$name" ]] || die "the web certificate is missing ($tls_dir/$name); see INSTALL.md"
done
prepare_dirs
install_media_tools
write_env

write_url() {
    local name=$1 url
    if [[ ! -e "$conf/secrets/$name" && ! -L "$conf/secrets/$name" ]]; then
        if ((unattended)); then die "missing $conf/secrets/$name; an unattended install does not ask for it"; fi
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
render_site "$deploy_src/nginx/readypackets-edge.conf.template" "$nginx_dir/snippets/readypackets-edge.conf"
render_site "$deploy_src/nginx/readypackets-tls.conf.template" "$nginx_dir/snippets/readypackets-tls.conf"
render_site "$deploy_src/nginx/readypackets-portal.conf.template" "$nginx_dir/sites-available/readypackets-portal.conf"
ln -sfn -- "$nginx_dir/sites-available/readypackets-portal.conf" "$site"
rm -f -- "$acme_site"
nginx -t
systemctl reload nginx

if [[ ! -e "$conf/admin-bootstrap-done" ]]; then
    if ((unattended)); then
        # A second attempt with the same prepared password (auto-install.sh removes this marker whenever it
        # prepares a new one) may find the account that an interrupted first attempt created.
        admin_retry=0
        if [[ -e "$conf/admin-bootstrap-attempted" ]]; then admin_retry=1; fi
        : > "$conf/admin-bootstrap-attempted"
        admin_status=0
        bootstrap_admin_unattended "$RP_BOOTSTRAP_ADMIN_EMAIL" "$RP_BOOTSTRAP_ADMIN_NAME" \
            "$RP_BOOTSTRAP_ADMIN_PASSWORD_FILE" || admin_status=$?
        # The marker records the outcome for auto-install.sh. Exit status 73 means an administrator was
        # already there: "existing" on a repeated attempt, "preexisting" on the first one.
        case $admin_status in
            0) printf 'created\n' > "$conf/admin-bootstrap-done" ;;
            73) if ((admin_retry)); then printf 'existing\n'; else printf 'preexisting\n'; fi > "$conf/admin-bootstrap-done" ;;
            *) die "the first administrator could not be created (exit $admin_status); the portal stays fenced" ;;
        esac
    else
        read -r -p 'Run admin:create now? [y/N] ' admin_now </dev/tty
        if [[ "$admin_now" =~ ^[Yy]$ ]]; then
            bootstrap_admin
            touch "$conf/admin-bootstrap-done"
        else
            printf 'First-admin creation skipped. Rerun this exact install to bootstrap later.\n' >&2
        fi
    fi
fi
systemctl start "$worker" "$web"
check_http local
check_http edge
systemctl enable "$worker" "$web"
rm -f -- "$maintenance"
printf 'ReadyPackets is healthy. Backup timer installed but disabled; verify a manual backup before enabling it.\n'
