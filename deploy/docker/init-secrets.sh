#!/usr/bin/env bash
# ReadyPackets container stack — one-time secret initialisation.
#
# Runs inside the application image as root, with no network, before any other service starts. It creates,
# exactly once, everything the stack needs to trust itself:
#   - three independent database passwords (root, runtime, migrator),
#   - a private certificate authority and a server certificate for the database (the CA key is discarded),
#   - the application key set (field-encryption keyring and the four HMAC keys),
#   - the two database URLs (runtime and migrator), with verified TLS.
# Nothing is printed except fixed status lines. No secret is ever placed in an environment variable or argv.
#
# Volumes (see compose.yaml):
#   /secrets/app       runtime secrets, owned by the service user, mounted read-only into web/worker/ops
#   /secrets/migrator  migrator URL + CA, mounted read-only into the one-shot migration container only
#   /secrets/db        database passwords + server certificate, mounted read-only into the database only
set -euo pipefail
umask 077

readonly app_dir=${RP_INIT_APP_DIR:-/secrets/app}
readonly migrator_dir=${RP_INIT_MIGRATOR_DIR:-/secrets/migrator}
readonly db_dir=${RP_INIT_DB_DIR:-/secrets/db}
readonly marker="$app_dir/.initialized"
# Where the runtime and migration containers see their secret volumes.
readonly app_mount=${RP_INIT_APP_MOUNT:-/run/readypackets/secrets}
readonly migrator_mount=${RP_INIT_MIGRATOR_MOUNT:-/run/readypackets/migrator}
readonly db_host=${RP_DB_HOST:-db}
readonly db_port=${RP_DB_PORT:-3306}
readonly db_name=${RP_DB_NAME:-readypackets}
readonly service_uid=${RP_SERVICE_UID:-10001}
readonly service_gid=${RP_SERVICE_GID:-10001}
readonly keygen=${RP_INIT_KEYGEN:-/opt/readypackets/dist/ops/generate-keys.js}

say() { printf 'ReadyPackets init: %s\n' "$*"; }
die() { printf 'ReadyPackets init: %s\n' "$*" >&2; exit 1; }

[[ $db_host =~ ^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$ ]] || die "invalid database host name"
[[ $db_port =~ ^[0-9]{1,5}$ ]] || die "invalid database port"
[[ $db_name =~ ^[a-zA-Z0-9_]{1,64}$ ]] || die "invalid database name"
for dir in "$app_dir" "$migrator_dir" "$db_dir"; do
    [[ -d $dir ]] || die "secret volume is not mounted"
done

if [[ -e $marker ]]; then
    say "secrets already initialised; nothing to do"
    exit 0
fi

# Never overwrite or silently replace key material: losing the keyring makes encrypted data unreadable.
shopt -s nullglob dotglob
for dir in "$app_dir" "$migrator_dir" "$db_dir"; do
    existing=("$dir"/*)
    if (( ${#existing[@]} > 0 )); then
        die "a secret volume holds files but initialisation never completed; refusing to overwrite. If this installation has never been used, remove it with 'rp-docker.sh destroy' and start again."
    fi
done
shopt -u nullglob dotglob

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

secret() { openssl rand -hex 24; }  # 48 hexadecimal characters: URL- and SQL-safe without escaping
write() {  # write <file>  (content on stdin)
    cat > "$1"
    [[ -s $1 ]] || die "could not write a secret file"
}

# --- database passwords -------------------------------------------------------------------------
root_pw=$(secret); app_pw=$(secret); migrator_pw=$(secret)
[[ ${#root_pw} -eq 48 && ${#app_pw} -eq 48 && ${#migrator_pw} -eq 48 ]] || die "random source failed"
printf '%s\n' "$root_pw" | write "$db_dir/root_password"
printf '%s\n' "$app_pw" | write "$db_dir/app_password"
printf '%s\n' "$migrator_pw" | write "$db_dir/migrator_password"

# --- private CA and database server certificate --------------------------------------------------
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$work/ca-key.pem" -out "$work/ca.pem" -days 3650 -sha256 \
    -subj "/O=ReadyPackets container stack/CN=ReadyPackets database CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1 || die "could not create the database CA"
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$work/server-key.pem" -out "$work/server.csr" \
    -subj "/O=ReadyPackets container stack/CN=$db_host" >/dev/null 2>&1 || die "could not create the database key"
printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
    "$db_host" > "$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.pem" -CAkey "$work/ca-key.pem" -CAcreateserial \
    -out "$work/server-cert.pem" -days 3650 -sha256 -extfile "$work/server.ext" >/dev/null 2>&1 \
    || die "could not sign the database certificate"
openssl verify -CAfile "$work/ca.pem" "$work/server-cert.pem" >/dev/null 2>&1 || die "database certificate did not verify"
# The CA signs exactly one certificate. Its private key is discarded so nothing else can ever be issued.
rm -f "$work/ca-key.pem" "$work/server.csr" "$work/ca.srl"
write "$db_dir/ca.pem" < "$work/ca.pem"
write "$db_dir/server-cert.pem" < "$work/server-cert.pem"
write "$db_dir/server-key.pem" < "$work/server-key.pem"
write "$app_dir/db-ca.pem" < "$work/ca.pem"
write "$migrator_dir/db-ca.pem" < "$work/ca.pem"

# --- database URLs (verified TLS, hostname identity) ----------------------------------------------
printf 'mysql://rp_app:%s@%s:%s/%s?tls=required&tlsCaFile=%s/db-ca.pem\n' \
    "$app_pw" "$db_host" "$db_port" "$db_name" "$app_mount" | write "$app_dir/database_url"
printf 'mysql://rp_migrator:%s@%s:%s/%s?tls=required&tlsCaFile=%s/db-ca.pem\n' \
    "$migrator_pw" "$db_host" "$db_port" "$db_name" "$migrator_mount" | write "$migrator_dir/database_url"
unset root_pw app_pw migrator_pw

# --- application keys (the generator refuses to overwrite and prints only file names) -------------
node "$keygen" --out-dir "$app_dir" >/dev/null || die "could not generate the application keys"
for name in rp_data_keyring rp_index_key rp_pseudonym_key rp_token_hash_key rp_audit_chain_key; do
    [[ -s $app_dir/$name ]] || die "the application key set is incomplete"
done

# --- ownership and modes -------------------------------------------------------------------------
# Runtime and migrator secrets belong to the unprivileged service user. Database files stay root-owned
# here; the db-perms step hands them to the database image's own account.
chown -R "$service_uid:$service_gid" "$app_dir" "$migrator_dir"
chmod 0700 "$app_dir" "$migrator_dir" "$db_dir"
find "$app_dir" "$migrator_dir" "$db_dir" -type f -exec chmod 0400 {} +

: > "$marker"
chown "$service_uid:$service_gid" "$marker"
chmod 0400 "$marker"
say "secrets initialised"
