#!/usr/bin/env bash
# End-to-end checks for the Docker Compose stack (deploy/docker), run by .github/workflows/container.yml
# after the stack has been started for the host name "localhost" with a self-signed certificate.
# Every value used here is synthetic and created during the run. Nothing secret is printed.
set -euo pipefail

readonly rp=deploy/docker/rp-docker.sh
readonly origin=https://localhost
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
expect() { [[ $2 == "$3" ]] || fail "$1: expected '$3', got '$2'"; }

# The proxy's own certificate authority is trusted explicitly, so TLS is verified, not skipped.
web() { curl --silent --show-error --max-time 30 --cacert "$work/root.crt" "$@"; }
plain() { curl --silent --show-error --max-time 30 "$@"; }
# Waits until the proxy has created its certificate and answers for the portal.
wait_for_proxy() {
    for _ in $(seq 1 30); do
        if docker exec readypackets-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > "$work/root.crt" 2>/dev/null \
            && grep -q 'BEGIN CERTIFICATE' "$work/root.crt" \
            && [[ $(web -o /dev/null -w '%{http_code}' "$origin/readyz" 2>/dev/null) == 200 ]]; then
            return 0
        fi
        sleep 2
    done
    fail "the proxy did not serve the portal over verified TLS"
}
wait_for_proxy

step "readiness and the application shell through the proxy"
expect "readyz" "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
web -D "$work/shell.headers" -o "$work/shell.html" -H 'Accept: text/html' "$origin/"
grep -qi '^HTTP/2 200' "$work/shell.headers" || fail "the shell was not served over HTTP/2 with status 200"
for header in strict-transport-security content-security-policy x-content-type-options x-request-id; do
    grep -qi "^$header:" "$work/shell.headers" || fail "missing response header: $header"
done
for header in server via x-powered-by; do
    ! grep -qi "^$header:" "$work/shell.headers" || fail "unexpected response header: $header"
done
grep -qi '<div id="root"' "$work/shell.html" || fail "the shell does not look like the portal"
web "$origin/api/trpc/identity.passwordPolicy" | grep -q '"minLength"' || fail "the public API did not answer"

step "plain HTTP is redirected, callback paths are refused, unknown names are refused"
expect "redirect" "$(plain -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/sign-in)" "308 https://localhost/sign-in"
refuse_callback() {
    local label=$1 url=$2 code
    code=$(plain -D "$work/callback.headers" -o /dev/null -w '%{http_code}' "$url")
    expect "$label status" "$code" 404
    ! grep -qi '^location:' "$work/callback.headers" || fail "$label leaked a Location header"
}
refuse_callback "OIDC callback on plain HTTP" "http://localhost/api/identity/sso/callback?code=callback-canary-81a4&state=state-canary-92b5"
refuse_callback "OIDC callback mixed-case trailing slash on plain HTTP" "http://localhost/API/identity/sso/callback/?code=callback-canary-81a4&state=state-canary-92b5"
refuse_callback "storage OAuth callback on plain HTTP" "http://localhost/api/storage/oauth/callback/dropbox?code=callback-canary-81a4&state=state-canary-92b5"
refuse_callback "bare storage OAuth callback on plain HTTP" "http://localhost/API/storage/oauth/callback?code=callback-canary-81a4&state=state-canary-92b5"
expect "unknown host on port 80" "$(plain -o /dev/null -w '%{http_code}' -H 'Host: unknown.example' http://localhost/)" 421
if web -o /dev/null --resolve unknown.example:443:127.0.0.1 https://unknown.example/ 2>/dev/null; then
    fail "an unknown name completed a TLS handshake"
fi

step "oversized request bodies are refused"
head -c 400000 /dev/zero | tr '\0' 'a' > "$work/large"
expect "large body" "$(web -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data-binary "@$work/large" "$origin/api/trpc/identity.signIn")" 413

