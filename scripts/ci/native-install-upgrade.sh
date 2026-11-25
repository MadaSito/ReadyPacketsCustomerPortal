#!/usr/bin/env bash
# End-to-end native upgrade verification on a fresh Ubuntu 26.04 runner:
#   1. Switch /opt/readypackets-src (prepared by native-install-prepare.sh) to the selected baseline release
#      and install it with deploy/auto-install.sh via native-install-run.sh.
#   2. Over verified TLS, complete first-admin MFA enrollment + forced password change, create a customer
#      and a real order, switch on Maintenance mode, and confirm queue_drained.
#   3. Advance /opt/readypackets-src (root-owned, umask 022) to the commit under test, verify upgrade.sh
#      refusal gates, and run deploy/upgrade.sh --yes <candidate-sha>.
#   4. Verify release symlinks (previous -> baseline, current -> HEAD), verified pre-upgrade backup archive,
#      post-upgrade admin sign-in + MFA, Maintenance mode clear, pre-upgrade order + customer preservation,
#      migrations 0003 through 0007 exactly once each, and existing integration endpoints.
#   5. Run the full scripts/ci/native-install-smoke.sh suite against the upgraded installation.
set -euo pipefail
set +x

[[ $EUID == 0 && ( $# == 3 || $# == 4 ) ]] || {
    printf 'usage: sudo native-install-upgrade.sh <portal-host> <alias-host> <admin-email> [baseline-commit]\n' >&2
    exit 64
}

readonly host=$1
readonly alias_host=$2
readonly requested_admin_email=$3
readonly baseline_ref=${4:-89c5cb8}
[[ $baseline_ref == 89c5cb8 || $baseline_ref == f251a10 ]] || { printf 'unexpected CI baseline\n' >&2; exit 64; }
readonly origin="https://$host"
readonly repo_dir=/opt/readypackets-src
readonly ca_cert=/etc/readypackets/tls/fullchain.pem
readonly credentials=/root/readypackets-initial-admin.txt
ci_scripts_dir=$(dirname "$(realpath -- "${BASH_SOURCE[0]}")")
readonly ci_scripts_dir
# shellcheck source=scripts/ci/assert-release-migrations.sh
source "$ci_scripts_dir/assert-release-migrations.sh"

umask 077
work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() {
    local label=$1 got=$2 want=$3
    [[ $got == "$want" ]] || fail "$label: expected '$want', got '$got'"
}

candidate_sha=$(git -C "$repo_dir" rev-parse --verify HEAD)
baseline_sha=$(git -C "$repo_dir" rev-parse --verify "${baseline_ref}^{commit}")
[[ $candidate_sha != "$baseline_sha" ]] || fail 'candidate commit must differ from baseline commit'

step "checking out baseline release ($baseline_sha) in $repo_dir"
(
    umask 022
    git -C "$repo_dir" -c advice.detachedHead=false checkout --quiet --detach "$baseline_sha"
)
chown -R root:root -- "$repo_dir"
chmod -R go-w -- "$repo_dir"

step "installing baseline release ($baseline_sha) with deploy/auto-install.sh"
bash "$ci_scripts_dir/native-install-run.sh" first \
    --domain "$host" \
    --alias "$alias_host" \
    --tls-self-signed \
    --admin-email "$requested_admin_email" \
    --print-credentials \
    --yes
expect 'baseline current symlink' "$(readlink -f /opt/readypackets/current)" "/opt/readypackets/releases/$baseline_sha"
if [[ $baseline_ref == 89c5cb8 ]]; then
    [[ ! -x /usr/bin/ffmpeg && ! -e /var/lib/readypackets/geo ]] || fail 'baseline unexpectedly installed Increment 04 dependencies'
else
    query_baseline_journal() { mysql --no-defaults --protocol=socket --batch --skip-column-names --execute="$1"; }
    assert_release_migrations /opt/readypackets/current/migrations query_baseline_journal 0006_increment_06
    [[ ! -e /opt/readypackets/current/migrations/0007_increment_07.sql ]] || fail 'expected a pre-0007 baseline'
fi

admin_email=$(sed -n 's/^  Sign-in name   : //p' "$credentials")
sed -n 's/^  Password       : \([^ ]*\) .*$/\1/p' "$credentials" > "$work/initial.password"
[[ -n $admin_email && -s $work/initial.password ]] || fail 'initial administrator credentials were not written'

# Generate a strong post-enrollment administrator password stored only in a root-only temp file.
openssl rand -base64 24 | tr '/+' 'ab' | tr -d '=\n' > "$work/permanent.password"
printf -- '-Rp9!' >> "$work/permanent.password"

step 'enrolling MFA, changing forced password, creating customer + order, and draining maintenance on baseline'
python3 - "$origin" "$ca_cert" "$admin_email" "$work/initial.password" "$work/permanent.password" "$work/state.json" <<'PY'
import base64
import hashlib
import hmac
import http.cookiejar
import json
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

origin, ca_cert, admin_email, init_pw_path, perm_pw_path, state_path = sys.argv[1:7]
initial_pw = open(init_pw_path, encoding="utf-8").read().strip()
permanent_pw = open(perm_pw_path, encoding="utf-8").read().strip()

ctx = ssl.create_default_context(cafile=ca_cert)
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ctx),
    urllib.request.HTTPCookieProcessor(jar),
)


