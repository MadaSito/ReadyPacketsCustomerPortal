# shellcheck shell=bash
# ReadyPackets container stack — database accounts.
#
# SOURCED by the official MySQL image entrypoint, once, when the data directory is first initialised
# (keep this file non-executable so the entrypoint sources it instead of executing it).
# It mirrors deploy/mysql/accounts.sql: a runtime account limited to row operations and a separate
# migrator account that may also change the schema. Both require TLS and may connect only from the
# stack's private data network. The image's root account stays socket-only (MYSQL_ROOT_HOST=localhost).
# Passwords are read from root-provisioned files and sent to the server over the local socket on stdin;
# they never appear in argv, the environment or the log.

declare -F docker_process_sql >/dev/null || { echo "ReadyPackets: mysql-init.sh must be sourced by the image entrypoint" >&2; exit 1; }

rp_fail() { echo "ReadyPackets: database account setup refused ($1)" >&2; exit 1; }

rp_secret_dir=${RP_DB_SECRET_DIR:-/run/rp-db-secrets}
rp_schema=${MYSQL_DATABASE:-}
rp_net=${RP_DB_CLIENT_NET:-}
[[ $rp_schema =~ ^[a-zA-Z0-9_]{1,64}$ ]] || rp_fail "schema name"
[[ $rp_net =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]] || rp_fail "client network"
rp_app_pw=$(< "$rp_secret_dir/app_password") || rp_fail "runtime password file"
rp_migrator_pw=$(< "$rp_secret_dir/migrator_password") || rp_fail "migrator password file"
[[ $rp_app_pw =~ ^[0-9a-f]{48}$ && $rp_migrator_pw =~ ^[0-9a-f]{48}$ ]] || rp_fail "password format"
[[ $rp_app_pw != "$rp_migrator_pw" ]] || rp_fail "password reuse"

docker_process_sql --database=mysql <<SQL
CREATE USER 'rp_app'@'${rp_net}' IDENTIFIED BY '${rp_app_pw}' REQUIRE SSL;
CREATE USER 'rp_migrator'@'${rp_net}' IDENTIFIED BY '${rp_migrator_pw}' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${rp_schema}\`.* TO 'rp_app'@'${rp_net}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
    ON \`${rp_schema}\`.* TO 'rp_migrator'@'${rp_net}';
SQL

unset rp_app_pw rp_migrator_pw
echo "ReadyPackets: database accounts created (runtime and migrator, TLS required)"
