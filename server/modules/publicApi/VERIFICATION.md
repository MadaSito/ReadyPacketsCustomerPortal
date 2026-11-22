# Public API module: verification (increment 04, package H)

Every test ran against **local fakes only**:
- fake providers registered in the test;
- fake audit, rate limiter, jobs and identity (`tests/helpers/fakes.ts`);
- the local dev MySQL test database.

Data is synthetic. **Nothing was tested against real domain providers, the real HTTP stack, or a browser.**

| File | Result |
| --- | --- |
| server/modules/publicApi/publicApi.test.ts | 26 passed |
| client/src/features/publicApi/publicApi.test.tsx | 10 passed: axe (jsdom) in light and dark for /admin/api, the create dialog, /admin/api/log and /admin/api/log/:requestId, plus 2 interaction tests |

The scoped typecheck (`tc.sh 'publicApi'`) and lint are clean for `server/modules/publicApi` and `client/src/features/publicApi`.

## What the tests cover

- **Off by default:** every call returns 404 while the API is off, but `/openapi.json` is still served. Turning the API on or off is audited, and a stale version is refused.
- **Authentication:**
  - A wrong secret, an unknown prefix, a malformed token and a missing header all get the same 401 body. Each one consumes `auth_high_risk` and writes an `api.auth.denied` note, so prefixes can't be enumerated.
  - During a flood the API returns 429 and does not store a log row.
  - Revoked and expired keys are refused. The IP allow-list is enforced.
- **Signing:** a valid signature is accepted once; a replayed signature, a stale timestamp and a bad signature are refused, as is an unsigned request when signing is required.
- **Limits and validation:**
  - The per-key minute limit returns RateLimit-* headers and a 429 with Retry-After.
  - Scope 403, unknown route 404 and wrong method 405 are returned without calling a provider.
  - Query allowlist and filter checks; strict body validation; 415 for non-JSON bodies.
- **Responses:** fields outside the DTO are stripped, and lists are wrapped. A missing provider gives 503.
- **Idempotency:**
  - `Idempotency-Key` is required on writes. A repeat returns the stored response; reusing a key with a different body gives 422.
  - A durable audit record is written as "attempted" and then "completed". If that audit is unavailable, nothing runs (fails closed).
  - An unknown-outcome write stays reserved, so a retry gets `IDEMPOTENCY_OUTCOME_UNKNOWN` and the provider is not called again.
  - The raw idempotency key is never stored.
- **Log columns:** the concrete path is stored only for matched routes. Correlation is stored as a digest and can be found by its exact value. The token and the raw correlation value never appear in rows.
- **Administration:**
  - The token is shown once; it is never in the database, the key view or audit. The signing secret is never in the database.
  - After rotation the old token is refused at once. Key input is validated.
- **Authorization matrix:** customers and staff are refused for keys, log and replay. An admin without step-up is refused for create and replay but allowed to read the log. A demoted live session is refused. Every refusal is audited (`api.admin.denied`).
- **Log:** filters work (status class, key, path prefix, replay), and the detail view decrypts the IP without exposing the token.
- **Replay:**
  - Writes need `confirmWrite`, and the replay reaches the provider with `caller.replay = true`. The replay is audited.
  - A refused read and unknown-outcome, refused or missing-idempotency writes are `API_REPLAY_UNAVAILABLE`.
  - After the key's scopes are reduced, a replay returns 403.
- **Purge:** the hourly schedule is registered, and rows past retention are deleted.

## Not verified

- **Wiring:** real provider implementations by other modules are each tested by their owner. The Express adapter (`http.ts`), raw body parser and mount are covered by typechecking and the integrator's isolated-route work only.
- **Performance and concurrency:** constant-time behaviour under real timing measurement, and concurrency races (parallel same-key writes, rate windows across workers) beyond the unique constraints.
- **Accessibility and layout:** colour contrast, 320 px layout, 400 % zoom and screen readers. jsdom axe does not check these; they are not checked.
- **OpenAPI:** the document has not been validated against an external OpenAPI validator.