def csrf_token() -> str:
    for cookie in jar:
        if cookie.name == "__Host-rp_csrf":
            return urllib.parse.unquote(cookie.value)
    req = urllib.request.Request(
        f"{origin}/api/csrf",
        headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"},
        method="GET",
    )
    with opener.open(req, timeout=20):
        pass
    for cookie in jar:
        if cookie.name == "__Host-rp_csrf":
            return urllib.parse.unquote(cookie.value)
    raise RuntimeError("CSRF cookie was not issued")


def trpc_query(procedure: str, payload=None):
    url = f"{origin}/api/trpc/{procedure}"
    if payload is not None:
        encoded = urllib.parse.quote(json.dumps({"json": payload}), safe="")
        url = f"{url}?input={encoded}"
    req = urllib.request.Request(
        url,
        headers={"Origin": origin, "Sec-Fetch-Site": "same-origin", "Accept": "application/json"},
        method="GET",
    )
    with opener.open(req, timeout=20) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["result"]["data"]["json"]


def trpc_mutate(procedure: str, payload=None):
    token = csrf_token()
    wire = {"json": None, "meta": {"values": ["undefined"]}} if payload is None else {"json": payload}
    data = json.dumps(wire).encode("utf-8")
    req = urllib.request.Request(
        f"{origin}/api/trpc/{procedure}",
        data=data,
        headers={
            "Origin": origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-rp-csrf": token,
        },
        method="POST",
    )
    try:
        with opener.open(req, timeout=25) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{procedure} failed ({exc.code}): {detail}") from exc
    return body["result"]["data"]["json"]


def totp_now(secret_b32: str) -> str:
    padded = secret_b32.strip().upper()
    padded += "=" * ((8 - len(padded) % 8) % 8)
    key = base64.b32decode(padded, casefold=True)
    counter = int(time.time()) // 30
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


csrf_token()
signin = trpc_mutate("identity.signIn", {"email": admin_email, "password": initial_pw})
assert signin["nextStep"] == "enroll_mfa", f"unexpected nextStep: {signin}"

enrolled = trpc_mutate("assurance.beginTotpEnrollment")
confirmed = trpc_mutate("assurance.confirmTotpEnrollment", {"code": totp_now(enrolled["secret"])})
recovery_codes = confirmed["recoveryCodes"]
recovery_set_id = confirmed["recoverySetId"]
assert isinstance(recovery_codes, list) and len(recovery_codes) >= 4 and recovery_set_id, "missing recovery codes"
trpc_mutate("assurance.acknowledgeRecoveryCodes", {"recoverySetId": recovery_set_id})

