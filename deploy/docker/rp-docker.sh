#!/usr/bin/env bash
# ReadyPackets portal — operator wrapper for the Docker Compose stack in this directory.
#
#   ./rp-docker.sh up --domain portal.example.com [--acme-email you@example.com | --tls-internal]
#   ./rp-docker.sh admin --email admin@example.com --name "Full Name" [--password-file <file>]
#   ./rp-docker.sh recover-admin --email admin@example.com
#   ./rp-docker.sh catalog [--dry-run]
#   ./rp-docker.sh status | logs [service] | down | destroy
#
# Run it as a user who may use Docker (root, or a member of the "docker" group). It never prints,
# stores or passes a secret: secrets are created inside the stack and stay in its volumes.
set -euo pipefail

if [[ $(uname -s) != Linux ]] || (( BASH_VERSINFO[0] < 4 )); then
    printf 'ReadyPackets: this script needs Linux and Bash 4 or newer.\n' >&2
    exit 1
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
readonly here repo
readonly env_file="$here/.env"
readonly compose_file="$here/compose.yaml"

say() { printf 'ReadyPackets: %s\n' "$*"; }
die() { printf 'ReadyPackets: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
Usage:
  rp-docker.sh up --domain <host> [--acme-email <email>] [--tls-internal]
        Build the image and start the stack. On later runs the saved settings are reused, so
        "rp-docker.sh up" alone rebuilds and restarts after "git pull".
        --acme-email    contact address for the public certificate (Let's Encrypt)
        --tls-internal  use a self-signed certificate instead (no public DNS needed; browsers warn)
  rp-docker.sh admin --email <email> --name "<full name>" [--password-file <file>]
        Create the first administrator. Without --password-file the password is asked for twice,
        hidden. A password file must be readable only by its owner and is not removed for you.
  rp-docker.sh recover-admin --email <email>
        Recover an existing active administrator on an interactive terminal (logging disabled).
  rp-docker.sh catalog [--dry-run]
        Load the shipped ReadyPackets offerings into the catalogue (--dry-run changes nothing).
  rp-docker.sh status          Show the containers and whether the portal reports ready.
  rp-docker.sh logs [service]  Show recent log lines (add -f to follow).
  rp-docker.sh down            Stop the stack. Data, keys and certificates are kept.
  rp-docker.sh destroy [--confirm <host>]
        Stop the stack and DELETE its database, files, keys and certificates.
USAGE
}

compose() {
    docker compose --project-directory "$here" --file "$compose_file" --env-file "$env_file" "$@"
}

need_docker() {
    command -v docker >/dev/null 2>&1 || die "Docker is not installed. On a fresh server run: sudo bash deploy/docker/install-vps.sh --domain <host>"
    docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Run this command with sudo, or as a member of the docker group."
    local engine compose_version
    engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
    if [[ ! ${engine%%.*} =~ ^[0-9]+$ ]] || (( ${engine%%.*} < 23 )); then
        die "Docker Engine 23 or newer is required (found '${engine:-unknown}')."
    fi
    compose_version=$(docker compose version --short 2>/dev/null || true)
    compose_version=${compose_version#v}
    if [[ ! ${compose_version%%.*} =~ ^[0-9]+$ ]] || (( ${compose_version%%.*} < 2 )); then
        die "the Docker Compose plugin (v2) is required."
    fi
}

need_env() {
    [[ -f $env_file ]] || die "the stack has not been set up yet. Run: rp-docker.sh up --domain <host>"
}

# Reads one KEY=value setting from .env without evaluating the file as shell.
setting() {
    local key=$1 line value=""
    [[ -f $env_file ]] || return 0
    while IFS= read -r line; do
        if [[ $line == "$key="* ]]; then
            value=${line#"$key="}
            value=${value%$'\r'}
            value=${value#\"}; value=${value%\"}
        fi
    done < "$env_file"
    printf '%s' "$value"
}

valid_domain() {
    local d=$1
    (( ${#d} >= 1 && ${#d} <= 253 )) || return 1
    [[ $d =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
    # A host name is required: certificates and passkeys do not work on a bare IP address.
    [[ ! $d =~ ^[0-9.]+$ ]]
}

release_ref() {
    local ref=""
    if command -v git >/dev/null 2>&1; then
        ref=$(git -c safe.directory="$repo" -C "$repo" rev-parse --verify --quiet HEAD 2>/dev/null || true)
        if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
            if [[ -n $(git -c safe.directory="$repo" -C "$repo" status --porcelain 2>/dev/null || true) ]]; then
                ref="$ref-modified"
            fi
        else
            ref=""
        fi
    fi
    printf '%s' "${ref:-container}"
}

web_ready() {
    compose exec -T web node /opt/readypackets/healthcheck.mjs \
        >/dev/null 2>&1
}

need_running() {
    need_env
    web_ready || die "the portal is not running or not ready. Check: rp-docker.sh status"
}

cmd_up() {
    local domain="" email="" tls_internal="" domain_given="" tls_given=""
    while (( $# )); do
        case $1 in
            --domain) [[ $# -ge 2 ]] || die "--domain needs a value"; domain=${2,,}; domain_given=1; shift 2 ;;
            --acme-email) [[ $# -ge 2 ]] || die "--acme-email needs a value"; email=$2; tls_given=1; shift 2 ;;
            --tls-internal) tls_internal=1; tls_given=1; shift ;;
            *) usage >&2; exit 64 ;;
        esac
    done
    [[ -z $email || -z $tls_internal ]] || die "use either --acme-email or --tls-internal, not both"
    need_docker

    local saved_domain saved_tls installation_id tls_directive
    saved_domain=$(setting RP_DOMAIN)
    saved_tls=$(setting RP_TLS_DIRECTIVE)
    installation_id=$(setting RP_INSTALLATION_ID)

    [[ -n $domain_given ]] || domain=$saved_domain
    [[ -n $domain ]] || die "tell me the host name: rp-docker.sh up --domain <host>"
    valid_domain "$domain" || die "'$domain' is not a usable host name (lowercase letters, digits, dots and hyphens; not an IP address)"
    if [[ -n $email ]]; then
        [[ $email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "'$email' is not a usable e-mail address"
    fi

    if [[ -n $tls_internal || $domain == localhost || $domain == *.localhost ]]; then
        tls_directive="tls internal"
    elif [[ -n $email ]]; then
        tls_directive="tls $email"
    elif [[ -z $tls_given && -n $saved_domain ]]; then
        tls_directive=$saved_tls
    else
        tls_directive=""
    fi

    # The installation identifier is created once and never changes; it labels this installation's
    # audit trail and portable packages.
    if [[ ! $installation_id =~ ^rp-[0-9a-f]{24}$ ]]; then
        installation_id="rp-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
        [[ $installation_id =~ ^rp-[0-9a-f]{24}$ ]] || die "could not create an installation identifier"
    fi

    if [[ -n $saved_domain && $saved_domain != "$domain" ]]; then
        say "the host name changes from $saved_domain to $domain; passkeys registered for the old name stop working"
    fi

    local tmp
    tmp=$(mktemp "$here/.env.XXXXXX")
    {
        printf '# Written by rp-docker.sh. No secrets live here.\n'
        printf 'RP_DOMAIN=%s\n' "$domain"
        printf 'RP_TLS_DIRECTIVE="%s"\n' "$tls_directive"
        printf 'RP_INSTALLATION_ID=%s\n' "$installation_id"
        printf 'RP_RELEASE_REF=%s\n' "$(release_ref)"
        local key value
        for key in RP_PROXY_IP RP_WEB_IP RP_EDGE_SUBNET RP_EGRESS_SUBNET RP_DATA_SUBNET; do
            value=$(setting "$key")
            [[ -z $value ]] || printf '%s=%s\n' "$key" "$value"
        done
    } > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$env_file"

    say "building the image for https://$domain (the first build takes a few minutes)"
    compose build

    # Database migrations must never run underneath a serving portal: stop the proxy and both
    # application processes first (they finish in-flight work), then migrate, then start again. If a
    # migration fails the portal stays down instead of serving from a half-changed database.
    if [[ -n $(compose ps --quiet caddy web worker 2>/dev/null || true) ]]; then
        say "stopping the running portal before the update (it is unavailable until the new version is ready)"
        compose stop caddy web worker
    fi

    say "starting the stack"
    compose up --detach --no-build --remove-orphans

    local attempt
    for attempt in $(seq 1 60); do
        web_ready && break
        (( attempt < 60 )) || die "the portal did not become ready. Check: rp-docker.sh logs web"
        sleep 2
    done

    say "the portal is running and reports ready."
    cat <<NEXT

  Address:  https://$domain
  Next:     1. $0 admin --email <you@example.com> --name "<Your Name>"
            2. $0 catalog --dry-run   then   $0 catalog
            3. Sign in, choose a new password and enrol your authenticator app.
NEXT
    if [[ $tls_directive == "tls internal" ]]; then
        printf '  Note:     this stack uses a self-signed certificate, so browsers show a warning.\n'
    else
        printf '  Note:     the certificate is requested on first start; %s must resolve to this server\n            and ports 80 and 443 must be reachable. Check: %s logs caddy\n' "$domain" "$0"
    fi
}

cmd_admin() {
    local email="" name="" password_file=""
    while (( $# )); do
        case $1 in
            --email) [[ $# -ge 2 ]] || die "--email needs a value"; email=$2; shift 2 ;;
            --name) [[ $# -ge 2 ]] || die "--name needs a value"; name=$2; shift 2 ;;
            --password-file) [[ $# -ge 2 ]] || die "--password-file needs a value"; password_file=$2; shift 2 ;;
            *) usage >&2; exit 64 ;;
        esac
    done
    [[ -n $email && -n $name ]] || { usage >&2; exit 64; }
    [[ $email != --* && $name != --* ]] || { usage >&2; exit 64; }
    need_docker
    need_running

    local status=0
    if [[ -n $password_file ]]; then
        [[ -f $password_file && ! -L $password_file ]] || die "the password file must be a regular file"
        local mode size
        mode=$(stat -c '%a' "$password_file")
        size=$(stat -c '%s' "$password_file")
        (( (8#$mode & 8#077) == 0 )) || die "the password file must not be readable by group or others (chmod 600)"
        (( size >= 1 && size <= 1024 )) || die "the password file must hold one line of at most 1024 bytes"
        # The password travels on standard input into a memory-backed file inside the one-off container,
        # readable only by the service account, and is removed before the container exits.
        # shellcheck disable=SC2016
        compose run --rm --no-deps -T ops sh -c '
            umask 077
            file="$TMPDIR/rp-bootstrap-password.$$"
            trap "rm -f \"$file\"" EXIT INT TERM
            cat > "$file" || exit 1
            RP_BOOTSTRAP_ADMIN_PASSWORD_FILE="$file" node dist/ops/create-admin.js "$@"
            status=$?
            rm -f "$file"
            exit "$status"' sh --email "$email" --name "$name" < "$password_file" || status=$?
    else
        [[ -t 0 ]] || die "no terminal for the password prompt; use --password-file <file>"
        compose run --rm --no-deps ops node dist/ops/create-admin.js --email "$email" --name "$name" || status=$?
    fi
    case $status in
        0) ;;
        73) say "an administrator already exists; add further administrators in the portal (Administration, Staff)." ;;
        *) say "the administrator was not created (exit $status)." >&2 ;;
    esac
    return "$status"
}

cmd_recover_admin() {
    local email=""
    while (( $# )); do
        case $1 in
            --email) [[ $# -ge 2 ]] || die "--email needs a value"; email=$2; shift 2 ;;
            *) usage >&2; exit 64 ;;
        esac
    done
    [[ -n $email && $email != --* ]] || { usage >&2; exit 64; }
    [[ -t 0 && -t 1 && -t 2 ]] || die "administrator recovery requires an interactive terminal on stdin, stdout and stderr"
    need_docker
    need_env
    [[ -n $(compose ps --quiet db 2>/dev/null || true) ]] || die "the database container is not running. Start the stack first with: rp-docker.sh up"
    compose run --rm --no-deps recover-admin node dist/ops/recover-admin.js --email "$email"
}

cmd_catalog() {
    local args=()
    while (( $# )); do
        case $1 in
            --dry-run) args+=(--dry-run); shift ;;
            *) usage >&2; exit 64 ;;
        esac
    done
    need_docker
    need_running
    compose run --rm --no-deps -T ops node dist/ops/catalog-import.js "${args[@]}"
}

cmd_status() {
    need_docker
    need_env
    compose ps --all
    if web_ready; then
        say "the portal reports ready at https://$(setting RP_DOMAIN)"
    else
        say "the portal is not ready." >&2
        return 1
    fi
}

cmd_logs() {
    need_docker
    need_env
    compose logs --tail=200 "$@"
}

cmd_down() {
    need_docker
    need_env
    compose down --remove-orphans
    say "stopped. Data, keys and certificates are kept; start again with: $0 up"
}

cmd_destroy() {
    local confirm=""
    while (( $# )); do
        case $1 in
            --confirm) [[ $# -ge 2 ]] || die "--confirm needs a value"; confirm=$2; shift 2 ;;
            *) usage >&2; exit 64 ;;
        esac
    done
    need_docker
    need_env
    local domain
    domain=$(setting RP_DOMAIN)
    if [[ -z $confirm ]]; then
        [[ -t 0 ]] || die "refusing to destroy without confirmation; pass --confirm $domain"
        printf 'This deletes the database, every stored file, the encryption keys and the certificates of %s.\nIt cannot be undone. Type the host name to continue: ' "$domain"
        IFS= read -r confirm
    fi
    [[ $confirm == "$domain" ]] || die "confirmation did not match; nothing was removed"
    compose --profile ops down --volumes --remove-orphans
    rm -f "$env_file"
    say "the stack and all of its data were removed."
}

main() {
    local command=${1:-}
    [[ -n $command ]] || { usage >&2; exit 64; }
    shift
    case $command in
        up) cmd_up "$@" ;;
        admin) cmd_admin "$@" ;;
        recover-admin) cmd_recover_admin "$@" ;;
        catalog) cmd_catalog "$@" ;;
        status) cmd_status "$@" ;;
        logs) cmd_logs "$@" ;;
        down) cmd_down "$@" ;;
        destroy) cmd_destroy "$@" ;;
        -h | --help | help) usage ;;
        *) usage >&2; exit 64 ;;
    esac
}

main "$@"
