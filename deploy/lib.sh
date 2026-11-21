#!/usr/bin/env bash
# Sourced by deploy entry points, never by the application.
# The entry point sets deploy_src before sourcing this file; the names defined here are used by the entry points.
# SC2016: the single-quoted snippets passed to "bash -c" are expanded by that inner shell, on purpose.
# shellcheck disable=SC2016,SC2034,SC2154
set -euo pipefail
# Never trace: these scripts handle passwords and keys, and a trace would copy them to the terminal or a log.
set +x
umask 077
# A fixed locale as well: the output of several tools is read by these scripts.
export PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin LC_ALL=C.UTF-8

readonly base=/opt/readypackets conf=/etc/readypackets storage=/var/lib/readypackets/storage
readonly unit_dir=/etc/systemd/system nginx_dir=/etc/nginx
readonly site="$nginx_dir/sites-enabled/readypackets-portal.conf"
readonly acme_site="$nginx_dir/sites-enabled/readypackets-acme.conf"
readonly maintenance="$nginx_dir/readypackets-maintenance"
readonly web=readypackets-portal.service worker=readypackets-worker.service
readonly timer=readypackets-backup.timer
readonly node=/usr/local/bin/node pnpm=/usr/local/bin/pnpm
readonly site_conf="$conf/site.conf" deploy_lock=/run/readypackets-deploy.lock
# Site identity: the portal's host name, an optional alias that only redirects to it, and where the web
# certificate lives. Defaults apply when site.conf is absent; load_site (end of this file) reads it as data.
origin=my.readypackets.com alias_host=portal.readypackets.com tls_mode=letsencrypt
tls_dir=/etc/letsencrypt/live/readypackets-portal
readonly -a app_keys=(rp_data_keyring rp_index_key rp_pseudonym_key rp_token_hash_key rp_audit_chain_key)
unset NODE_OPTIONS NODE_PATH

