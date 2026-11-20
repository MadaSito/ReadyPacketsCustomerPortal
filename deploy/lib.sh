#!/usr/bin/env bash
# Sourced by deploy entry points, never by the application.
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin

readonly base=/opt/readypackets conf=/etc/readypackets storage=/var/lib/readypackets/storage
readonly unit_dir=/etc/systemd/system nginx_dir=/etc/nginx
readonly site="$nginx_dir/sites-enabled/readypackets-portal.conf"
readonly acme_site="$nginx_dir/sites-enabled/readypackets-acme.conf"
readonly maintenance="$nginx_dir/readypackets-maintenance"
readonly web=readypackets-portal.service worker=readypackets-worker.service
readonly timer=readypackets-backup.timer
readonly node=/usr/local/bin/node pnpm=/usr/local/bin/pnpm
readonly origin=my.readypackets.com
readonly -a app_keys=(rp_data_keyring rp_index_key rp_pseudonym_key rp_token_hash_key rp_audit_chain_key)
unset NODE_OPTIONS NODE_PATH

die() { printf 'ReadyPackets: %s\n' "$*" >&2; exit 1; }
confirm() {
    local reply
    read -r -p "$1 Type $2 to continue: " reply </dev/tty
    [[ "$reply" == "$2" ]] || die 'confirmation did not match'
}
lock_deploy() {
    [[ $EUID == 0 ]] || die 'run as root'
    exec 9>/run/lock/readypackets-deploy.lock
    flock -n 9 || die 'an installation, upgrade, or uninstall is already running'
}
check_host() {
    [[ $(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID") == ubuntu:24.04 ]] ||
        die 'this kit supports Ubuntu 24.04 LTS'
    "$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===22&&minor>=12?0:1)' ||
        die 'install Node.js 22.12 or later in the Node 22 series at /usr/local/bin/node'
    mysql --version | grep -Eiq '\b(Ver[[:space:]]+8\.4\.|Distrib[[:space:]]+8\.4\.)' ||
        die 'install the Oracle MySQL 8.4 client'
    mysqldump --version | grep -Eiq '\b(Ver[[:space:]]+8\.4\.|Distrib[[:space:]]+8\.4\.)' ||
        die 'install the Oracle MySQL 8.4 mysqldump client'
    [[ $(mysql --protocol=socket --batch --skip-column-names --execute='SELECT VERSION()') =~ ^8\.4\. ]] ||
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
    systemd-run --wait --collect --pipe --service-type=exec \
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
        local reviewed stage= publish= expected entry
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
            cmp -s -- "$reviewed/package.json" "$release/package.json" &&
                diff -qr -- "$reviewed/migrations" "$release/migrations" >/dev/null ||
                die 'existing release metadata or migrations differ from reviewed inputs'
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
        printf '%s\n' NODE_ENV=production RP_DEPLOYMENT_PROFILE=production HOST=127.0.0.1 PORT=5000 \
            RP_CANONICAL_ORIGIN=https://my.readypackets.com RP_ALIAS_HOSTS=portal.readypackets.com \
            RP_TRUSTED_PROXIES=127.0.0.1 RP_LOG_LEVEL=info RP_SERVICE_NAME=readypackets \
            "RP_INSTALLATION_ID=$id" "RP_STORAGE_DIR=$storage" \
            "RP_STATIC_DIR=$base/current/dist/public" > "$conf/portal.env"
    fi
    [[ ! -L "$conf/portal.env" && -f "$conf/portal.env" && $(stat -c '%a:%u:%g' "$conf/portal.env") == 600:0:0 ]] ||
        die "expected a root-owned 0600 environment file: $conf/portal.env"
}
migrate_release() {
    local target=$1
    secret_ok migrator_database_url
    systemd-run --wait --collect --pipe --service-type=exec \
        --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
        --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
        --property="LoadCredential=migrator_database_url:$conf/secrets/migrator_database_url" \
        --working-directory="$target" --setenv=PATH="$PATH" --setenv=NODE_ENV=production \
        --setenv=HOME=/nonexistent --setenv=RP_MIGRATIONS_DIR="$target/migrations" \
        /bin/bash -c 'export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/migrator_database_url"; exec "$@"' \
        bash "$node" "$target/dist/ops/migrate.js"
}
bootstrap_admin() {
    local email name key
    local -a creds=("--property=LoadCredential=database_url:$conf/secrets/database_url")
    read -r -p 'First administrator email: ' email </dev/tty
    read -r -p 'First administrator full name: ' name </dev/tty
    for key in "${app_keys[@]}"; do creds+=("--property=LoadCredential=$key:$conf/secrets/$key"); done
    systemd-run --wait --collect --pty --service-type=exec \
        --property=User=readypackets --property=Group=readypackets --property=UMask=0077 \
        --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=CapabilityBoundingSet= \
        --property="ReadWritePaths=$storage" --property="EnvironmentFile=$conf/portal.env" \
        "${creds[@]}" --working-directory="$base/current" --setenv=RP_ROLE=web \
        /bin/bash -c '
            export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/database_url"
            export RP_DATA_KEYRING_FILE="$CREDENTIALS_DIRECTORY/rp_data_keyring"
            export RP_INDEX_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_index_key"
            export RP_PSEUDONYM_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_pseudonym_key"
            export RP_TOKEN_HASH_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_token_hash_key"
            export RP_AUDIT_CHAIN_KEY_FILE="$CREDENTIALS_DIRECTORY/rp_audit_chain_key"
            exec /usr/local/bin/node dist/ops/create-admin.js "$@"
        ' bash --email "$email" --name "$name" </dev/tty
}
check_http() {
    local mode=$1 probe code attempt
    local -a opts=(--disable --noproxy '*' --silent --fail --max-time 5 --output /dev/null --write-out '%{http_code}')
    if [[ "$mode" == edge ]]; then
        probe="https://$origin"
        opts+=(--resolve "$origin:443:127.0.0.1")
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
