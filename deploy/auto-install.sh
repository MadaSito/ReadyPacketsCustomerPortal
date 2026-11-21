#!/usr/bin/env bash
# ReadyPackets portal: unattended native installation on a fresh Ubuntu 26.04 LTS server.
#
#   sudo bash deploy/auto-install.sh --domain my.readypackets.com --acme-email you@example.com
#
# Run it from a clone of this repository that root owns (see docs/operations/AUTO_INSTALL.md). It installs
# every prerequisite, prepares the database and the web certificate, runs the hardened native installer
# (install.sh) without questions, creates the first administrator with a generated temporary password and
# prints the sign-in details at the end. It is safe to run again: finished steps are recognised and skipped.
#
# Options
#   --domain <host>        public host name of the portal (asked for when omitted on a terminal)
#   --alias <host>         optional second host name that only redirects to the portal
#   --acme-email <email>   contact address for the public certificate (Let's Encrypt). Supplying it accepts
#                          the Let's Encrypt Subscriber Agreement.
#   --tls-self-signed      use a self-signed certificate instead (testing; browsers warn)
#   --admin-email <email>  sign-in name of the first administrator (default: the --acme-email address,
#                          otherwise admin@<domain>)
#   --admin-name "<name>"  display name of the first administrator (default: Portal Administrator)
#   --skip-catalog         do not load the ReadyPackets offerings (packets, tiers, prices)
#   --skip-dns-check       do not check that the host names reach this server before asking for a certificate
#   --swap <auto|yes|no>   add a 2 GB swap file for the build: auto (default) adds it when memory plus swap
#                          is below 3 GB, yes always adds it, no never does
#   --print-credentials    print the sign-in details to standard output when there is no terminal (they are
#                          otherwise shown on the terminal only, once, and kept in a root-only file)
#   --yes                  do not ask for confirmation
#   -h, --help             show this text
#
# Environment (testing only): RP_ACME_SERVER=<directory URL> selects another ACME service, for example the
# Let's Encrypt staging environment. This server must already trust that service's root certificate
# (/usr/local/share/ca-certificates + update-ca-certificates), or the final health check fails.
set -euo pipefail
# Never trace: this script handles passwords and keys.
set +x
deploy_src=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")

# Everything below runs as root, so the files it is about to read must be under root's control alone: the
# clone, everything in it and every directory above it. This is checked before any of those files is used.
# (It cannot make an untrusted copy of this very script safe; clone it yourself, as root, from the repository.)
if [[ $EUID == 0 ]]; then
    custody_top=$(realpath -- "$deploy_src/..")
    custody_dir=$custody_top
    while :; do
        custody_mode=$(stat -c '%u:%A' -- "$custody_dir")
        # Root-owned and not writable by group or others. Above the clone, a root-owned sticky directory
        # (such as /tmp) is also acceptable.
        if [[ ! $custody_mode =~ ^0:d....-..-.$ ]] &&
           [[ $custody_dir == "$custody_top" || ! $custody_mode =~ ^0:d........[tT]$ ]]; then
            printf 'ReadyPackets: %s (owner:mode %s) must belong to root and must not be writable by anyone else.\nClone the repository as root into a root-owned directory:\n  sudo sh -c "umask 022 && git clone <url> /opt/readypackets-src"\n' "$custody_dir" "$custody_mode" >&2
            exit 1
        fi
        [[ $custody_dir != / ]] || break
        custody_dir=$(dirname -- "$custody_dir")
    done
    custody_bad=$(find "$custody_top" -xdev \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit)
    if [[ -n $custody_bad ]]; then
        printf 'ReadyPackets: the clone holds files that do not belong to root or that others can change\n(for example %s, owner:mode %s).\nClone the repository again as root:\n  sudo sh -c "umask 022 && git clone <url> /opt/readypackets-src"\n' "$custody_bad" "$(stat -c '%u:%A' -- "$custody_bad")" >&2
        exit 1
    fi
    unset custody_top custody_dir custody_bad custody_mode
fi
# shellcheck source=deploy/lib.sh
source "$deploy_src/lib.sh"

# --- pinned tools (integrity is checked against these values before anything is installed) -----------
readonly node_version=22.23.5
readonly -A node_sha256=(
    ['x64']=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
    ['arm64']=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09
)
readonly pnpm_version=12.21.0
readonly -A pnpm_sha512=(
    ['x64']=f1eb9f0a31d7b2929b352fe487cab843482a2683aebc2e10e69828b3a5d2f01cbf9c032d3fe8dff05d42c3d7abf38d247c05fe3c9fedb3e03daa72c4f75aef5d
    ['arm64']=e0e8ff885d930c27b695c1f49f84eea4f479b1276b34b725241eb104494b30f094380bc185d7f6ad195268ee4ce1eac9ea0e05cb2ed84d74e97267c5b0acb110
)
readonly node_home=/usr/local/lib/readypackets-node pnpm_home=/usr/local/lib/readypackets-pnpm