die() { printf 'ReadyPackets: %s\n' "$*" >&2; exit 1; }
confirm() {
    local reply
    read -r -p "$1 Type $2 to continue: " reply </dev/tty
    [[ "$reply" == "$2" ]] || die 'confirmation did not match'
}
lock_deploy() {
    # One lock for every entry point. auto-install.sh takes it first and install.sh, started by it, inherits
    # the open descriptor; taking the lock again on that same descriptor succeeds.
    [[ $EUID == 0 ]] || die 'run as root'
    if [[ ! /proc/self/fd/9 -ef "$deploy_lock" ]]; then exec 9>"$deploy_lock"; fi
    flock -n 9 || die 'an installation, upgrade, or uninstall is already running'
}
valid_host() {
    # Lower-case DNS name with at least two labels; the last label starts with a letter, so bare IPs are refused.
    [[ ${#1} -le 253 && $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}
load_site() {
    local key value
    if [[ -e "$site_conf" || -L "$site_conf" ]]; then
        [[ ! -L "$site_conf" && -f "$site_conf" && $(stat -c '%a:%u:%g' "$site_conf") == 600:0:0 ]] ||
            die "expected a root-owned 0600 site file: $site_conf"
        origin='' alias_host='' tls_mode=''
        while IFS='=' read -r key value || [[ -n "$key" ]]; do
            case $key in
                canonical_host) origin=$value ;;
                alias_host) alias_host=$value ;;
                tls) tls_mode=$value ;;
                *) die "unexpected line in $site_conf" ;;
            esac
        done < "$site_conf"
    fi
    valid_host "$origin" || die "invalid portal host name in $site_conf"
    [[ -z "$alias_host" ]] || valid_host "$alias_host" || die "invalid alias host name in $site_conf"
    [[ "$alias_host" != "$origin" ]] || die 'the alias must differ from the portal host name'
    case $tls_mode in
        letsencrypt) tls_dir=/etc/letsencrypt/live/readypackets-portal ;;
        self-signed) tls_dir="$conf/tls" ;;
        *) die "invalid tls setting in $site_conf" ;;
    esac
}
write_site() {
    # write_site <host> <alias-or-empty> <letsencrypt|self-signed>. The host name of an installation is fixed
    # once its environment file exists: sessions, passkeys and links are bound to it.
    local host=$1 alias=$2 mode=$3 temp installed_alias
    valid_host "$host" || die "not a valid public host name: $host"
    [[ -z "$alias" ]] || valid_host "$alias" || die "not a valid alias host name: $alias"
    [[ "$alias" != "$host" ]] || die 'the alias must differ from the portal host name'
    [[ "$mode" == letsencrypt || "$mode" == self-signed ]] || die 'the certificate mode must be letsencrypt or self-signed'
    root_directory /etc 755
    root_directory "$conf" 700
    if [[ -e "$conf/portal.env" ]]; then
        grep -qxF "RP_CANONICAL_ORIGIN=https://$host" "$conf/portal.env" ||
            die 'this server is already installed under another host name; changing it is not supported by this kit'
        installed_alias=$(sed -n 's/^RP_ALIAS_HOSTS=//p' "$conf/portal.env")
        [[ "$installed_alias" == "$alias" ]] ||
            die "this server is already installed with ${installed_alias:+the alias }${installed_alias:-no alias}; changing that is not supported by this kit"
    fi
    temp=$(mktemp "$conf/.site.XXXXXXXX")
    printf 'canonical_host=%s\nalias_host=%s\ntls=%s\n' "$host" "$alias" "$mode" > "$temp"
    mv -fT -- "$temp" "$site_conf"
    load_site
}
nginx_has_http2_directive() {
    # "http2 on;" exists from nginx 1.25.1 (Ubuntu 26.04 ships 1.28; Ubuntu 24.04 ships 1.24).
    local version
    version=$(nginx -v 2>&1 | sed -n 's|^nginx version: nginx/\([0-9][0-9.]*\).*|\1|p')
    [[ -n $version && $(printf '%s\n' 1.25.1 "$version" | sort -V | head -n1) == 1.25.1 ]]
}
render_site() {
    # render_site <template> <destination>: substitutes the site identity into an nginx template.
    # Regions "#@alias{ ... #@alias}" are kept only with an alias, "#@http2{ ... #@http2}" only where the
    # installed nginx knows the "http2" directive. Regions do not nest.
    local template=$1 dest=$2 line temp skip=0 names=$origin
    [[ -z "$alias_host" ]] || names="$origin $alias_host"
    temp=$(mktemp "$dest.XXXXXXXX")
    while IFS= read -r line || [[ -n "$line" ]]; do
        case $line in
            '#@alias{') if [[ -z "$alias_host" ]]; then skip=1; fi; continue ;;
            '#@alias}') skip=0; continue ;;
            '#@http2{') if ! nginx_has_http2_directive; then skip=1; fi; continue ;;
            '#@http2}') skip=0; continue ;;
            '#@ '*) continue ;;
        esac
        if ((skip)); then continue; fi
        line=${line//@RP_SERVER_NAMES@/$names}
        line=${line//@RP_HOST@/$origin}
        line=${line//@RP_ALIAS@/$alias_host}
        line=${line//@RP_TLS_DIR@/$tls_dir}
        printf '%s\n' "$line"
    done < "$template" > "$temp"
    if grep -q '@RP_[A-Z_]*@\|^#@' "$temp"; then rm -f -- "$temp"; die "unrendered placeholder in $template"; fi
    chmod 0644 -- "$temp"
    mv -fT -- "$temp" "$dest"
}
check_host() {
    case $(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID") in
        ubuntu:24.04|ubuntu:26.04) ;;
        *) die 'this kit supports Ubuntu 24.04 LTS and 26.04 LTS' ;;
    esac
    "$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===22&&minor>=12?0:1)' ||
        die 'install Node.js 22.12 or later in the Node 22 series at /usr/local/bin/node'
    mysql --version | grep -Eiq '\b(Ver[[:space:]]+8\.4\.|Distrib[[:space:]]+8\.4\.)' ||
        die 'install the Oracle MySQL 8.4 client'
    mysqldump --version | grep -Eiq '\b(Ver[[:space:]]+8\.4\.|Distrib[[:space:]]+8\.4\.)' ||
        die 'install the Oracle MySQL 8.4 mysqldump client'
    [[ $(mysql --no-defaults --protocol=socket --batch --skip-column-names --execute='SELECT VERSION()') =~ ^8\.4\. ]] ||
        die 'cannot verify the local MySQL 8.4 server via the root socket account'
    local command
    for command in nginx systemctl systemd-run git tar curl openssl; do
        command -v "$command" >/dev/null || die "$command is required"
    done
}
prepare_dirs() {
    local name
    for name in readypackets readypackets-build; do
        getent passwd "$name" >/dev/null ||
            useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
        [[ $(id -u "$name") != 0 && $(id -gn "$name") == "$name" &&
           $(id -G "$name") == "$(id -g "$name")" ]] ||
            die "invalid pre-existing service/build user: $name"
    done
    [[ $(id -u readypackets) != "$(id -u readypackets-build)" ]] || die 'build and application identities must be distinct'
    root_directory /opt 755
    root_directory /etc 755
    root_directory /var 755
    root_directory /var/www 755
    root_directory "$base" 755
    root_directory "$base/releases" 755
    root_directory "$conf" 700
    root_directory "$conf/secrets" 700
    root_directory /var/www/readypackets-acme 755
    [[ ! -L /var/lib/readypackets && ! -L "$storage" && ! -L /var/cache/readypackets-build ]] ||
        die 'refusing symlinked state or cache directory'
    install -d -o root -g readypackets -m 0750 /var/lib/readypackets
    install -d -o readypackets -g readypackets -m 0700 "$storage"
    install -d -o readypackets-build -g readypackets-build -m 0700 /var/cache/readypackets-build
    [[ $(realpath -e "$storage") == "$storage" && $(realpath -e "$base") == "$base" ]] ||
        die 'storage and release roots must be distinct, non-symlinked paths'
}
root_directory() {
    local dir=$1 mode=$2
    [[ ! -L "$dir" ]] || die "refusing symlinked custody directory: $dir"
    if [[ ! -e "$dir" ]]; then install -d -o root -g root -m "0$mode" -- "$dir"; fi
    [[ -d "$dir" && $(stat -c '%a:%u:%g' -- "$dir") == "$mode:0:0" && $(realpath -e -- "$dir") == "$dir" ]] ||
        die "unexpected owner, permissions or resolved path: $dir"
}
build_as_user() {
    systemd-run --wait --collect --pipe --service-type=exec --expand-environment=no \
        --property=User=readypackets-build --property=Group=readypackets-build \
        --property=UMask=0022 --property=NoNewPrivileges=yes --property=ProtectSystem=strict \
        --property=ProtectHome=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
        --property=CapabilityBoundingSet= --property=KillMode=control-group \
        --property="InaccessiblePaths=$conf" \
        --property="ReadWritePaths=$PWD /var/cache/readypackets-build" \
        --working-directory="$PWD" --setenv=PATH="$PATH" --setenv=HOME=/var/cache/readypackets-build "$@"
}
resolve_release() {
    local ref=$1
    [[ $ref =~ ^[0-9a-f]{40}$ ]] || die 'supply a reviewed, full Git commit SHA'
    repo=$(git -C "$deploy_src/.." rev-parse --show-toplevel)
    commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
    [[ "$commit" == "$ref" ]] || die 'expected a commit, not a tag'
    release="$base/releases/$commit"
}
build_release() (
        local reviewed stage='' publish='' expected entry
        reviewed=$(mktemp -d "$base/releases/.reviewed.XXXXXXXX")
        trap 'rm -rf -- "$reviewed"; if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi; if [[ -n "$publish" ]]; then rm -rf -- "$publish"; fi' EXIT
        git -C "$repo" cat-file -e "$commit:migrations/meta/_journal.json" 2>/dev/null ||
            die 'reviewed release is missing a migration journal'
        git -C "$repo" ls-tree -r "$commit" -- migrations package.json |
            while IFS= read -r entry; do
                [[ "$entry" == "100644 blob "* || "$entry" == "100755 blob "* ]] ||
                    die 'reviewed migration input and package metadata must be regular Git blobs'
            done
        git -C "$repo" archive "$commit" -- migrations package.json |
            tar --no-same-owner --no-same-permissions -xf - -C "$reviewed"
        [[ -f "$reviewed/migrations/meta/_journal.json" && -f "$reviewed/package.json" ]] ||
            die 'reviewed release archive is incomplete'
        if [[ -e "$release" || -L "$release" ]]; then
            "$node" "$deploy_src/prepare-release.mjs" check "$commit" "$release"
            if ! { cmp -s -- "$reviewed/package.json" "$release/package.json" &&
                   diff -qr -- "$reviewed/migrations" "$release/migrations" >/dev/null; }; then
                die 'existing release metadata or migrations differ from reviewed inputs'
            fi
            exit 0
        fi
        stage=$(mktemp -d "$base/releases/.build.XXXXXXXX")
        expected=$("$node" -p \
            'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).packageManager.replace(/^pnpm@/, "").split("+")[0]' \
            "$reviewed/package.json")
        [[ "$expected" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid reviewed packageManager version'
        chown readypackets-build:readypackets-build "$stage"
        cd "$stage"
        git -C "$repo" archive "$commit" | build_as_user /usr/bin/tar --no-same-owner --no-same-permissions -xf -
        [[ $(build_as_user "$pnpm" --version) == "$expected" ]] || die "install pnpm $expected at $pnpm"
        # A hoisted production tree avoids publishing pnpm's development-store symlinks.
        build_as_user "$pnpm" install --frozen-lockfile --prod=false --config.node-linker=hoisted
        build_as_user "$pnpm" build
        build_as_user "$pnpm" prune --prod --config.node-linker=hoisted
        cd "$base/releases"
        publish=$(mktemp -d "$base/releases/.publish.XXXXXXXX")
        "$node" "$deploy_src/prepare-release.mjs" import "$commit" "$stage" "$publish" "$(id -u readypackets-build)" "$reviewed"
        chmod 0755 -- "$publish"
        mv -T -- "$publish" "$release"
        publish=
)
point_release() {
    local target=$1 name=$2 temp
    temp=$(mktemp -d "$base/.link.XXXXXXXX")
    ln -s -- "$target" "$temp/link"
    mv -Tf -- "$temp/link" "$base/$name"
    rmdir -- "$temp"
}
secret_ok() {
    local file="$conf/secrets/$1"
    [[ ! -L "$file" && -f "$file" && -s "$file" && $(stat -c '%a:%u:%g' "$file") == 600:0:0 ]] ||
        die "expected a root-owned 0600 secret: $file"
}
validate_dsn() {
    "$node" "$deploy_src/validate-dsn.mjs" "$1"
}
credentials_ok() {
    local name
    for name in database_url migrator_database_url backup_database_url; do
        secret_ok "$name"
        validate_dsn "$name" < "$conf/secrets/$name"
    done
}
install_unit_files() {
    local unit
    for unit in "$web" "$worker" 'readypackets-backup@.service' "$timer"; do
        install -m 0644 "$deploy_src/systemd/$unit" "$unit_dir/$unit"
    done
    for unit in "$web" "$worker" 'readypackets-backup@.service'; do
        install -d -m 0755 "$unit_dir/$unit.d"
        install -m 0644 "$deploy_src/systemd/readypackets-runtime.conf" "$unit_dir/$unit.d/10-runtime.conf"
    done
    systemctl daemon-reload
    assert_service_identity
}
assert_service_identity() {
    local unit
    for unit in "$web" "$worker" readypackets-backup@cli.service readypackets-backup@pre_upgrade.service; do
        [[ $(systemctl show "$unit" -p User --value) == readypackets &&
           $(systemctl show "$unit" -p Group --value) == readypackets &&
           $(systemctl show "$unit" -p NoNewPrivileges --value) == yes &&
           $(systemctl show "$unit" -p ProtectSystem --value) == strict ]] ||
            die "unexpected effective systemd identity or sandbox for $unit"
    done
}
write_env() {
    local id
    if [[ ! -e "$conf/portal.env" && ! -L "$conf/portal.env" ]]; then
        id="rp-$(openssl rand -hex 12)"
        {
            printf '%s\n' NODE_ENV=production RP_DEPLOYMENT_PROFILE=production HOST=127.0.0.1 PORT=5000 \
                "RP_CANONICAL_ORIGIN=https://$origin"
            if [[ -n "$alias_host" ]]; then printf 'RP_ALIAS_HOSTS=%s\n' "$alias_host"; fi
            printf '%s\n' RP_TRUSTED_PROXIES=127.0.0.1 RP_LOG_LEVEL=info RP_SERVICE_NAME=readypackets \
                "RP_INSTALLATION_ID=$id" "RP_STORAGE_DIR=$storage" \
                "RP_STATIC_DIR=$base/current/dist/public"
        } > "$conf/portal.env"
    fi
    [[ ! -L "$conf/portal.env" && -f "$conf/portal.env" && $(stat -c '%a:%u:%g' "$conf/portal.env") == 600:0:0 ]] ||
        die "expected a root-owned 0600 environment file: $conf/portal.env"
    grep -qxF "RP_CANONICAL_ORIGIN=https://$origin" "$conf/portal.env" ||
        die "the environment file and $site_conf name different portal hosts"
}
migrate_release() {
    local target=$1
    secret_ok migrator_database_url
    systemd-run --wait --collect --pipe --service-type=exec --expand-environment=no \
        --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
        --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
        --property="LoadCredential=migrator_database_url:$conf/secrets/migrator_database_url" \
        --working-directory="$target" --setenv=PATH="$PATH" --setenv=NODE_ENV=production \
        --setenv=HOME=/nonexistent --setenv=RP_MIGRATIONS_DIR="$target/migrations" \
        /bin/bash -c 'export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/migrator_database_url"; exec "$@"' \
        bash "$node" "$target/dist/ops/migrate.js"
}
ops_run() {
    # ops_run <--pty|--pipe> <command> [args...]: runs an operator tool of the active release as the
    # unprivileged service account, in the same sandbox and with the same credentials as the web service.
    local io=$1 key
    shift
    local -a creds=("--property=LoadCredential=database_url:$conf/secrets/database_url")
    for key in "${app_keys[@]}"; do creds+=("--property=LoadCredential=$key:$conf/secrets/$key"); done
    systemd-run --wait --collect --quiet "$io" --service-type=exec --expand-environment=no \
        --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
        --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
        --property="ReadWritePaths=$storage" --property="EnvironmentFile=$conf/portal.env" \
        --property="EnvironmentFile=$base/current/release.env" \
        "${creds[@]}" --working-directory="$base/current" --setenv=RP_ROLE=web \
        /bin/bash -c '
            export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/database_url"
            export RP_DATA_KEYRING_FILE="$CREDENTIALS_DIRECTORY/rp_data_keyring"
            export RP_INDEX_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_index_key"
            export RP_PSEUDONYM_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_pseudonym_key"
            export RP_TOKEN_HASH_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_token_hash_key"
            export RP_AUDIT_CHAIN_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_audit_chain_key"
            exec "$@"
        ' bash "$@"
}
bootstrap_admin() {
    local email name
    read -r -p 'First administrator email: ' email </dev/tty
    read -r -p 'First administrator full name: ' name </dev/tty
    ops_run --pty /usr/local/bin/node dist/ops/create-admin.js --email "$email" --name "$name" </dev/tty
}
bootstrap_admin_unattended() {
    # bootstrap_admin_unattended <email> <name> <password-file>. The password travels on standard input into a
    # file in the unit's private temporary directory, readable only by the service account, and is removed
    # before the unit exits. It never appears in a command line, the environment or a log.
    local email=$1 name=$2 file=$3
    [[ ! -L "$file" && -f "$file" && -s "$file" && $(stat -c '%a:%u:%g' "$file") == 600:0:0 ]] ||
        die 'the administrator password file must be a root-owned 0600 regular file'
    ops_run --pipe /bin/bash -c '
        umask 077
        file=$(mktemp "${TMPDIR:-/tmp}/rp-bootstrap.XXXXXXXX") || exit 1
        trap "rm -f -- \"\$file\"" EXIT
        cat > "$file" || exit 1
        RP_BOOTSTRAP_ADMIN_PASSWORD_FILE=$file /usr/local/bin/node dist/ops/create-admin.js "$@"
    ' bash --email "$email" --name "$name" < "$file"
}
import_catalog() {
    # import_catalog [--dry-run]: loads the offerings matrix shipped with the active release.
    ops_run --pipe /usr/local/bin/node dist/ops/catalog-import.js "$@" </dev/null
}
check_http() {
    local mode=$1 probe code attempt
    local -a opts=(--disable --noproxy '*' --silent --fail --max-time 5 --output /dev/null --write-out '%{http_code}')
    if [[ "$mode" == edge ]]; then
        probe="https://$origin"
        opts+=(--resolve "$origin:443:127.0.0.1")
        # A self-signed certificate is trusted explicitly, so the check still verifies TLS and the name.
        if [[ "$tls_mode" == self-signed ]]; then opts+=(--cacert "$tls_dir/fullchain.pem"); fi
    else
        probe=http://127.0.0.1:5000
    fi
    for ((attempt=1; attempt<=15; attempt++)); do
        if code=$(curl "${opts[@]}" "$probe/healthz") && [[ "$code" == 200 ]] &&
           code=$(curl "${opts[@]}" "$probe/readyz") && [[ "$code" == 200 ]] &&
           systemctl is-active --quiet "$worker"; then
            return
        fi
        sleep 2
    done
    die "$mode health/readiness or worker active check failed"
}

load_site
