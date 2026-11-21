#!/usr/bin/env bash
# Makes a GitHub-hosted Ubuntu 26.04 runner look like a newly provisioned server before
# deploy/auto-install.sh is tried on it: the database, web servers and Node.js toolchain that the runner
# image ships are removed, and the checked-out commit is cloned into a root-owned directory, which is what
# the installation guide tells an operator to do.
#
#   native-install-prepare.sh <portal-host> <alias-host> [without-universe]
#
# "without-universe" also switches off Ubuntu's "universe" package component, as minimal server images do.
set -euo pipefail
[[ $EUID == 0 && ($# == 2 || ($# == 3 && $3 == without-universe)) ]] ||
    { echo 'usage: sudo native-install-prepare.sh <portal-host> <alias-host> [without-universe]' >&2; exit 64; }
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'this script removes software; it only runs on a CI runner' >&2; exit 1; }
readonly source_dir=${GITHUB_WORKSPACE:?} target=/opt/readypackets-src
export DEBIAN_FRONTEND=noninteractive

systemctl stop mysql.service nginx.service apache2.service 2>/dev/null || true
mapfile -t packages < <(dpkg-query --show --showformat='${Package}\n' |
    grep -E '^(mysql-|libmysqlclient|nginx|libnginx|apache2|certbot|python3-certbot|python3-acme)' || true)
if ((${#packages[@]})); then apt-get purge --yes --quiet "${packages[@]}"; fi
apt-get autoremove --purge --yes --quiet
rm -rf /etc/mysql /var/lib/mysql /var/lib/mysql-files /var/lib/mysql-keyring /var/log/mysql \
    /etc/nginx /var/log/nginx /var/www/html /etc/apache2 /etc/letsencrypt
rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
hash -r
for tool in mysql mysqld nginx apache2 certbot; do
    if command -v "$tool" >/dev/null; then echo "still present after the clean-up: $tool" >&2; exit 1; fi
done
if ss -Hltn | awk '{print $4}' | grep -Eq ':(80|443|3306|5000)$'; then
    echo 'a port the portal needs is still in use:' >&2
    ss -Hltnp >&2
    exit 1
fi

if [[ ${3:-} == without-universe ]]; then
    sources=/etc/apt/sources.list.d/ubuntu.sources
    grep -Eq '^Components:.* universe' "$sources" || { echo "unexpected package sources layout in $sources" >&2; cat "$sources" >&2; exit 1; }
    sed -i -E '/^Components:/ s/ (universe|multiverse)//g' "$sources"
    apt-get update --quiet
    if [[ -n $(apt-cache policy certbot | awk '$1 == "Candidate:" && $2 != "(none)" { print $2 }') ]]; then
        echo 'certbot is still installable although universe was switched off' >&2; exit 1
    fi
    echo 'Prepared without the universe component.'
fi

# The test names resolve to this machine, as a DNS record would on a real server.
printf '127.0.0.1 %s %s\n' "$1" "$2" >> /etc/hosts

# The runner image leaves /opt writable by everyone, with a default ACL that makes new files writable by
# everyone too; a server has a plain root-owned /opt, and the installer insists on that.
getfacl --absolute-names /opt 2>/dev/null || true
if command -v setfacl >/dev/null; then setfacl --remove-all --remove-default /opt; fi
chown root:root /opt
chmod 0755 /opt
rm -rf -- "$target"
umask 022
git -c safe.directory="$source_dir" clone --quiet --no-hardlinks "$source_dir" "$target"
git -C "$target" -c advice.detachedHead=false checkout --quiet --detach "$(git -c safe.directory="$source_dir" -C "$source_dir" rev-parse HEAD)"
chown -R root:root "$target"
stat -c 'clone: %U:%G %A %n' /opt "$target" "$target/deploy/auto-install.sh"
printf 'Prepared: %s, %s, commit %s\n' "$(. /etc/os-release; echo "$PRETTY_NAME")" "$(uname -m)" "$(git -C "$target" rev-parse HEAD)"
free -m | sed -n '1,3p'
df -h / | tail -1