me_before_pw = trpc_query("identity.me")
assert me_before_pw["nextStep"] == "change_password", f"expected change_password, got {me_before_pw}"
changed = trpc_mutate("identity.changePassword", {"currentPassword": initial_pw, "newPassword": permanent_pw})
assert changed["nextStep"] is None, f"expected full session after password change, got {changed}"

me_full = trpc_query("identity.me")
assert me_full["state"] == "full" and me_full["nextStep"] is None, f"expected full session, got {me_full}"

# Fresh step-up using recovery code #0 so we never collide with the TOTP replay window.
trpc_mutate(
    "assurance.stepUp",
    {"password": permanent_pw, "factor": {"method": "recovery_code", "code": recovery_codes[0]}},
)

customer = trpc_mutate(
    "identity.admin.customers.create",
    {"email": f"customer@{origin.removeprefix('https://')}", "name": "Pre-Upgrade Customer"},
)
# Capture the actual reference for the round-trip check, not an earlier release's ID format.
assert isinstance(customer["customerRef"], str) and customer["customerRef"], f"missing customer reference: {customer}"

groups = trpc_query("orders.catalog.list")
products = [prod for group in groups for prod in group.get("products", [])]
assert products, "expected imported catalog products on baseline"
first_product_id = products[0]["publicId"]

order = trpc_mutate(
    "orders.create",
    {
        "projectName": "Pre-Upgrade Order",
        "items": [{"productPublicId": first_product_id, "quantity": 1}],
        "note": "Created on baseline release before upgrade.",
        "idempotencyKey": "ci-pre-upgrade-order-0001",
    },
)
assert order["publicId"] and order["reference"], f"unexpected order result: {order}"

# Wait briefly for any queued invitation mail job to settle before switching on Maintenance.
for _ in range(20):
    maint_probe = trpc_query("jobs.admin.maintenance")
    if maint_probe["running"] == 0 and maint_probe["unresolved"] == 0:
        break
    time.sleep(0.5)

maint_on = trpc_mutate("jobs.admin.setMaintenance", {"active": True, "expectedActive": False})
assert maint_on["active"] is True

drained = None
for _ in range(30):
    drained = trpc_query("jobs.admin.maintenance")
    if drained["active"] is True and drained["state"] == "queue_drained":
        break
    time.sleep(1)
assert drained and drained["state"] == "queue_drained", f"queue did not drain: {drained}"

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "totpSecret": enrolled["secret"],
            "unusedRecoveryCodes": recovery_codes[1:],
            "customerPublicId": customer["customerId"],
            "customerRef": customer["customerRef"],
            "orderPublicId": order["publicId"],
            "orderReference": order["reference"],
            "productPublicId": first_product_id,
        },
        fh,
    )
PY

step "advancing $repo_dir to candidate commit $candidate_sha"
(
    umask 022
    git -C "$repo_dir" -c advice.detachedHead=false checkout --quiet --detach "$candidate_sha"
)
chown -R root:root -- "$repo_dir"
chmod -R go-w -- "$repo_dir"
expect 'checked-out candidate commit' "$(git -C "$repo_dir" rev-parse HEAD)" "$candidate_sha"

step 'verifying upgrade.sh safety refusals before upgrading'
if runuser -u nobody -- bash "$repo_dir/deploy/upgrade.sh" --yes "$candidate_sha" >"$work/refusal.out" 2>&1; then
    fail 'upgrade.sh allowed a non-root run'
fi
grep -qF 'run as root' "$work/refusal.out" || fail 'unexpected non-root refusal message'
if bash "$repo_dir/deploy/upgrade.sh" --yes "$baseline_sha" >"$work/refusal.out" 2>&1; then
    fail 'upgrade.sh allowed upgrading to a commit other than checked-out HEAD'
