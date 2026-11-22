# Public API (inbound): keys, request log and replay

The public API lets other systems, such as an ERP or a reporting tool, read and create portal data over HTTPS at `/api/v1`. It is **off** until an administrator turns it on.

## Turn the API on

1. Go to **Console → Platform → Public API**.
2. Under **API access**, choose **Turn the API on** and confirm your identity.
3. Optionally set how many days to keep the request log (1–90, default 30).

While it is off, every call returns *not found*. The OpenAPI document at `/api/v1/openapi.json` is always available. Turning the API on or off is recorded in the audit log.

## Create a key

1. Choose **Create API key**.
2. Give it a name that identifies the calling system.
3. Pick only the scopes it needs, for example *Read orders*.
4. Optionally set:
   - an expiry;
   - allowed IP addresses or CIDR ranges;
   - a per-minute request limit;
   - **Require signed requests**.
5. Copy the **API key**, and the **signing secret** if signing is on, into the calling system's secret store. They are shown **once**. The portal keeps only a one-way hash of the key and an encrypted signing secret.

Keys look like `rpk_<12 characters>_<40 characters>`. Only the prefix is shown later.

## Rotate or revoke

- **Rotate** issues a new key (and signing secret) and the old key stops working immediately. Update the integration right away.
- **Revoke** stops the key permanently.
- **Edit** changes the scopes, limits, allowed addresses or expiry. If you turn signing on, a signing secret is shown once.

## Request log

**Public API → Request log** lists calls made with API keys. You can filter by status, method, replays, time and search terms (path, route, error code or request ID). Open a row to see redacted request and response details, the client address and any replays.

Authorization headers, secrets and other sensitive fields are hidden. Caller correlation IDs and idempotency keys are stored only as digests. Searching for an exact correlation ID still finds it.

## Replay

On a request's detail page, **Replay request** runs the call again with the **key's current scopes**. The key must still be active, and you must confirm your identity.

- Writes ask for extra confirmation, because they can change data again.
- Only calls that passed every check can be replayed. For writes, only calls that completed can be replayed.
- Each replay is a new log entry linked to the original, and it is audited.

## Audit events

| Event | When |
| --- | --- |
| `api.settings.enabled` / `disabled` / `updated` | The API is turned on or off, or the retention changes. |
| `api.key.created` / `updated` / `rotated` / `revoked` | A key is changed. |
| `api.auth.denied` | A call is made with an invalid key. |
| `api.request.write` | A write call: "attempted" before it runs, then the result. |
| `api.request.replayed` | An administrator replays a call. |
| `api.admin.denied` | Someone is refused access to these admin pages. |

## Troubleshooting

| Code | Meaning |
| --- | --- |
| `API_KEY_INVALID` (401) | The key is wrong, revoked or expired. Repeated failures from one address are throttled. |
| `SIGNATURE_*` (401) | The signature is missing, stale (more than 5 minutes off), invalid or already used. |
| `IP_NOT_ALLOWED` (403) | The caller's address is not on the key's allow-list. |
| `INSUFFICIENT_SCOPE` (403) | The key lacks the scope for this route. |
| `RATE_LIMITED` (429) | The per-key minute limit was reached. Wait for `Retry-After`. |
| `IDEMPOTENCY_KEY_REUSED` (422) | The same `Idempotency-Key` was sent with a different body. |
| `IDEMPOTENCY_OUTCOME_UNKNOWN` (409) | An earlier attempt with this key ended without a known result. Check the data before retrying with a new key. |
| `RESOURCE_UNAVAILABLE` (503) | That part of the portal does not offer API access yet. |
