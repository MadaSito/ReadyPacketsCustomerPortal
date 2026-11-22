# Connecting another system with the ReadyPackets API

Your ReadyPackets administrator can give another system, such as your ERP or reporting tool, an **API key** so it can read portal data and, where allowed, create orders or support tickets.

## What you need from your administrator

- An **API key** (`rpk_…`) and, if they require signed requests, a **signing secret**. Store both in a password manager or secret store; they are shown only once.
- The **scopes** the key allows, for example *Read orders*.
- The API address: `https://<your portal>/api/v1`. The machine-readable description is at `/api/v1/openapi.json`.

## Making a call

```http
GET /api/v1/orders?limit=25
Authorization: Bearer rpk_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Lists return `{ "data": [...], "next_cursor": "..." }`. Pass `cursor=<next_cursor>` to get the next page.

## Creating data safely

Every create or change call needs an `Idempotency-Key` header: a unique value you choose for that action, such as your own order number. If a call times out, send it again with the **same** key. You get the original result instead of a duplicate.

## Signed requests

If your key requires signing, send two more headers:

- `X-RP-Timestamp`: the current Unix time in seconds.
- `X-RP-Signature`: `v1=` followed by the hex HMAC-SHA256, using your signing secret, of the string below.

```
<timestamp>\n<METHOD>\n/api/v1<path and query>\n<raw body>
```

Each signature works once, and only within 5 minutes of its timestamp.

## When something goes wrong

Errors return a short JSON description with a `code` and a `request_id`. Share the `request_id` with your administrator; they can find the call in the request log. Common codes:

| Code | Meaning |
| --- | --- |
| `API_KEY_INVALID` | Check the key. |
| `INSUFFICIENT_SCOPE` | Ask for an extra scope. |
| `RATE_LIMITED` | Slow down and retry after the number of seconds in `Retry-After`. |