fi
grep -qF 'does not match target commit' "$work/refusal.out" || fail 'unexpected HEAD mismatch refusal message'

query_release_journal() { mysql --no-defaults --protocol=socket --batch --skip-column-names --execute="$1"; }
order_pins_sql='SELECT id, workflow_version_id FROM readypackets.orders ORDER BY id'
order_pins_before=$(query_release_journal "$order_pins_sql")
[[ -n $order_pins_before ]] || fail 'baseline was not seeded with a pinned order'

step "running deploy/upgrade.sh --yes $candidate_sha"
upgrade_start=$SECONDS
bash "$repo_dir/deploy/upgrade.sh" --yes "$candidate_sha" | tee "$work/upgrade.stdout"
printf 'Upgrade finished in %ds.\n' "$((SECONDS - upgrade_start))"

grep -q 'Verified pre-upgrade encrypted backup:' "$work/upgrade.stdout" || fail 'upgrade did not report verified pre-upgrade backup'
grep -q 'Upgrade verified and public traffic is open.' "$work/upgrade.stdout" || fail 'upgrade did not print completion confirmation'
expect 'upgraded current symlink' "$(readlink -f /opt/readypackets/current)" "/opt/readypackets/releases/$candidate_sha"
expect 'previous rollback symlink' "$(readlink -f /opt/readypackets/previous)" "/opt/readypackets/releases/$baseline_sha"
[[ ! -e /etc/nginx/readypackets-maintenance ]] || fail 'maintenance sentinel remained after upgrade'
[[ ! -e /etc/readypackets/upgrade-state ]] || fail 'upgrade-state file remained after upgrade'

pre_upgrade_backups=$(mysql --no-defaults --protocol=socket --batch --skip-column-names \
    --execute="SELECT COUNT(*) FROM readypackets.backup_archives WHERE trigger_kind = 'pre_upgrade' AND state = 'completed' AND verification_status = 'verified'")
expect 'verified pre_upgrade backup count' "$pre_upgrade_backups" 1

step 'verifying each candidate migration after the baseline was applied exactly once'
assert_release_migrations "$repo_dir/migrations" query_release_journal \
    0003_increment_04 0004_increment_04_part_b 0005_increment_05 0006_increment_06 0007_increment_07
expect 'existing order workflow pins' "$(query_release_journal "$order_pins_sql")" "$order_pins_before"

step 'verifying post-upgrade sign-in, MFA, Maintenance clear, pre-upgrade order survival and existing integration routes'
python3 - "$origin" "$ca_cert" "$admin_email" "$work/permanent.password" "$work/state.json" <<'PY'
import http.cookiejar
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

origin, ca_cert, admin_email, perm_pw_path, state_path = sys.argv[1:6]
permanent_pw = open(perm_pw_path, encoding="utf-8").read().strip()
state = json.load(open(state_path, encoding="utf-8"))
recovery_codes = state["unusedRecoveryCodes"]

ctx = ssl.create_default_context(cafile=ca_cert)
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ctx),
    urllib.request.HTTPCookieProcessor(jar),
)


def csrf_token() -> str:
    for cookie in jar:
        if cookie.name == "__Host-rp_csrf":
            return urllib.parse.unquote(cookie.value)
    req = urllib.request.Request(
        f"{origin}/api/csrf",
        headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"},
        method="GET",
    )
    with opener.open(req, timeout=20):
        pass
    for cookie in jar:
        if cookie.name == "__Host-rp_csrf":
            return urllib.parse.unquote(cookie.value)
    raise RuntimeError("CSRF cookie was not issued")


def trpc_query(procedure: str, payload=None):
    url = f"{origin}/api/trpc/{procedure}"
    if payload is not None:
        encoded = urllib.parse.quote(json.dumps({"json": payload}), safe="")
        url = f"{url}?input={encoded}"
    req = urllib.request.Request(
        url,
        headers={"Origin": origin, "Sec-Fetch-Site": "same-origin", "Accept": "application/json"},
        method="GET",
    )
    with opener.open(req, timeout=20) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["result"]["data"]["json"]