step "proxy rules: other ports in Host, upload allowances only on the exact routes"
docker exec readypackets-caddy-1 caddy version
expect "Host with another port" "$(web -o /dev/null -w '%{http_code}' -H 'Host: localhost:8443' "$origin/readyz")" 421
expect "mixed-case upload path keeps the default limit" "$(web -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/octet-stream' --data-binary "@$work/large" "$origin/api/Files/upload/probe")" 413
upload_status=$(web -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' \
    --data-binary "@$work/large" "$origin/api/files/upload/probe")
# The proxy lets the larger body through on the real upload route; the application then refuses the
# unauthenticated request itself.
[[ $upload_status =~ ^40[13]$ ]] || fail "upload route: expected the application to refuse (401/403), got $upload_status"

step "the application answers only the proxy"
expect "web networks" "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' readypackets-web-1)" "readypackets_data readypackets_edge "
expect "worker networks" "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' readypackets-worker-1)" "readypackets_data readypackets_egress "
expect "proxy networks" "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' readypackets-caddy-1)" "readypackets_edge "
expect "database networks" "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' readypackets-db-1)" "readypackets_data "
# The worker shares only the database network with web, and web does not listen there.
probe='const s = require("node:net").connect({ host: process.argv[1], port: 5000, timeout: 3000 }); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(7)); s.on("timeout", () => process.exit(7));'
status=0
docker exec readypackets-worker-1 node -e "$probe" web || status=$?
expect "worker cannot connect to web" "$status" 7
status=0
docker exec readypackets-web-1 node -e "$probe" 127.0.0.1 || status=$?
expect "web does not listen on loopback" "$status" 7
status=0
docker exec readypackets-web-1 node -e "$probe" 172.30.250.20 || status=$?
expect "web listens on its proxy-network address" "$status" 0

step "container hardening"
for service in web worker; do
    container=readypackets-$service-1
    expect "$service state" "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$container")" "running 0"
    expect "$service read-only root" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" true
    expect "$service user" "$(docker exec "$container" id -u)" 10001
    expect "$service capabilities" "$(docker exec "$container" grep -E '^Cap(Prm|Eff|Bnd):' /proc/1/status | awk '{print $2}' | sort -u)" 0000000000000000
    ! docker exec "$container" touch /opt/readypackets/probe 2>/dev/null || fail "$service can write to its program directory"
    if docker inspect -f '{{json .Config.Env}}' "$container" | grep -Eq 'mysql://|PASSWORD=|KEYRING=|_KEY='; then
        fail "$service has a secret in its environment"
    fi
    expect "$service published ports" "$(docker port "$container")" ""
done
expect "database published ports" "$(docker port readypackets-db-1)" ""
expect "database user" "$(docker exec readypackets-db-1 id -un)" mysql
expect "database read-only root" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' readypackets-db-1)" true
docker port readypackets-caddy-1 | grep -q '^80/tcp' || fail "the proxy does not publish port 80"
docker port readypackets-caddy-1 | grep -q '^443/tcp' || fail "the proxy does not publish port 443"

step "database accounts: TLS required, least privilege, administrator on the local socket only"
accounts=$(docker exec readypackets-db-1 sh -c 'MYSQL_PWD="$(cat /run/rp-db-secrets/root_password)" mysql --protocol=socket -uroot -N -B -e "SELECT CONCAT(user, \"@\", host, \" \", ssl_type) FROM mysql.user WHERE user NOT LIKE \"mysql.%\" ORDER BY 1"')
expect "accounts" "$accounts" $'root@localhost \nrp_app@172.30.251.0/24 ANY\nrp_migrator@172.30.251.0/24 ANY'
grants=$(docker exec readypackets-db-1 sh -c 'MYSQL_PWD="$(cat /run/rp-db-secrets/root_password)" mysql --protocol=socket -uroot -N -B -e "SHOW GRANTS FOR \"rp_app\"@\"172.30.251.0/24\""')
expect "runtime grants" "$grants" $'GRANT USAGE ON *.* TO `rp_app`@`172.30.251.0/24`\nGRANT SELECT, INSERT, UPDATE, DELETE ON `readypackets`.* TO `rp_app`@`172.30.251.0/24`'
expect "transport policy" "$(docker exec readypackets-db-1 sh -c 'MYSQL_PWD="$(cat /run/rp-db-secrets/root_password)" mysql --protocol=socket -uroot -N -B -e "SELECT @@require_secure_transport, @@local_infile, @@skip_name_resolve"')" $'1\t0\t1'

