#!/usr/bin/env bash
# Run after the portal is ready. web() pins TLS and the canonical host; expect()
# and fail() belong to the caller. No privileged session is used by this probe.
assert_workflow_import_edge() {
    local proxy=$1 origin=$2 work=$3 path result
    local base=/api/trpc/orders.admin.workflows.transfer
    local body="$work/workflow-probe.json" over="$work/workflow-over.json"
    local -a headers=(-H 'Content-Type: application/json' -H "Origin: $origin" -H 'Expect: 100-continue')
    # The application should reject unauthenticated writes before parsing this body.
    truncate -s 4456448 "$body"
    truncate -s 4456449 "$over"
    for path in "$base.preview" "$base.applyImport"; do
        result=$(web -D "$work/workflow-probe.headers" -o /dev/null -w '%{http_code}' \
            "${headers[@]}" --data-binary "@$body" "$origin$path")
        case $result in
            401|403) grep -qi '^x-request-id:' "$work/workflow-probe.headers" ||
                fail "workflow POST $path did not reach the application" ;;
            *) fail "workflow POST $path expected application auth refusal at the exact limit, got $result" ;;
        esac
        # Nginx checks Content-Length before proxying. Caddy may wait until the
        # upstream reads the body, but auth refuses this request before reading.
        if [[ $proxy == nginx ]]; then
            expect "workflow POST $path one byte over" \
                "$(web -o /dev/null -w '%{http_code}' "${headers[@]}" --data-binary "@$over" "$origin$path")" 413
        fi
    done

    # The default body limit still applies to mixed case, suffixes and batched paths.
    truncate -s 300000 "$body"
    for path in "$base.Preview" "$base.apply"; do
        expect "workflow exception does not extend to $path" \
            "$(web -o /dev/null -w '%{http_code}' "${headers[@]}" --data-binary "@$body" "$origin$path")" 413
    done
    for path in "$base.preview/" "$base.preview,identity.passwordPolicy?batch=1"; do
        result=$(web -o /dev/null -w '%{http_code}' "${headers[@]}" --data-binary "@$body" "$origin$path")
        # The app can reject malformed procedure paths before Caddy reads the body.
        [[ $result == 413 || ($proxy == caddy && $result == 400) ]] ||
            fail "workflow exception does not extend to $path: got $result"
    done
    for path in "$base.preview?batch=1" "$base.applyImport?%62atch=0"; do
        result=$(web -D "$work/workflow-batch.headers" -o /dev/null -w '%{http_code}' \
            "${headers[@]}" --data-binary "@$body" "$origin$path")
        if [[ $proxy == nginx ]]; then
            expect "workflow batch query refused at native edge on $path" "$result" 400
            ! grep -qi '^x-request-id:' "$work/workflow-batch.headers" ||
                fail "workflow batch query reached the app through Nginx"
        else
            [[ $result == 413 || $result == 400 ]] || fail "workflow batch query refused on $path: got $result"
        fi
    done
    local other_method=413 encoded_path=413
    if [[ $proxy == nginx ]]; then
        # Nginx returns early rather than forwarding any request to a normalized-only path or method.
        other_method=405
        encoded_path=404
    fi
    expect "workflow exception refuses non-POST on $proxy" \
        "$(web -o /dev/null -w '%{http_code}' "${headers[@]}" -X PUT --data-binary "@$body" "$origin$base.preview")" "$other_method"
    expect "workflow exception refuses encoded path on $proxy" \
        "$(web -o /dev/null -w '%{http_code}' "${headers[@]}" --data-binary "@$body" "$origin$base.%70review")" "$encoded_path"
}
