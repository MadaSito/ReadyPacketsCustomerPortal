#!/usr/bin/env bash
# Source from deployment CI. The caller supplies fail/expect and a query
# function that accepts SQL targeting the ReadyPackets schema.
assert_release_migrations() {
    local dir=$1 query=$2
    shift 2
    local tag hash count
    for tag in "$@"; do
        [[ -s $dir/$tag.sql ]] || fail "missing migration $tag SQL"
        hash=$(sha256sum -- "$dir/$tag.sql") || fail "cannot hash migration $tag"
        hash=${hash%% *}
        [[ $hash =~ ^[0-9a-f]{64}$ ]] || fail "unexpected migration $tag hash"
        count=$("$query" "SELECT COUNT(*) FROM readypackets.__drizzle_migrations WHERE hash='$hash'") ||
            fail "cannot read migration $tag journal count"
        expect "migration $tag journal entries" "$count" 1
    done
}