step "first administrator (non-interactive), refused the second time"
( umask 077; printf 'Ci-%s-Aa1\n' "$(openssl rand -hex 16)" > "$work/password" )
"$rp" admin --email ci.admin@example.com --name "CI Admin" --password-file "$work/password"
status=0
"$rp" admin --email ci.admin@example.com --name "CI Admin" --password-file "$work/password" || status=$?
expect "second administrator" "$status" 73

step "catalogue import"
"$rp" catalog --dry-run | tee "$work/dry-run"
grep -q 'Dry run' "$work/dry-run" || fail "the dry run did not report"
"$rp" catalog | tee "$work/import"
grep -q 'Catalog imported: 6 packets, 18 products' "$work/import" || fail "the catalogue was not imported"

sign_in() {
    local name value token body
    web -D "$work/csrf.headers" -o /dev/null -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' "$origin/api/csrf"
    name=$(grep -i '^set-cookie: __Host-rp_csrf=' "$work/csrf.headers" | head -1 | sed -E 's/^[^:]+: ([^=]+)=.*/\1/')
    value=$(grep -i '^set-cookie: __Host-rp_csrf=' "$work/csrf.headers" | head -1 | sed -E 's/^[^:]+: [^=]+=([^;]*);.*/\1/')
    [[ -n $name && -n $value ]] || fail "no anti-forgery cookie was issued"
    token=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$value")
    body=$(python3 -c 'import json, sys; print(json.dumps({"json": {"email": sys.argv[1], "password": open(sys.argv[2]).read().rstrip("\n")}}))' \
        ci.admin@example.com "$work/password")
    web -D "$work/signin.headers" -o "$work/signin.json" -H "Origin: $origin" -H 'Sec-Fetch-Site: same-origin' \
        -H "Cookie: $name=$value" -H "x-rp-csrf: $token" -H 'Content-Type: application/json' \
        --data "$body" "$origin/api/trpc/identity.signIn"
    grep -q '"nextStep":"enroll_mfa"' "$work/signin.json" || fail "sign-in did not reach authenticator enrolment"
    grep -i '^set-cookie: __Host-rp_session=' "$work/signin.headers" | grep -qi 'HttpOnly; Secure; SameSite=Strict' \
        || fail "the session cookie is missing its protective attributes"
}

step "sign-in through the proxy (password accepted, authenticator enrolment required next)"
sign_in

step "proxy error log holds no request target, query string or header value"
docker stop readypackets-web-1 >/dev/null
expect "upstream down" "$(web -o /dev/null -w '%{http_code}' -H 'X-Probe: header-canary-7f3a' \
    "$origin/path-canary-91c2?token=query-canary-55d1")" 502
sleep 1
docker logs readypackets-caddy-1 > "$work/caddy.log" 2>&1
grep -q '"status":502' "$work/caddy.log" || fail "the proxy did not record the upstream failure"
! grep -q 'canary' "$work/caddy.log" || fail "the proxy log contains request data"

step "update in place: the portal is stopped, migrated and started again"
"$rp" up
wait_for_proxy
expect "readyz after update" "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
expect "web restarted cleanly" "$(docker inspect -f '{{.State.Status}}' readypackets-web-1)" running

step "restart keeps data, keys and settings"
"$rp" down
"$rp" up
wait_for_proxy
expect "readyz after restart" "$(web -o /dev/null -w '%{http_code}' "$origin/readyz")" 200
status=0
"$rp" admin --email ci.admin@example.com --name "CI Admin" --password-file "$work/password" || status=$?
expect "administrator persisted" "$status" 73
sign_in
"$rp" status

printf '\nAll container stack checks passed.\n'
