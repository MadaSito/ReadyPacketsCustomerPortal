#!/usr/bin/env bash
# End-to-end checks of a native installation made by deploy/auto-install.sh, run as root by
# .github/workflows/native-install.yml on a throwaway Ubuntu 26.04 machine.
#
#   native-install-smoke.sh <portal-host> [alias-host]
#
# Environment: RP_SMOKE_CA=<pem> overrides the certificate authority used to verify the portal (default:
# the self-signed certificate of the installation, or the system trust store for a public certificate).
# Every value used here is synthetic and created during the run. The administrator password is never printed.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ $# == 1 || $# == 2 ]] || { echo 'usage: native-install-smoke.sh <portal-host> [alias-host]' >&2; exit 64; }
readonly host=$1 alias=${2:-}
readonly origin=https://$host conf=/etc/readypackets credentials=/root/readypackets-initial-admin.txt
readonly install_log=/var/log/readypackets-install.log
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
expect() { [[ $2 == "$3" ]] || fail "$1: expected '$3', got '$2'"; }
mode_of() { stat -c '%a:%U:%G' -- "$1"; }
sql() { mysql --protocol=socket --batch --skip-column-names --execute="$1"; }

ca=()
if [[ -n ${RP_SMOKE_CA:-} ]]; then
    ca=(--cacert "$RP_SMOKE_CA")
elif grep -qx 'tls=self-signed' "$conf/site.conf"; then
    ca=(--cacert "$conf/tls/fullchain.pem")
fi
# TLS is always verified. Names are pinned to this machine so no DNS record is needed.
pins=(--resolve "$host:443:127.0.0.1" --resolve "$host:80:127.0.0.1")
if [[ -n $alias ]]; then pins+=(--resolve "$alias:443:127.0.0.1" --resolve "$alias:80:127.0.0.1"); fi
web() { curl --disable --noproxy '*' --silent --show-error --max-time 30 "${ca[@]}" "${pins[@]}" "$@"; }

step 'site record and services'
expect 'site file' "$(mode_of "$conf/site.conf")" 600:root:root
grep -qx "canonical_host=$host" "$conf/site.conf" || fail 'site.conf does not name the portal host'
grep -qx "alias_host=$alias" "$conf/site.conf" || fail 'site.conf does not record the alias'
grep -qx "RP_CANONICAL_ORIGIN=$origin" "$conf/portal.env" || fail 'portal.env does not name the portal origin'
for unit in readypackets-portal.service readypackets-worker.service nginx.service mysql.service; do
    expect "$unit active" "$(systemctl is-active "$unit")" active
    expect "$unit enabled" "$(systemctl is-enabled "$unit")" enabled
done
expect 'backup timer left for the operator' "$(systemctl is-enabled readypackets-backup.timer || true)" disabled
[[ ! -e /etc/nginx/readypackets-maintenance ]] || fail 'the maintenance fence is still in place'
[[ ! -e /etc/nginx/sites-enabled/default && ! -e /etc/nginx/sites-enabled/readypackets-acme.conf ]] ||
    fail 'a site other than the portal is still enabled'
if grep -qx 'tls=letsencrypt' "$conf/site.conf"; then
    expect 'certificate renewal timer' "$(systemctl is-enabled certbot.timer)" enabled
    [[ -x /etc/letsencrypt/renewal-hooks/deploy/readypackets-nginx ]] || fail 'the renewal hook is missing'
fi

