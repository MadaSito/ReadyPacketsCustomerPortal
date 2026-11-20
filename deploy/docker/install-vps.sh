#!/usr/bin/env bash
# ReadyPackets portal — one-command setup of the Docker Compose stack on a fresh server.
#
#   sudo bash deploy/docker/install-vps.sh --domain portal.example.com --acme-email you@example.com
#
# Supported: Ubuntu 22.04 / 24.04 and Debian 12 (amd64 or arm64), run as root from a checkout of this
# repository. It installs Docker Engine and the Compose plugin from Docker's own signed package
# repository when they are missing (the signing key's fingerprint is checked first), then starts the
# stack through rp-docker.sh. It does not change the firewall, SSH or any other service.
#
# Options:
#   --domain <host>        host name of the portal (its DNS A/AAAA record must point at this server)
#   --acme-email <email>   contact address for the public certificate (Let's Encrypt)
#   --tls-internal         use a self-signed certificate instead (no public DNS needed; browsers warn)
#   --docker-only          install Docker and stop (do not start the stack)
set -euo pipefail

# Docker's package signing key: https://download.docker.com/linux/<distribution>/gpg
readonly docker_key_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly here

say() { printf 'ReadyPackets: %s\n' "$*"; }
warn() { printf 'ReadyPackets: warning: %s\n' "$*" >&2; }
die() { printf 'ReadyPackets: %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

domain="" email="" tls_internal="" docker_only=""
while (( $# )); do
    case $1 in
        --domain) [[ $# -ge 2 ]] || die "--domain needs a value"; domain=$2; shift 2 ;;
        --acme-email) [[ $# -ge 2 ]] || die "--acme-email needs a value"; email=$2; shift 2 ;;
        --tls-internal) tls_internal=1; shift ;;
        --docker-only) docker_only=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; exit 64 ;;
    esac
done

(( EUID == 0 )) || die "run this script as root (sudo bash $0 ...)"
[[ -n $docker_only || -n $domain ]] || { usage >&2; exit 64; }
[[ -z $email || -z $tls_internal ]] || die "use either --acme-email or --tls-internal, not both"

[[ -r /etc/os-release ]] || die "cannot identify this operating system"
# shellcheck disable=SC1091
. /etc/os-release
distribution=${ID:-}
codename=${VERSION_CODENAME:-}
case "$distribution:${VERSION_ID:-}" in
    ubuntu:22.04 | ubuntu:24.04 | debian:12) ;;
    *) die "unsupported system '${PRETTY_NAME:-unknown}'. Supported: Ubuntu 22.04, Ubuntu 24.04, Debian 12. On other systems install Docker Engine 23+ with the Compose plugin yourself, then run deploy/docker/rp-docker.sh up." ;;
esac
[[ $codename =~ ^[a-z]+$ ]] || die "cannot determine the release code name"
architecture=$(dpkg --print-architecture)
case $architecture in
    amd64 | arm64) ;;
    *) die "unsupported CPU architecture '$architecture' (amd64 and arm64 are supported)" ;;
esac

work=""
cleanup() { [[ -z $work ]] || rm -rf "$work"; }
trap cleanup EXIT

docker_ready() {
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker() {
    say "installing Docker Engine and the Compose plugin from download.docker.com"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg >/dev/null

    local key fingerprints
    work=$(mktemp -d)
    key="$work/docker.asc"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --output "$key" "https://download.docker.com/linux/$distribution/gpg"
    # The key file must contain exactly the expected primary key and nothing else.
    fingerprints=$(GNUPGHOME="$work" gpg --batch --quiet --show-keys --with-colons "$key" 2>/dev/null \
        | awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; want = 0 }')
    [[ $fingerprints == "$docker_key_fingerprint" ]] \
        || die "the Docker package signing key did not match the expected fingerprint; nothing was installed"

    install -d -m 0755 /etc/apt/keyrings
    install -m 0644 "$key" /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$architecture" "$distribution" "$codename" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    docker_ready || die "Docker was installed but the 'docker compose' command is not available"
    say "installed $(docker --version)"
}

if docker_ready; then
    say "Docker is already installed ($(docker --version)); leaving it as it is"
else
    install_docker
fi

if [[ -n $docker_only ]]; then
    say "Docker is ready. Start the stack with: bash $here/rp-docker.sh up --domain <host>"
    exit 0
fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable --now docker >/dev/null 2>&1 || warn "could not enable the Docker service; start it and run this script again"
fi

# --- pre-flight (warnings only; nothing here changes the server) -----------------------------------
memory_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
swap_mb=$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)
if (( memory_mb + swap_mb < 1900 )); then
    warn "this server has ${memory_mb} MB of memory and ${swap_mb} MB of swap. Building the image needs about 2 GB; add swap or use a larger server if the build stops."
fi
free_mb=$(df --output=avail -m /var/lib 2>/dev/null | awk 'NR == 2 { print $1 }')
if [[ ${free_mb:-0} =~ ^[0-9]+$ ]] && (( ${free_mb:-0} < 6000 )); then
    warn "only ${free_mb} MB of disk space is free under /var/lib; at least 6 GB is recommended."
fi
if command -v ss >/dev/null 2>&1; then
    for port in 80 443; do
        if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q . \
            && ! docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q "^readypackets-caddy-.*:$port->"; then
            die "port $port is already in use on this server. Stop the web server that owns it (for example nginx or apache2), then run this script again."
        fi
    done
fi
if [[ -z $tls_internal && $domain != localhost ]]; then
    if ! getent ahosts "$domain" >/dev/null 2>&1; then
        warn "$domain does not resolve yet. A public certificate can only be issued once its DNS record points at this server."
    fi
fi

arguments=(up --domain "$domain")
[[ -z $email ]] || arguments+=(--acme-email "$email")
[[ -z $tls_internal ]] || arguments+=(--tls-internal)
bash "$here/rp-docker.sh" "${arguments[@]}"

cat <<'NOTE'

  Firewall: this script did not change it. Allow inbound TCP 80 and 443 (and your SSH port) in your
  provider's firewall and, if you use ufw:  ufw allow 80/tcp && ufw allow 443/tcp
  Docker publishes container ports ahead of ufw rules; only ports 80 and 443 are published by this stack.
NOTE