readonly schema=readypackets db_app=rp_app db_migrator=rp_migrator db_backup=rp_backup
readonly db_tls=/etc/mysql/readypackets-tls db_cnf=/etc/mysql/mysql.conf.d/zz-readypackets.cnf
readonly webroot=/var/www/readypackets-acme
readonly install_log=/var/log/readypackets-install.log
readonly credentials=/root/readypackets-initial-admin.txt
readonly pending_password="$conf/initial-admin-password" pending_email="$conf/initial-admin-email"
readonly admin_marker="$conf/admin-bootstrap-done" catalog_marker="$conf/catalog-import-done"
readonly db_marker="$conf/database-accounts-created" shown_marker="$conf/initial-admin-shown"
# Written by install.sh just before it first tries to create the administrator (see prepare_admin).
readonly attempt_marker="$conf/admin-bootstrap-attempted"
readonly swap_file=/swapfile.readypackets

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# --- options -------------------------------------------------------------------------------------------
domain='' alias='' acme_email='' self_signed=0 admin_email='' admin_name='Portal Administrator'
catalog=1 dns_check=1 assume_yes=0 print_credentials=0 swap_mode=auto
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }
while (($#)); do
    case $1 in
        --domain) need_value "$@"; domain=$2; shift 2 ;;
        --alias) need_value "$@"; alias=$2; shift 2 ;;
        --acme-email) need_value "$@"; acme_email=$2; shift 2 ;;
        --tls-self-signed) self_signed=1; shift ;;
        --admin-email) need_value "$@"; admin_email=$2; shift 2 ;;
        --admin-name) need_value "$@"; admin_name=$2; shift 2 ;;
        --skip-catalog) catalog=0; shift ;;
        --skip-dns-check) dns_check=0; shift ;;
        --swap) need_value "$@"; swap_mode=$2; shift 2 ;;
        --print-credentials) print_credentials=1; shift ;;
        --yes|-y) assume_yes=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 64 ;;
    esac
done

[[ $EUID == 0 ]] || die 'run as root (sudo bash deploy/auto-install.sh ...)'
# Held until this script ends; install.sh, started below, continues under the same lock.
lock_deploy