def trpc_mutate(procedure: str, payload=None):
    token = csrf_token()
    wire = {"json": None, "meta": {"values": ["undefined"]}} if payload is None else {"json": payload}
    data = json.dumps(wire).encode("utf-8")
    req = urllib.request.Request(
        f"{origin}/api/trpc/{procedure}",
        data=data,
        headers={
            "Origin": origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-rp-csrf": token,
        },
        method="POST",
    )
    try:
        with opener.open(req, timeout=25) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{procedure} failed ({exc.code}): {detail}") from exc
    return body["result"]["data"]["json"]


csrf_token()
signin = trpc_mutate("identity.signIn", {"email": admin_email, "password": permanent_pw})
assert signin["nextStep"] == "mfa_challenge", f"expected mfa_challenge after upgrade, got {signin}"

trpc_mutate("assurance.challenge", {"method": "recovery_code", "code": recovery_codes[0]})
me = trpc_query("identity.me")
assert me["state"] == "full" and me["nextStep"] is None, f"expected full post-upgrade session, got {me}"

# Maintenance mode remained active across the upgrade until the administrator clears it.
maint_after = trpc_query("jobs.admin.maintenance")
assert maint_after["active"] is True, f"expected maintenance still active before clear: {maint_after}"

trpc_mutate(
    "assurance.stepUp",
    {"password": permanent_pw, "factor": {"method": "recovery_code", "code": recovery_codes[1]}},
)
cleared = trpc_mutate("jobs.admin.setMaintenance", {"active": False, "expectedActive": True})
assert cleared["active"] is False

# Verify the pre-upgrade customer and order survived the migrations intact.
loaded_customer = trpc_query("identity.admin.customers.get", {"customerId": state["customerPublicId"]})
assert loaded_customer["customer"]["customerRef"] == state["customerRef"], f"customer mismatch: {loaded_customer}"

loaded_order = trpc_query("orders.admin.get", {"orderId": state["orderPublicId"]})
assert loaded_order["reference"] == state["orderReference"], f"order mismatch: {loaded_order}"
assert loaded_order["projectName"] == "Pre-Upgrade Order", f"order projectName mismatch: {loaded_order}"

# Newly created customers continue to use RPCUS- plus nine characters 0-9 A-Z.
new_customer = trpc_mutate(
    "identity.admin.customers.create",
    {"email": f"customer.after@{origin.removeprefix('https://')}", "name": "Post-Upgrade Customer"},
)
new_ref = new_customer["customerRef"]
assert (
    new_ref.startswith("RPCUS-")
    and len(new_ref) == 15
    and all(ch in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" for ch in new_ref[6:])
), f"unexpected post-upgrade customer reference: {new_customer}"

# Existing Increment 03 surfaces still respond after migrating.
backups = trpc_query("backup.admin.list", {"limit": 10})
assert any(item["trigger"] == "pre_upgrade" and item["verificationStatus"] == "verified" for item in backups["items"]), (
    f"pre_upgrade archive missing from backup.admin.list: {backups}"
)
storage_conns = trpc_query("storage.connections.list", {"limit": 10})
assert storage_conns["items"] == [], f"expected zero storage connections by default: {storage_conns}"
auto_cat = trpc_query("automations.catalogue")
assert auto_cat["globallyEnabled"] is False, f"expected automations disabled by default: {auto_cat}"
PY

step 'running native-install-smoke.sh against upgraded installation'
RP_SMOKE_ADMIN_PASSWORD_FILE="$work/permanent.password" \
RP_SMOKE_EXPECT_NEXT_STEP=mfa_challenge \
    bash "$repo_dir/scripts/ci/native-install-smoke.sh" "$host" "$alias_host"

printf '\nNative upgrade verification (%s -> %s) passed.\n' "$baseline_sha" "$candidate_sha"
