#!/usr/bin/env bash
# Runs deploy/auto-install.sh on a CI runner and checks what it printed.
#
#   native-install-run.sh first <auto-install options...>    first installation
#   native-install-run.sh again <auto-install options...>    second run on the installed machine
#   native-install-run.sh diagnostics                        state of the machine after a failure
#
# The installer's output is shown as it is produced, with the generated administrator password masked, so
# that it does not end up in a public build log. The unmasked copy stays in a root-only file for the checks.
set -euo pipefail
[[ $EUID == 0 && $# -ge 1 ]] || { echo 'usage: sudo native-install-run.sh <first|again|diagnostics> [options...]' >&2; exit 64; }
readonly mode=$1 source=/opt/readypackets-src credentials=/root/readypackets-initial-admin.txt
shift
umask 077
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
mask() { sed -u -E 's/(Password +: )[^ ]+/\1[masked in CI]/'; }
run_installer() {  # run_installer <output-file> <options...>
    local out=$1 status=0
    shift
    : > "$out"
    set +e
    bash "$source/deploy/auto-install.sh" "$@" 2>&1 | tee -a "$out" | mask
    status=${PIPESTATUS[0]}
    set -e
    return "$status"
}
saved_password() { sed -n 's/^  Password       : \([^ ]*\) .*$/\1/p' "$credentials"; }

case $mode in
    first)
        started=$(date +%s)
        run_installer /root/auto-install-first.out "$@" || fail 'the installer did not finish'
        printf '\nInstallation took %s seconds.\n' "$(($(date +%s) - started))"
        out=/root/auto-install-first.out
        grep -q 'ReadyPackets is installed and running at https://' "$out" || fail 'no final summary was printed'
        password=$(saved_password)
        [[ -n $password ]] || fail 'no password was saved'
        # The summary shows the sign-in name and the temporary password exactly once, at the very end.
        expect_count=$(grep -cF -- "$password" "$out")
        [[ $expect_count == 1 ]] || fail "the password appears $expect_count times in the output, expected once"
        tail -n 25 "$out" | grep -qF -- "$password" || fail 'the password is not in the final summary'
        tail -n 25 "$out" | grep -q 'Sign-in name   : ' || fail 'the sign-in name is not in the final summary'
        sha256sum "$credentials" > /root/auto-install-credentials.sha256
        ;;
    again)
        pid_before=$(systemctl show readypackets-portal.service -p MainPID --value)
        release_before=$(readlink -f /opt/readypackets/current)
        run_installer /root/auto-install-again.out "$@" || fail 'the second run did not finish'
        out=/root/auto-install-again.out
        sha256sum --check --status /root/auto-install-credentials.sha256 || fail 'the saved sign-in details changed'
        grep -cF -- "$(saved_password)" "$out" | grep -qx 1 || fail 'the second run did not show the same sign-in details once'
        [[ $(systemctl show readypackets-portal.service -p MainPID --value) == "$pid_before" ]] || fail 'the portal was restarted'
        [[ $(readlink -f /opt/readypackets/current) == "$release_before" ]] || fail 'the release changed'
        [[ $(mysql --protocol=socket --batch --skip-column-names --execute="SELECT COUNT(*) FROM readypackets.users WHERE role = 'admin'") == 1 ]] ||
            fail 'a second administrator was created'
        grep -q 'not loading them again' "$out" || fail 'the offerings were loaded twice'
        [[ $(systemctl is-active readypackets-portal.service readypackets-worker.service | sort -u) == active ]] || fail 'a service is not active'
        ;;
    diagnostics)
        systemctl --no-pager --full status readypackets-portal.service readypackets-worker.service nginx.service mysql.service | tail -n 80 || true
        for unit in readypackets-portal.service readypackets-worker.service readypackets-backup@cli.service nginx.service mysql.service; do
            printf '\n--- journal: %s\n' "$unit"
            journalctl --unit="$unit" --no-pager --lines=60 --output=cat || true
        done
        printf '\n--- nginx -t\n'; nginx -t || true
        printf '\n--- listeners\n'; ss -Hltnp || true
        printf '\n--- /etc/readypackets\n'; ls -la /etc/readypackets /etc/readypackets/secrets 2>/dev/null || true
        printf '\n--- memory\n'; free -m || true
        ;;
    *) echo "unknown mode: $mode" >&2; exit 64 ;;
esac
