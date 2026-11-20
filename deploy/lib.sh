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
    for command in nginx systemctl systemd-run git tar runuser curl openssl; do
        command -v "$command" >/dev/null || die "$command is required"
    done
}
prepare_dirs() {
    local name
    for name in readypackets readypackets-build; do
        getent passwd "$name" >/dev/null ||
            useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
        [[ $(id -u "$name") != 0 && $(id -gn "$name") == "$name" ]] ||
            die "invalid pre-existing service/build user: $name"
    done
    install -d -o root -g root -m 0755 "$base" "$base/releases" /var/www/readypackets-acme
    install -d -o root -g readypackets -m 0750 /var/lib/readypackets
    install -d -o readypackets -g readypackets -m 0700 "$storage"
    install -d -o readypackets-build -g readypackets-build -m 0700 /var/cache/readypackets-build
    install -d -o root -g root -m 0700 "$conf" "$conf/secrets"
    [[ $(realpath -e "$storage") == "$storage" && $(realpath -e "$base") == "$base" ]] ||
        die 'storage and release roots must be distinct, non-symlinked paths'
}
build_as_user() {
    runuser -u readypackets-build -- env -i PATH="$PATH" HOME=/var/cache/readypackets-build \
        bash -c 'umask 022; exec "$@"' bash "$@"
}
resolve_release() {
    local ref=$1
    [[ $ref =~ ^[0-9a-f]{40}$ ]] || die 'supply a reviewed, full Git commit SHA'
    repo=$(git -C "$deploy_src/.." rev-parse --show-toplevel)
    commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
    [[ "$commit" == "$ref" ]] || die 'expected a commit, not a tag'
    release="$base/releases/$commit"
}
build_release() {
    if [[ -d "$release" ]]; then
        [[ -f "$release/release.env" && -f "$release/dist/server/main.js" && -f "$release/dist/public/index.html" ]] ||
            die "existing release is incomplete: $release"
        return
    fi
    local stage expected
    stage=$(mktemp -d "$base/releases/.build.XXXXXXXX")
    # Remove only this newly created staging directory, never persistent state.
    (
        trap 'rm -rf -- "$stage"' EXIT
        (umask 022; git -C "$repo" archive "$commit" | tar --no-same-owner --no-same-permissions -xf - -C "$stage")
        chown -hR readypackets-build:readypackets-build "$stage"
        chmod 0755 "$stage"
        cd "$stage"
        expected=$("$node" -p 'require("./package.json").packageManager.replace(/^pnpm@/, "").split("+")[0]')
        [[ $(build_as_user "$pnpm" --version) == "$expected" ]] || die "install pnpm $expected at $pnpm"
        build_as_user "$pnpm" install --frozen-lockfile
        build_as_user "$pnpm" build
        [[ -f dist/server/main.js && -f dist/public/index.html && -f migrations/meta/_journal.json ]] ||
            die 'release is missing expected artifacts'
        chown -hR root:root "$stage"
        chmod -R go-w "$stage"
        printf 'RP_RELEASE_REF=%s\n' "$commit" > release.env
        mv -T -- "$stage" "$release"
        trap - EXIT
    )
}
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
write_env() {
    local id
    if [[ ! -e "$conf/portal.env" ]]; then
        id="rp-$(openssl rand -hex 12)"
        printf '%s\n' NODE_ENV=production RP_DEPLOYMENT_PROFILE=production HOST=127.0.0.1 PORT=5000 \
            RP_CANONICAL_ORIGIN=https://my.readypackets.com RP_ALIAS_HOSTS=portal.readypackets.com \
            RP_TRUSTED_PROXIES=127.0.0.1 RP_LOG_LEVEL=info RP_SERVICE_NAME=readypackets \
            "RP_INSTALLATION_ID=$id" "RP_STORAGE_DIR=$storage" \
            "RP_STATIC_DIR=$base/current/dist/public" > "$conf/portal.env"
    fi
    [[ ! -L "$conf/portal.env" && $(stat -c '%a:%u:%g' "$conf/portal.env") == 600:0:0 ]] ||
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
        /bin/bash -c 'export DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/migrator_database_url"; exec "$@"' bash "$pnpm" db:migrate
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
            exec /usr/local/bin/node --import tsx scripts/ops/create-admin.ts "$@"
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