step 'pinned runtime and tools'
expect 'node' "$(/usr/local/bin/node --version)" v22.23.5
expect 'pnpm' "$(/usr/local/bin/pnpm --version)" 12.21.0
[[ $(readlink -f /usr/local/bin/node) == /usr/local/lib/readypackets-node/* ]] || fail 'node is not the pinned runtime'
for tool in npm npx corepack; do
    [[ ! -e /usr/local/bin/$tool ]] || fail "unexpected tool next to the runtime: $tool"
done
mysqld --version | grep -Eq 'Ver[[:space:]]+8\.4\.' || fail 'MySQL is not 8.4'

step 'readiness and the application shell over verified TLS'
expect 'readyz' "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
expect 'healthz' "$(web -o /dev/null -w '%{http_code}' "$origin/healthz")" 200
web -D "$work/shell.headers" -o "$work/shell.html" -H 'Accept: text/html' "$origin/"
grep -qi '^HTTP/2 200' "$work/shell.headers" || fail 'the shell was not served over HTTP/2 with status 200'
for header in strict-transport-security content-security-policy x-content-type-options x-request-id; do
    grep -qi "^$header:" "$work/shell.headers" || fail "missing response header: $header"
done
! grep -qi '^x-powered-by:' "$work/shell.headers" || fail 'unexpected response header: x-powered-by'
! grep -Eqi '^server:.*[0-9]' "$work/shell.headers" || fail 'the server header discloses a version'
grep -qi '<div id="root"' "$work/shell.html" || fail 'the shell does not look like the portal'
web "$origin/api/trpc/identity.passwordPolicy" | grep -q '"minLength"' || fail 'the public API did not answer'
expect 'verified certificate' "$(web -o /dev/null -w '%{ssl_verify_result}' "$origin/readyz")" 0

step 'plain HTTP is redirected; unknown names, IP addresses and other ports are refused'
expect 'redirect' "$(web -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/sign-in?next=%2Forders")" \
    "308 $origin/sign-in?next=%2Forders"
expect 'upper-case name is the same name' \
    "$(web -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: ${host^^}" "http://$host/x")" "308 $origin/x"
expect 'explicit default port' \
    "$(web -o /dev/null -w '%{http_code}' -H "Host: $host:443" "$origin/readyz")" 200
closed() {  # closed <label> <curl args...>: the server must drop the connection without an answer
    local label=$1 status=0
    shift
    web -o /dev/null "$@" 2>/dev/null || status=$?
    [[ $status == 52 || $status == 56 || $status == 92 || $status == 35 ]] ||
        fail "$label: expected the connection to be dropped, curl exit $status"
}
closed 'unknown name on port 80' -H 'Host: unknown.example' "http://$host/"
closed 'IP address on port 80' http://127.0.0.1/
closed 'another port in Host on port 80' -H "Host: $host:8080" "http://$host/"
closed 'another port in Host on port 443' -H "Host: $host:8443" "$origin/readyz"
closed 'look-alike name' -H "Host: $host.evil.example" "$origin/readyz"
status=0
curl --disable --silent --max-time 15 --insecure -o /dev/null --resolve unknown.example:443:127.0.0.1 https://unknown.example/ 2>/dev/null || status=$?
expect 'unknown name is refused during the TLS handshake' "$status" 35
status=0
curl --disable --silent --max-time 15 --insecure -o /dev/null https://127.0.0.1/ 2>/dev/null || status=$?
expect 'IP address is refused during the TLS handshake' "$status" 35

if [[ -n $alias ]]; then
    step 'the alias only redirects'
    web -D "$work/alias.headers" -o /dev/null "https://$alias/orders?x=1"
    grep -qi '^HTTP/2 308' "$work/alias.headers" || fail 'the alias did not answer 308'
    grep -qi "^location: $origin/orders?x=1" "$work/alias.headers" || fail 'the alias did not redirect to the portal'
    grep -qi '^strict-transport-security:' "$work/alias.headers" || fail 'the alias redirect carries no HSTS'
    expect 'alias on port 80' "$(web -o /dev/null -w '%{http_code} %{redirect_url}' "http://$alias/a")" "308 $origin/a"
    expect 'alias never serves the application' "$(web -o /dev/null -w '%{http_code}' "https://$alias/readyz")" 308
else
    step 'no alias is configured'
    ! grep -q 'RP_ALIAS_HOSTS' "$conf/portal.env" || fail 'portal.env names an alias'
fi

step 'oversized request bodies are refused; upload allowances only on the exact routes'
head -c 400000 /dev/zero | tr '\0' 'a' > "$work/large"
expect 'large body' "$(web -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data-binary "@$work/large" "$origin/api/trpc/identity.signIn")" 413
expect 'mixed-case upload path keeps the default limit' "$(web -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/octet-stream' --data-binary "@$work/large" "$origin/api/Files/upload/probe")" 413
upload_status=$(web -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' \
    --data-binary "@$work/large" "$origin/api/files/upload/probe")
[[ $upload_status =~ ^40[13]$ ]] || fail "upload route: expected the application to refuse (401/403), got $upload_status"

step 'only Nginx is reachable from outside'
listeners=$(ss -Hltn | awk '{print $4}' | sort -u)
grep -qx '127.0.0.1:5000' <<<"$listeners" || fail 'the application does not listen on 127.0.0.1:5000'
! grep -Eq '^(0\.0\.0\.0|\*|\[::\]):(5000|3306|33060)$' <<<"$listeners" || fail 'the application or the database listens on every address'
grep -qx '127.0.0.1:3306' <<<"$listeners" || fail 'MySQL does not listen on 127.0.0.1:3306'
expect 'MySQL settings' "$(sql "SELECT CONCAT_WS(' ', @@bind_address, @@skip_name_resolve, @@local_infile)")" '127.0.0.1 1 0'

step 'service sandbox and secrets'
for unit in readypackets-portal.service readypackets-worker.service; do
    pid=$(systemctl show "$unit" -p MainPID --value)
    [[ $pid =~ ^[1-9][0-9]*$ ]] || fail "$unit has no main process"
    expect "$unit user" "$(stat -c '%U' "/proc/$pid")" readypackets
    expect "$unit capabilities" "$(grep -E '^Cap(Prm|Eff|Bnd):' "/proc/$pid/status" | awk '{print $2}' | sort -u)" 0000000000000000
    expect "$unit no new privileges" "$(awk '/^NoNewPrivs:/ {print $2}' "/proc/$pid/status")" 1
    if tr '\0' '\n' < "/proc/$pid/environ" | grep -Eq 'mysql://|PASSWORD=|"keys"'; then
        fail "$unit has a secret in its environment"
    fi
    expect "$unit restarts" "$(systemctl show "$unit" -p NRestarts --value)" 0
done
expect 'configuration directory' "$(mode_of "$conf")" 700:root:root
expect 'secrets directory' "$(mode_of "$conf/secrets")" 700:root:root
for name in database_url migrator_database_url backup_database_url rp_data_keyring rp_index_key rp_pseudonym_key \
    rp_token_hash_key rp_audit_chain_key rp_backup_key; do
    expect "secret $name" "$(mode_of "$conf/secrets/$name")" 600:root:root
done
expect 'environment file' "$(mode_of "$conf/portal.env")" 600:root:root
! grep -Eq 'mysql://|PASSWORD|KEYRING=' "$conf/portal.env" || fail 'portal.env holds a secret'
expect 'storage' "$(mode_of /var/lib/readypackets/storage)" 700:readypackets:readypackets
release=$(readlink -f /opt/readypackets/current)
[[ $release =~ ^/opt/readypackets/releases/[0-9a-f]{40}$ ]] || fail 'unexpected release layout'
loose=$(find "$release" -xdev \( -perm /022 -o ! -user root \) ! -type l | head -5)
[[ -z $loose ]] || fail "the release holds files that are not root-owned or are group/other-writable: $loose"
if runuser -u readypackets -- test -r "$conf/secrets/database_url" 2>/dev/null; then
    fail 'the service account can read the secret files directly'
fi

step 'database accounts: TLS required, least privilege'
expect 'accounts' "$(sql "SELECT CONCAT(user, '@', host, ' ', ssl_type) FROM mysql.user WHERE user LIKE 'rp\\_%' ORDER BY 1")" \
    $'rp_app@127.0.0.1 ANY\nrp_backup@127.0.0.1 ANY\nrp_migrator@127.0.0.1 ANY'
expect 'runtime grants' "$(sql "SHOW GRANTS FOR 'rp_app'@'127.0.0.1'")" \
    $'GRANT USAGE ON *.* TO `rp_app`@`127.0.0.1`\nGRANT SELECT, INSERT, UPDATE, DELETE ON `readypackets`.* TO `rp_app`@`127.0.0.1`'
sql "SHOW GRANTS FOR 'rp_backup'@'127.0.0.1'" > "$work/backup.grants"
# shellcheck disable=SC2016
{
grep -q 'GRANT SELECT, SHOW VIEW ON `readypackets`.\* TO' "$work/backup.grants" || fail 'backup account: read grant missing'
grep -q 'GRANT INSERT, UPDATE ON `readypackets`.`backup_archives` TO' "$work/backup.grants" || fail 'backup account: ledger grant missing'
! grep -Eq 'DELETE|DROP|ALTER|ALL PRIVILEGES' "$work/backup.grants" || fail 'backup account holds a destructive privilege'
}
expect 'no account reaches MySQL from elsewhere' "$(sql "SELECT COUNT(*) FROM mysql.user WHERE host NOT IN ('localhost', '127.0.0.1')")" 0
# The same password that works over verified TLS is refused on an unencrypted connection.
app_password=$(sed -E 's#^mysql://[^:]+:([^@]+)@.*#\1#' "$conf/secrets/database_url")
login() {  # login <ssl-mode>
    mysql --defaults-extra-file=<(printf '[client]\npassword=%s\n' "$app_password") --protocol=tcp --host=127.0.0.1 \
        --user=rp_app --ssl-mode="$1" --ssl-ca=/etc/mysql/readypackets-tls/ca.pem --batch --skip-column-names \
        --execute='SELECT 1' readypackets 2>/dev/null
}
expect 'verified TLS login' "$(login VERIFY_IDENTITY)" 1
if login DISABLED >/dev/null; then fail 'the runtime account can sign in without TLS'; fi
unset app_password
[[ ! -e /etc/mysql/readypackets-tls/ca-key.pem ]] || fail 'the database CA key was kept'
[[ -z $(find /etc/mysql /etc/readypackets -maxdepth 1 -name '.*tls*' -print -quit) ]] || fail 'a certificate work directory was left behind'
expect 'database server key' "$(mode_of /etc/mysql/readypackets-tls/server-key.pem)" 600:mysql:mysql

step 'first administrator: saved root-only, never logged'
expect 'saved sign-in details' "$(mode_of "$credentials")" 600:root:root
admin_email=$(sed -n 's/^  Sign-in name   : //p' "$credentials")
sed -n 's/^  Password       : \([^ ]*\) .*$/\1/p' "$credentials" > "$work/password"
[[ -n $admin_email ]] || fail 'the saved details hold no sign-in name'
grep -Eqx '([bcdfghjkmnpqrstvwxyz23456789]{5}-){3}[bcdfghjkmnpqrstvwxyz23456789]{5}' "$work/password" ||
    fail 'the saved details hold no generated password'
grep -q "Portal address : $origin\$" "$credentials" || fail 'the saved details name another address'
expect 'install log' "$(mode_of "$install_log")" 600:root:root
! grep -qFf "$work/password" "$install_log" || fail 'the administrator password is in the installation log'
journalctl --boot --no-pager --output=cat > "$work/journal" 2>/dev/null || true
! grep -qFf "$work/password" "$work/journal" || fail 'the administrator password is in the system journal'
[[ ! -e $conf/initial-admin-password && ! -e $conf/initial-admin-email ]] || fail 'the pending password file was kept'
expect 'administrator marker' "$(cat "$conf/admin-bootstrap-done")" created
expect 'administrators in the database' "$(sql "SELECT COUNT(*) FROM readypackets.users WHERE role = 'admin'")" 1
grep -q 'Catalog imported: 6 packets, 18 products' "$install_log" || fail 'the offerings were not loaded'

sign_in() {
    local name value token
    web -D "$work/csrf.headers" -o /dev/null -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' "$origin/api/csrf"
    name=$(grep -i '^set-cookie: __Host-rp_csrf=' "$work/csrf.headers" | head -1 | sed -E 's/^[^:]+: ([^=]+)=.*/\1/')
    value=$(grep -i '^set-cookie: __Host-rp_csrf=' "$work/csrf.headers" | head -1 | sed -E 's/^[^:]+: [^=]+=([^;]*);.*/\1/')
    [[ -n $name && -n $value ]] || fail 'no anti-forgery cookie was issued'
    token=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$value")
    # The request body and the anti-forgery values travel in root-only files, not in command lines.
    python3 -c 'import json, sys; print(json.dumps({"json": {"email": sys.argv[1], "password": open(sys.argv[2]).read().rstrip("\n")}}))' \
        "$admin_email" "$work/password" > "$work/signin.body"
    printf 'Cookie: %s=%s\nx-rp-csrf: %s\n' "$name" "$value" "$token" > "$work/signin.request-headers"
    web -D "$work/signin.headers" -o "$work/signin.json" -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' \
        -H "@$work/signin.request-headers" -H 'Content-Type: application/json' \
        --data "@$work/signin.body" "$origin/api/trpc/identity.signIn"
    grep -q '"nextStep":"enroll_mfa"' "$work/signin.json" || fail 'sign-in did not reach authenticator enrolment'
    grep -i '^set-cookie: __Host-rp_session=' "$work/signin.headers" | grep -qi 'HttpOnly; Secure; SameSite=Strict' ||
        fail 'the session cookie is missing its protective attributes'
}

step 'sign-in with the printed details (password accepted, authenticator enrolment required next)'
sign_in

step 'Nginx logs hold no request target, query string or header value'
web -o /dev/null -H 'X-Probe: header-canary-7f3a' "$origin/path-canary-91c2?token=query-canary-55d1" || true
sleep 1
! grep -rqs 'canary' /var/log/nginx || fail 'the Nginx logs contain request data'

step 'maintenance fence: everyone but the local health probe is turned away'
# Requests from 127.0.0.2 stand in for outside clients; 127.0.0.1 is the installer's own probe address.
expect 'outside client before fencing' "$(web --interface 127.0.0.2 -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
touch /etc/nginx/readypackets-maintenance
expect 'fenced' "$(web --interface 127.0.0.2 -o /dev/null -w '%{http_code}' "$origin/readyz")" 503
expect 'local probe while fenced' "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
rm -f /etc/nginx/readypackets-maintenance
expect 'reopened' "$(web --interface 127.0.0.2 -o /dev/null -w '%{http_code}' "$origin/readyz")" 200

step 'a manual encrypted backup completes and is verified'
systemctl start readypackets-backup@cli.service || { journalctl --unit=readypackets-backup@cli.service --no-pager --lines=60; fail 'the backup failed'; }
expect 'backup result' "$(systemctl show readypackets-backup@cli.service -p Result --value)" success
expect 'verified archives recorded' "$(sql "SELECT COUNT(*) > 0 FROM readypackets.backup_archives")" 1

step 'restart of every service (as after a reboot) keeps the portal working'
systemctl restart mysql.service
systemctl restart readypackets-worker.service readypackets-portal.service nginx.service
for _ in $(seq 1 30); do
    if [[ $(web -o /dev/null -w '%{http_code}' "$origin/readyz" 2>/dev/null) == 200 ]]; then break; fi
    sleep 2
done
expect 'readyz after restart' "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
expect 'worker after restart' "$(systemctl is-active readypackets-worker.service)" active
sign_in

printf '\nAll native installation checks passed.\n'