interactive=0
if [[ -t 0 && -t 1 ]]; then interactive=1; fi
ask() {  # ask <prompt> [default]
    local reply
    read -r -p "$1" reply </dev/tty
    printf '%s' "${reply:-${2:-}}"
}
# Accepts a pasted address such as https://Portal.Example.com/ and reduces it to the host name.
host_of() {
    local value=${1,,}
    value=${value#http://}; value=${value#https://}; value=${value%%/*}; value=${value%.}
    printf '%s' "$value"
}
valid_email() { [[ ${#1} -le 254 && $1 =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }

if [[ -z $domain ]]; then
    ((interactive)) || die 'give the public host name of the portal: --domain <host>'
    domain=$(ask 'Public host name of the portal [my.readypackets.com]: ' my.readypackets.com)
fi
domain=$(host_of "$domain")
valid_host "$domain" || die "not a valid public host name: $domain (a DNS name is required; IP addresses are refused)"
if [[ -n $alias ]]; then
    alias=$(host_of "$alias")
    valid_host "$alias" || die "not a valid alias host name: $alias"
    [[ $alias != "$domain" ]] || die 'the alias must differ from the portal host name'
fi
[[ -z $acme_email || $self_signed == 0 ]] || die 'use either --acme-email or --tls-self-signed, not both'
if [[ -z $acme_email && $self_signed == 0 ]]; then
    ((interactive)) || die 'give --acme-email <address> for a public certificate, or --tls-self-signed for testing'
    acme_email=$(ask "E-mail address for the Let's Encrypt certificate (empty = self-signed test certificate): ")
    if [[ -z $acme_email ]]; then self_signed=1; fi
fi
[[ -z $acme_email ]] || valid_email "$acme_email" || die "not a valid e-mail address: $acme_email"
if [[ -z $admin_email ]]; then
    admin_email=${acme_email:-admin@$domain}
    if ((interactive)) && [[ ! -e $admin_marker ]]; then
        admin_email=$(ask "Sign-in e-mail address of the first administrator [$admin_email]: " "$admin_email")
    fi
fi
valid_email "$admin_email" || die "not a valid e-mail address: $admin_email"
admin_email=${admin_email,,}
[[ -n $admin_name && ${#admin_name} -le 100 && $admin_name != -* && $admin_name != *[[:cntrl:]]* ]] ||
    die 'the administrator name must be 1 to 100 printable characters and must not start with a dash'
[[ $swap_mode == auto || $swap_mode == yes || $swap_mode == no ]] || die '--swap takes auto, yes or no'
tls_choice=letsencrypt
if ((self_signed)); then tls_choice=self-signed; fi

# --- checks that need nothing installed ----------------------------------------------------------------
[[ $(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID") == ubuntu:26.04 ]] ||
    die 'auto-install.sh supports Ubuntu 26.04 LTS. For Ubuntu 24.04 follow docs/operations/INSTALL.md.'
case $(uname -m) in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported processor architecture: $(uname -m)" ;;
esac
[[ -d /run/systemd/system ]] || die 'systemd must be running (containers without an init system are not supported)'
ram_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
swap_kb=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)
# Building the portal next to a running MySQL needs more than a 2 GB server has without swap.
add_swap=0
case $swap_mode in
    yes) add_swap=1 ;;
    auto) if ((ram_kb + swap_kb < 3000000)); then add_swap=1; fi ;;
esac
if [[ -e $swap_file ]]; then add_swap=0; fi  # added by an earlier run
if ((add_swap)); then
    ((ram_kb >= 900000)) || die "this server has $((ram_kb / 1024)) MB of memory; at least 1 GB (2 GB recommended) is needed"
elif [[ ! -e $swap_file ]]; then
    ((ram_kb + swap_kb >= 1800000)) || die "building the portal needs about 2 GB of memory including swap; this server has $(((ram_kb + swap_kb) / 1024)) MB.
Run again without \"--swap no\" to let this script add a swap file, or add swap yourself first."
fi
for mount in /opt /var /; do
    # A directory that does not exist yet will be created on the file system of its nearest parent.
    while [[ ! -d $mount ]]; do mount=$(dirname -- "$mount"); done
    free_kb=$(df --output=avail -k "$mount" | tail -1 | tr -d ' ')
    needed_kb=4000000
    if ((add_swap)) && [[ $mount == / ]]; then needed_kb=6200000; fi
    ((free_kb >= needed_kb)) || die "at least $((needed_kb / 1000000)) GB of free disk space is needed on $mount"
done
if [[ -e $conf/upgrade-state || -e $conf/install-migration-pending ]]; then
    die 'an earlier operation on this server needs manual reconciliation; see docs/operations/INSTALL.md'
fi

printf '\nReadyPackets portal: automatic installation\n\n'
printf '  Portal address       https://%s\n' "$domain"
if [[ -n $alias ]]; then printf '  Redirecting alias    %s\n' "$alias"; fi
if ((self_signed)); then
    printf '  Certificate          self-signed (testing; browsers will warn)\n'
else
    printf "  Certificate          Let's Encrypt, contact %s\n" "$acme_email"
fi
printf '  First administrator  %s (%s)\n' "$admin_email" "$admin_name"
if ((self_signed)); then
    printf '  Installs             Nginx, MySQL 8.4, Node.js %s, pnpm %s\n' "$node_version" "$pnpm_version"
else
    printf '  Installs             Nginx, MySQL 8.4, Certbot, Node.js %s, pnpm %s\n' "$node_version" "$pnpm_version"
fi
if ((add_swap)); then
    printf '  Swap                 adds a 2 GB swap file (%s); this server has %s MB of memory and %s MB of swap\n' \
        "$swap_file" "$((ram_kb / 1024))" "$((swap_kb / 1024))"
fi
printf '\n'
if ((!assume_yes)); then
    ((interactive)) || die 'no terminal to confirm on; add --yes'
    [[ $(ask 'Install now? [y/N] ') =~ ^[Yy]$ ]] || die 'cancelled; nothing was changed'
fi

# --- steps ---------------------------------------------------------------------------------------------
fetch() {  # fetch <https-url> <file>
    curl --disable --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --retry 3 --retry-delay 2 --max-time 600 --output "$2" "$1"
}
# --no-defaults: an option file left in root's home directory by a hosting image must not redirect this.
mysql_root() { mysql --no-defaults --protocol=socket --batch --skip-column-names "$@"; }

ensure_swap() {
    if [[ -e $swap_file ]]; then
        # Added by an earlier run; switched back on if a restart without the fstab entry dropped it.
        if ! swapon --show=NAME --noheadings | grep -qxF -- "$swap_file"; then swapon -- "$swap_file" || true; fi
        return
    fi
    if ((!add_swap)); then return; fi
    say 'Adding a 2 GB swap file (the build needs more memory than this server has free)'
    local ok=0
    # Written out in full rather than preallocated: that works as swap on every file system that allows it.
    if (umask 077; dd if=/dev/zero of="$swap_file" bs=1M count=2048 status=none) &&
       chmod 0600 -- "$swap_file" && mkswap --quiet -- "$swap_file" >/dev/null && swapon -- "$swap_file"; then
        ok=1
    fi
    if ((!ok)); then
        rm -f -- "$swap_file"
        ((ram_kb + swap_kb >= 1800000)) ||
            die 'the swap file could not be switched on (some virtual servers do not allow swap); this server needs about 2 GB of memory including swap'
        note 'the swap file could not be switched on here; continuing without it'
        return
    fi
    if ! awk -v file="$swap_file" '$1 == file { found = 1 } END { exit !found }' /etc/fstab 2>/dev/null; then
        # Kept across restarts. To remove it later: swapoff, delete this line, delete the file.
        [[ ! -s /etc/fstab || -z $(tail -c1 /etc/fstab) ]] || printf '\n' >> /etc/fstab
        printf '%s none swap sw 0 0\n' "$swap_file" >> /etc/fstab
    fi
    note "$swap_file is active and listed in /etc/fstab"
}

certbot_available() { [[ -n $(apt-cache policy certbot 2>/dev/null | awk '$1 == "Candidate:" && $2 != "(none)" { print $2 }') ]]; }
install_packages() {
    local -a packages=(ca-certificates curl git openssl xz-utils nginx mysql-server mysql-client)
    local -a tools=(nginx mysql mysqldump mysqld git curl openssl xz)
    if ((self_signed)); then
        say 'Installing system packages (Nginx, MySQL, Git, curl, OpenSSL)'
    else
        say 'Installing system packages (Nginx, MySQL, Certbot, Git, curl, OpenSSL)'
        packages+=(certbot)
        tools+=(certbot)
    fi
    if ! systemctl is-active --quiet nginx 2>/dev/null && command -v ss >/dev/null &&
       ss -Hltn 'sport = :80 or sport = :443' | grep -q .; then
        ss -Hltnp 'sport = :80 or sport = :443' >&2 || true
        die 'another program is already listening on port 80 or 443; this installer needs a dedicated server'
    fi
    (
        # Package scripts expect the usual umask; ours is stricter.
        umask 022
        export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
        apt-get -o DPkg::Lock::Timeout=600 update --quiet
        if ((!self_signed)) && ! certbot_available; then
            # Certbot is published in Ubuntu's "universe" component, which minimal images leave switched off.
            printf '    switching on the Ubuntu "universe" package component (Certbot is published there)\n'
            apt-get -o DPkg::Lock::Timeout=600 install --yes --quiet --no-install-recommends software-properties-common
            add-apt-repository --yes --no-update universe
            apt-get -o DPkg::Lock::Timeout=600 update --quiet
            certbot_available || {
                printf 'ReadyPackets: the certbot package is not available from this server'"'"'s package sources.\n' >&2
                exit 1
            }
        fi
        apt-get -o DPkg::Lock::Timeout=600 install --yes --quiet --no-install-recommends "${packages[@]}"
    )
    local tool
    for tool in "${tools[@]}"; do
        command -v "$tool" >/dev/null || die "$tool is missing after the package installation"
    done
    mysqld --version | grep -Eq 'Ver[[:space:]]+8\.4\.' ||
        die "this installer expects MySQL 8.4 from the Ubuntu 26.04 archive, found: $(mysqld --version)"
}

resolve_commit() {
    local top
    top=$(realpath -- "$deploy_src/..")
    [[ -d $top/.git ]] || die "run this script from a Git clone of the repository (no .git in $top)"
    [[ ! -L $top/.git && $(stat -c '%u' "$top") == 0 && $(stat -c '%u' "$top/.git") == 0 ]] ||
        die "the clone must belong to root; clone the repository again as root"
    [[ -z $(git -C "$top" status --porcelain --untracked-files=no) ]] ||
        die 'the clone has local changes to tracked files; install from an unmodified commit'
    commit=$(git -C "$top" rev-parse --verify 'HEAD^{commit}')
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || die 'could not determine the commit of this clone'
    if [[ -L $base/current ]]; then
        local active
        active=$(basename -- "$(readlink -f "$base/current")")
        [[ $active == "$commit" ]] ||
            die "this server already runs release $active; use deploy/upgrade.sh to move to another release"
    fi
    note "release: commit $commit"
}

install_node() {
    say "Installing Node.js $node_version"
    local current='' target="$node_home/v$node_version" work
    if [[ -e $node || -L $node ]]; then
        current=$("$node" --version 2>/dev/null || true)
        if [[ $(readlink -f -- "$node") != "$node_home"/* ]]; then
            "$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===22&&minor>=12?0:1)' 2>/dev/null ||
                die "$node is ${current:-not runnable} and was not installed by this script; Node.js 22.12 or later in the 22 series is required there"
            note "keeping the existing $node ($current)"
            return
        fi
        if [[ $current == "v$node_version" ]]; then note 'already installed'; return; fi
    fi
    work=$(mktemp -d)
    fetch "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$arch.tar.xz" "$work/node.tar.xz"
    printf '%s  %s\n' "${node_sha256[$arch]}" "$work/node.tar.xz" | sha256sum --check --status ||
        { rm -rf -- "$work"; die 'the Node.js download does not match its pinned SHA-256 checksum'; }
    # Only the runtime itself is installed: no npm, npx or corepack.
    tar -xJf "$work/node.tar.xz" -C "$work" --no-same-owner "node-v$node_version-linux-$arch/bin/node"
    install -d -o root -g root -m 0755 "$node_home" "$target"
    install -o root -g root -m 0755 "$work/node-v$node_version-linux-$arch/bin/node" "$target/node"
    rm -rf -- "$work"
    [[ $("$target/node" --version) == "v$node_version" ]] || die 'the installed Node.js runtime does not start'
    ln -sfn -- "$target/node" "$node.rp-new"
    mv -fT -- "$node.rp-new" "$node"
}

install_pnpm() {
    say "Installing pnpm $pnpm_version"
    local expected target="$pnpm_home/$pnpm_version" work top
    top=$(realpath -- "$deploy_src/..")
    expected=$(git -C "$top" show "$commit:package.json" |
        "$node" -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log(String(JSON.parse(s).packageManager).replace(/^pnpm@/,"").split("+")[0]))')
    [[ $expected == "$pnpm_version" ]] ||
        die "this release expects pnpm $expected but auto-install.sh pins $pnpm_version; update the pin and its checksums together"
    if [[ -e $pnpm || -L $pnpm ]]; then
        if [[ $("$pnpm" --version 2>/dev/null || true) == "$pnpm_version" ]]; then note 'already installed'; return; fi
        [[ $(readlink -f -- "$pnpm") == "$pnpm_home"/* ]] ||
            die "$pnpm exists, is not version $pnpm_version and was not installed by this script"
    fi
    work=$(mktemp -d)
    fetch "https://registry.npmjs.org/@pnpm/exe.linux-$arch/-/exe.linux-$arch-$pnpm_version.tgz" "$work/pnpm.tgz"
    printf '%s  %s\n' "${pnpm_sha512[$arch]}" "$work/pnpm.tgz" | sha512sum --check --status ||
        { rm -rf -- "$work"; die 'the pnpm download does not match its pinned SHA-512 checksum'; }
    tar -xzf "$work/pnpm.tgz" -C "$work" --no-same-owner package/pnpm
    install -d -o root -g root -m 0755 "$pnpm_home" "$target"
    install -o root -g root -m 0755 "$work/package/pnpm" "$target/pnpm"
    rm -rf -- "$work"
    [[ $("$target/pnpm" --version) == "$pnpm_version" ]] || die 'the installed pnpm does not start'
    ln -sfn -- "$target/pnpm" "$pnpm.rp-new"
    mv -fT -- "$pnpm.rp-new" "$pnpm"
}

configure_mysql() {
    say 'Configuring MySQL (loopback only, verified TLS)'
    local changed=0 work desired attempt
    if [[ ! -s $db_tls/ca.pem || ! -s $db_tls/server-cert.pem || ! -s $db_tls/server-key.pem ]]; then
        [[ ! -e $db_tls ]] || die "$db_tls exists but is incomplete; inspect it before retrying"
        # Work directories of an interrupted earlier attempt may hold the authority's key; remove them.
        rm -rf -- /etc/mysql/.readypackets-tls.????????
        (
            work=$(mktemp -d /etc/mysql/.readypackets-tls.XXXXXXXX)
            trap 'rm -rf -- "$work"' EXIT
            # A private authority that signs exactly one certificate; its key is discarded afterwards.
            openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
                -keyout "$work/ca-key.pem" -out "$work/ca.pem" -days 3650 -sha256 \
                -subj '/O=ReadyPackets/CN=ReadyPackets database CA' \
                -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
                -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
            openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
                -keyout "$work/server-key.pem" -out "$work/server.csr" \
                -subj '/O=ReadyPackets/CN=127.0.0.1' 2>/dev/null
            printf '%s\n' 'subjectAltName=IP:127.0.0.1,DNS:localhost' 'basicConstraints=critical,CA:FALSE' \
                'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' > "$work/server.ext"
            openssl x509 -req -in "$work/server.csr" -CA "$work/ca.pem" -CAkey "$work/ca-key.pem" -CAcreateserial \
                -out "$work/server-cert.pem" -days 3650 -sha256 -extfile "$work/server.ext" 2>/dev/null
            openssl verify -CAfile "$work/ca.pem" "$work/server-cert.pem" >/dev/null
            rm -f -- "$work/ca-key.pem" "$work/server.csr" "$work/server.ext" "$work/ca.srl"
            chown root:root "$work" "$work/ca.pem" "$work/server-cert.pem"
            chown mysql:mysql "$work/server-key.pem"
            chmod 0644 "$work/ca.pem" "$work/server-cert.pem"
            chmod 0600 "$work/server-key.pem"
            chmod 0755 "$work"
            mv -T -- "$work" "$db_tls"
            trap - EXIT
        )
        changed=1
    fi
    desired=$(printf '%s\n' \
        '# Managed by ReadyPackets auto-install.sh.' \
        '[mysqld]' \
        'bind-address = 127.0.0.1' \
        'mysqlx-bind-address = 127.0.0.1' \
        'skip_name_resolve = ON' \
        'local_infile = OFF' \
        'tls_version = TLSv1.2,TLSv1.3' \
        "ssl_ca = $db_tls/ca.pem" \
        "ssl_cert = $db_tls/server-cert.pem" \
        "ssl_key = $db_tls/server-key.pem")
    if [[ ! -f $db_cnf || $(<"$db_cnf") != "$desired" ]]; then
        printf '%s\n' "$desired" > "$db_cnf.rp-new"
        chmod 0644 "$db_cnf.rp-new"
        mv -fT -- "$db_cnf.rp-new" "$db_cnf"
        changed=1
    fi
    systemctl enable --quiet mysql
    if ((changed)); then systemctl restart mysql; else systemctl start mysql; fi
    for ((attempt = 1; attempt <= 30; attempt++)); do
        if [[ $(mysql_root --execute='SELECT 1' 2>/dev/null) == 1 ]]; then break; fi
        sleep 2
    done
    [[ $(mysql_root --execute='SELECT VERSION()') =~ ^8\.4\. ]] ||
        die 'cannot reach the local MySQL 8.4 server as root over its socket'
    [[ $(mysql_root --execute="SELECT CONCAT_WS(':', @@bind_address, @@skip_name_resolve, @@ssl_ca)") == "127.0.0.1:1:$db_tls/ca.pem" ]] ||
        die 'MySQL did not take the loopback and TLS settings; check /etc/mysql for overriding files'
}

db_login_ok() {  # db_login_ok <account> <password>: connects over TCP with a verified certificate
    local account=$1 password=$2
    [[ $(mysql --defaults-extra-file=<(printf '[client]\npassword=%s\n' "$password") \
        --protocol=tcp --host=127.0.0.1 --port=3306 --user="$account" \
        --ssl-mode=VERIFY_IDENTITY --ssl-ca="$db_tls/ca.pem" \
        --batch --skip-column-names --execute='SELECT 1' "$schema" 2>/dev/null) == 1 ]]
}

provision_database() {
    say 'Creating the database and its three accounts'
    local name present=0 tables existing app_pw migrator_pw backup_pw
    for name in database_url migrator_database_url backup_database_url; do
        if [[ -e $conf/secrets/$name || -L $conf/secrets/$name ]]; then ((present += 1)); fi
    done
    if ((present == 3)); then
        credentials_ok
        note 'credentials already in place; accounts left as they are'
        return
    fi
    tables=$(mysql_root --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$schema'")
    [[ $tables == 0 ]] ||
        die "the database '$schema' already holds tables but its credential files are incomplete; this installer never adopts or replaces accounts of a database with data"
    if ((present > 0)); then
        note 'discarding incomplete credential files left by an interrupted run (the database is still empty)'
        rm -f -- "$conf/secrets/database_url" "$conf/secrets/migrator_database_url" "$conf/secrets/backup_database_url"
    fi
    # Accounts with these names are only ever replaced when this installer created them itself.
    existing=$(mysql_root --execute="SELECT COUNT(*) FROM mysql.user WHERE user IN ('$db_app', '$db_migrator', '$db_backup')")
    if [[ $existing != 0 && ! -e $db_marker ]]; then
        die "MySQL already has an account named $db_app, $db_migrator or $db_backup that this installer did not create; remove or rename it first"
    fi
    : > "$db_marker"
    app_pw=$(openssl rand -hex 24) migrator_pw=$(openssl rand -hex 24) backup_pw=$(openssl rand -hex 24)
    [[ $app_pw =~ ^[0-9a-f]{48}$ && $migrator_pw =~ ^[0-9a-f]{48}$ && $backup_pw =~ ^[0-9a-f]{48}$ &&
       $app_pw != "$migrator_pw" && $app_pw != "$backup_pw" && $migrator_pw != "$backup_pw" ]] || die 'random source failed'
    # Mirrors Phase A of deploy/mysql/accounts.sql. The schema is empty, so accounts left behind by an
    # interrupted earlier attempt are replaced rather than adopted. Passwords travel on standard input.
    mysql_root <<SQL
CREATE DATABASE IF NOT EXISTS \`$schema\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
DROP USER IF EXISTS '$db_app'@'127.0.0.1', '$db_migrator'@'127.0.0.1', '$db_backup'@'127.0.0.1';
CREATE USER '$db_app'@'127.0.0.1' IDENTIFIED BY '$app_pw' REQUIRE SSL;
CREATE USER '$db_migrator'@'127.0.0.1' IDENTIFIED BY '$migrator_pw' REQUIRE SSL;
CREATE USER '$db_backup'@'127.0.0.1' IDENTIFIED BY '$backup_pw' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$schema\`.* TO '$db_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
    ON \`$schema\`.* TO '$db_migrator'@'127.0.0.1';
GRANT SELECT, SHOW VIEW ON \`$schema\`.* TO '$db_backup'@'127.0.0.1';
SQL
    if ! { db_login_ok "$db_app" "$app_pw" && db_login_ok "$db_migrator" "$migrator_pw" &&
           db_login_ok "$db_backup" "$backup_pw"; }; then
        die 'the new database accounts cannot sign in over verified TLS'
    fi
    write_dsn() {  # write_dsn <file> <account> <password>
        local file="$conf/secrets/$1" temp
        temp=$(mktemp "$conf/secrets/.dsn.XXXXXXXX")
        printf 'mysql://%s:%s@127.0.0.1:3306/%s?tls=required&tlsCaFile=%s/ca.pem\n' "$2" "$3" "$schema" "$db_tls" > "$temp"
        validate_dsn "$1" < "$temp" || { rm -f -- "$temp"; die 'generated database URL was rejected'; }
        mv -T -- "$temp" "$file"
    }
    write_dsn backup_database_url "$db_backup" "$backup_pw"
    write_dsn migrator_database_url "$db_migrator" "$migrator_pw"
    write_dsn database_url "$db_app" "$app_pw"
    unset app_pw migrator_pw backup_pw
    credentials_ok
}

prepare_nginx() {
    say 'Preparing Nginx'
    local entry stock removed_default=0
    shopt -s nullglob
    for entry in "$nginx_dir"/sites-enabled/* "$nginx_dir"/conf.d/*; do
        case $entry in
            "$nginx_dir/sites-enabled/default"|"$site"|"$acme_site") ;;
            *) shopt -u nullglob; die "Nginx already serves another site ($entry); this installer needs a dedicated server" ;;
        esac
    done
    shopt -u nullglob
    entry="$nginx_dir/sites-enabled/default"
    if [[ -e $entry || -L $entry ]]; then
        # Only the untouched page shipped with the package is switched off.
        stock=$(dpkg-query --show --showformat='${Conffiles}\n' nginx-common nginx 2>/dev/null |
            awk '$1 == "/etc/nginx/sites-available/default" { print $2 }')
        [[ -L $entry && $(readlink -f -- "$entry") == "$nginx_dir/sites-available/default" && -n $stock &&
           $(md5sum < "$nginx_dir/sites-available/default" | cut -d' ' -f1) == "$stock" ]] ||
            die 'the Nginx default site was modified; disable it yourself after checking it serves nothing else'
        rm -f -- "$entry"
        removed_default=1
        note 'switched off the packaged default page'
    fi
    nginx -t
    systemctl enable --quiet nginx
    if ((removed_default)) && systemctl is-active --quiet nginx; then
        # A restart rather than a reload: a reload is applied in the background, and until then the
        # packaged page would still answer (and log) the checks that follow. Nothing else is served yet.
        systemctl restart nginx
    else
        systemctl start nginx
        systemctl reload nginx
    fi
}

names_in_certificate() {  # names_in_certificate <pem>: succeeds when every configured name is covered
    local sans name
    sans=$(openssl x509 -in "$1" -noout -ext subjectAltName | tr ',' '\n' | sed 's/^[[:space:]]*//')
    for name in "$origin" ${alias_host:+"$alias_host"}; do
        grep -qxF "DNS:$name" <<<"$sans" || return 1
    done
}

self_signed_certificate() {
    say 'Creating a self-signed web certificate (testing)'
    if [[ -s $tls_dir/fullchain.pem && -s $tls_dir/privkey.pem ]]; then
        names_in_certificate "$tls_dir/fullchain.pem" ||
            die "the certificate in $tls_dir does not cover the configured names; remove that directory and run this script again"
        note 'already present'
        return
    fi
    local san="DNS:$origin"
    [[ -z $alias_host ]] || san+=",DNS:$alias_host"
    [[ ! -e $tls_dir ]] || die "$tls_dir exists but is incomplete; inspect it before retrying"
    rm -rf -- "$conf"/.tls.????????
    (
        work=$(mktemp -d "$conf/.tls.XXXXXXXX")
        trap 'rm -rf -- "$work"' EXIT
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
            -keyout "$work/privkey.pem" -out "$work/fullchain.pem" -days 825 -sha256 -subj "/CN=$origin" \
            -addext "subjectAltName=$san" -addext 'basicConstraints=critical,CA:FALSE' \
            -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=serverAuth' 2>/dev/null
        mv -T -- "$work" "$tls_dir"
        trap - EXIT
    )
}

public_certificate() {
    say "Requesting the public certificate (Let's Encrypt)"
    local name token body
    local -a names=(-d "$origin")
    [[ -z $alias_host ]] || names+=(-d "$alias_host")
    if [[ -r $tls_dir/fullchain.pem && -r $tls_dir/privkey.pem ]]; then
        names_in_certificate "$tls_dir/fullchain.pem" ||
            die "the existing certificate 'readypackets-portal' does not cover the configured names; reissue it with certbot"
        note 'already issued'
    else
        if [[ -L $site ]]; then
            # The portal is already served (with another certificate); its port 80 answers the challenge.
            note 'using the running portal site for the certificate challenge'
        else
            render_site "$deploy_src/nginx/readypackets-acme.conf.template" "$nginx_dir/sites-available/readypackets-acme.conf"
            ln -sfn -- "$nginx_dir/sites-available/readypackets-acme.conf" "$acme_site"
        fi
        nginx -t
        systemctl reload nginx
        # A check file, fetched the way the certificate authority will fetch its own. Certbot runs with the
        # usual umask below, and the directories exist beforehand, so that Nginx can read what Certbot writes.
        install -d -o root -g root -m 0755 "$webroot/.well-known" "$webroot/.well-known/acme-challenge"
        rm -f -- "$webroot/.well-known/acme-challenge"/rp-check-*
        token="rp-check-$(openssl rand -hex 16)"
        printf '%s\n' "$token" > "$webroot/.well-known/acme-challenge/$token"
        chmod 0644 "$webroot/.well-known/acme-challenge/$token"
        # Nginx applies a reload in the background; wait until it serves the challenge directory.
        local attempt
        for ((attempt = 1; attempt <= 20; attempt++)); do
            body=$(curl --disable --silent --noproxy '*' --max-time 5 --resolve "$origin:80:127.0.0.1" \
                "http://$origin/.well-known/acme-challenge/$token" || true)
            if [[ $body == "$token" ]]; then break; fi
            sleep 1
        done
        [[ $body == "$token" ]] || { rm -f -- "$webroot/.well-known/acme-challenge/$token"
            die "Nginx on this server does not serve $webroot over HTTP; check 'systemctl status nginx'"; }
        if ((dns_check)); then
            # Spares the certificate authority's rate limits: a request is only sent once each name is seen
            # to reach this server over plain HTTP.
            for name in "$origin" ${alias_host:+"$alias_host"}; do
                getent ahosts "$name" >/dev/null || { rm -f -- "$webroot/.well-known/acme-challenge/$token"
                    die "$name does not resolve yet. Point its DNS record at this server, wait for it to take effect and run this script again."; }
                body=$(curl --disable --silent --noproxy '*' --max-time 20 --retry 2 --retry-delay 2 \
                    "http://$name/.well-known/acme-challenge/$token" || true)
                [[ $body == "$token" ]] || { rm -f -- "$webroot/.well-known/acme-challenge/$token"
                    die "http://$name does not reach this server (DNS record, firewall or port 80). Fix it and run this script again, or add --skip-dns-check if this server cannot reach its own public address."; }
            done
        fi
        rm -f -- "$webroot/.well-known/acme-challenge/$token"
        (
            umask 022
            certbot certonly --webroot --webroot-path "$webroot" --cert-name readypackets-portal "${names[@]}" \
                --non-interactive --agree-tos --email "$acme_email" --no-eff-email --key-type ecdsa \
                ${RP_ACME_SERVER:+--server "$RP_ACME_SERVER"}
        )
        [[ -r $tls_dir/fullchain.pem && -r $tls_dir/privkey.pem ]] || die 'certbot did not leave a certificate behind'
    fi
    # Renewal: the packaged timer runs certbot; this hook makes Nginx pick the new certificate up.
    install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
    printf '%s\n' '#!/bin/sh' '# Managed by ReadyPackets auto-install.sh.' 'nginx -t && systemctl reload nginx' \
        > /etc/letsencrypt/renewal-hooks/deploy/readypackets-nginx
    chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/readypackets-nginx
    systemctl enable --now --quiet certbot.timer
}

generate_password() {
    # 20 characters from 28 (no vowels, no look-alikes), about 96 bits, in four groups for easy reading.
    local alphabet=bcdfghjkmnpqrstvwxyz23456789 out='' byte
    while ((${#out} < 20)); do
        byte=$(od -An -N1 -tu1 /dev/urandom | tr -d ' \n')
        if ((byte >= 252)); then continue; fi  # 252 = 9 x 28: rejection sampling, no modulo bias
        out+=${alphabet:byte % 28:1}
    done
    printf '%s-%s-%s-%s' "${out:0:5}" "${out:5:5}" "${out:10:5}" "${out:15:5}"
}

prepare_admin() {
    if [[ -e $admin_marker ]]; then return; fi
    if [[ -s $pending_password && -s $pending_email && -s $credentials ]]; then
        # An earlier run stopped after preparing the account. Its details are kept so that the saved
        # sign-in stays correct whether or not the account had already been created.
        admin_email=$(<"$pending_email")
        note "continuing with the administrator prepared by an earlier run ($admin_email)"
        return
    fi
    # A new password: no earlier attempt can have created an account with it.
    rm -f -- "$attempt_marker"
    rm -f -- "$pending_password" "$pending_email"
    local password
    password=$(generate_password)
    [[ $password =~ ^([bcdfghjkmnpqrstvwxyz23456789]{5}-){3}[bcdfghjkmnpqrstvwxyz23456789]{5}$ ]] || die 'random source failed'
    # Saved before the account exists, so an interruption can never leave an account whose password is lost.
    printf '%s\n' "$password" > "$pending_password"
    printf '%s\n' "$admin_email" > "$pending_email"
    printf '%s\n' \
        'ReadyPackets portal: first administrator' \
        '' \
        "  Portal address : https://$origin" \
        "  Sign-in name   : $admin_email" \
        "  Password       : $password   (temporary)" \
        '' \
        'At the first sign-in the portal asks for a new password and the enrolment of an authenticator app.' \
        "Delete this file afterwards:  sudo rm $credentials" > "$credentials.rp-new"
    chmod 0600 "$credentials.rp-new"
    mv -fT -- "$credentials.rp-new" "$credentials"
    unset password
}

finish_admin() {
    # install.sh recorded what happened: "created"; "existing" when the account was found on a repeated
    # attempt with the same prepared password (an interrupted run had most likely created it); "preexisting"
    # when the database already had an administrator before the first attempt.
    local outcome
    outcome=$(<"$admin_marker")
    if [[ -e $pending_password ]]; then
        if [[ $outcome == preexisting ]]; then
            # The password generated here was never used.
            rm -f -- "$credentials"
            printf 'unused\n' > "$conf/initial-admin-outcome"
        else
            printf '%s\n' "$outcome" > "$conf/initial-admin-outcome"
        fi
        rm -f -- "$pending_password" "$pending_email" "$attempt_marker"
    fi
}

finish_database() {
    say 'Granting the backup account its ledger tables'
    # Phase B of deploy/mysql/accounts.sql; the tables exist once the first migration has run.
    mysql_root <<SQL
GRANT INSERT, UPDATE ON \`$schema\`.\`backup_archives\` TO '$db_backup'@'127.0.0.1';
GRANT INSERT ON \`$schema\`.\`backup_verifications\` TO '$db_backup'@'127.0.0.1';
GRANT INSERT ON \`$schema\`.\`audit_events\` TO '$db_backup'@'127.0.0.1';
SQL
}

load_catalog() {
    if ((!catalog)); then return; fi
    if [[ -e $catalog_marker ]]; then
        say 'ReadyPackets offerings were loaded by an earlier run; not loading them again'
        return
    fi
    say 'Loading the ReadyPackets offerings (packets, tiers, prices)'
    import_catalog --dry-run
    import_catalog
    : > "$catalog_marker"
}

run_steps() {
    ensure_swap
    install_packages
    resolve_commit
    install_node
    install_pnpm
    configure_mysql
    check_host
    prepare_dirs
    # On a server that already serves the portal, the recorded certificate mode keeps describing the
    # certificate in use until the newly chosen one exists.
    local recorded_mode=$tls_choice
    if [[ -L $site && -s $site_conf ]]; then recorded_mode=$tls_mode; fi
    write_site "$domain" "$alias" "$recorded_mode"
    provision_database
    prepare_nginx
    if [[ $tls_choice == self-signed ]]; then
        tls_mode=self-signed tls_dir="$conf/tls"
        self_signed_certificate
    else
        tls_mode=letsencrypt tls_dir=/etc/letsencrypt/live/readypackets-portal
        public_certificate
    fi
    write_site "$domain" "$alias" "$tls_choice"
    prepare_admin
    say 'Building and starting the portal (this takes several minutes)'
    RP_BOOTSTRAP_ADMIN_EMAIL=$admin_email RP_BOOTSTRAP_ADMIN_NAME=$admin_name \
        RP_BOOTSTRAP_ADMIN_PASSWORD_FILE=$pending_password \
        bash "$deploy_src/install.sh" --unattended "$commit"
    finish_admin
    finish_database
    load_catalog
    if [[ $tls_mode == letsencrypt ]] &&
       ! curl --disable --silent --fail --max-time 20 --output /dev/null "https://$origin/readyz"; then
        note "this server could not reach https://$origin through its public address; check it from another machine"
    fi
}

: >> "$install_log"
chmod 0600 "$install_log"
printf '\n=== auto-install %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$install_log"
# The steps write to the terminal and to the log. The sign-in details below go to the terminal only.
# (A subshell with its own "set -e": inside an "if" the shell would ignore failing steps.)
set +e
(set -e; run_steps) 2>&1 | tee -a "$install_log"
steps_status=${PIPESTATUS[0]}
set -e
if ((steps_status != 0)); then
    printf '\nReadyPackets: the installation did not finish. The steps above show where it stopped; the same\noutput is in %s. After fixing the cause, run the same command again.\n' "$install_log" >&2
    exit 1
fi

load_site
printf '\n==================================================================\n'
printf ' ReadyPackets is installed and running at https://%s\n' "$origin"
printf '==================================================================\n\n'
outcome=''
if [[ -s $conf/initial-admin-outcome ]]; then outcome=$(<"$conf/initial-admin-outcome"); fi
# The temporary password is shown once, on the terminal of the person installing. Without a terminal it is
# only printed when --print-credentials asks for it; it always stays in the root-only file until deleted.
if [[ -s $credentials && ! -e $shown_marker ]]; then
    if { : > /dev/tty; } 2>/dev/null; then
        sed 's/^/  /' "$credentials" > /dev/tty
        : > "$shown_marker"
    elif ((print_credentials)); then
        sed 's/^/  /' "$credentials"
        : > "$shown_marker"
    else
        printf '  The first administrator was created. No terminal is attached, so the sign-in details are not\n  printed. Read them as root:  sudo cat %s\n' "$credentials"
    fi
    if [[ $outcome == existing ]]; then
        printf '\n  Note: this administrator already existed when this run reached that step, most likely created by an\n  earlier, interrupted run with the same password.\n'
    fi
elif [[ -s $credentials ]]; then
    printf '  First administrator: %s\n  The temporary password was shown when the installation finished. Until you delete the file it\n  can be read as root:  sudo cat %s\n' \
        "$(sed -n 's/^  Sign-in name   : //p' "$credentials")" "$credentials"
elif [[ $outcome == unused ]]; then
    printf '  An administrator already existed in this database, so no new account was created.\n'
else
    printf '  The first administrator was created by an earlier run and its saved sign-in details\n  (%s) have been deleted since.\n' "$credentials"
fi
printf '\n  Next steps\n'
printf '    - Sign in, choose a new password and enrol an authenticator app.\n'
printf '    - Configure outgoing mail (SMTP) in the administration console; until then invitations and\n      password resets are held.\n'
printf '    - Firewall: this script does not change it. Allow only SSH, 80 and 443 from outside.\n'
printf '    - Backups: run "sudo systemctl start readypackets-backup@cli.service", check the result with\n      "sudo journalctl -u readypackets-backup@cli.service", then enable the daily timer with\n      "sudo systemctl enable --now readypackets-backup.timer".\n'
printf '      Archives (/var/lib/readypackets/storage/backups) and the keys in /etc/readypackets/secrets are both on\n      this server. Keep a copy of each somewhere else; an archive cannot be restored without the keys.\n'
if [[ $tls_mode == self-signed ]]; then
    printf '    - The certificate is self-signed: browsers warn and passkeys may be refused.\n'
fi
printf '\n  Installation log: %s\n\n' "$install_log"
