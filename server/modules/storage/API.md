# Storage connections API

The local private store remains authoritative. Storage connections are optional, disabled on creation, and represent copy destinations, not replacement storage. No storage adapter may bypass the integration egress policy; use HTTPS, an enabled purpose-specific allowlist rule, public addresses only, and no redirects. Never log credentials, provider response text, remote IDs, URLs or path labels.

## Adapter registration

Import the ports from `server/modules/storage/contracts.ts`. During the provider module's `init()`, call `deps.services.storage.registerAdapter(kind, { configSchema, credentialsSchema, purposes, create })`. The schemas are strict Zod objects: config is non-secret `Record<string, string | number | boolean>`; credentials are secret `Record<string, string>`. `create({ publicId, config, credentials })` returns a `StorageAdapter`. Register a kind once, including both `sharepoint` and `onedrive` if supporting both. Only the adapter defines provider-specific keys; communicate those keys to the storage UI owner.

- `test(signal?) → { ok, code }`: non-mutating provider verification and fixed safe codes, never a provider error body. May run on disabled connections. Connectivity tests do not prove write permission.
- `ensureFolder(path: readonly string[], signal?) → void`: idempotent; virtual-directory adapters may no-op.
- `put({ path, name, size, sha256, contentType, body: Readable, signal? }) → { remoteId, size, sha256? }`: metadata uses lower-case hex SHA-256; `size` must be provider-observed. Return SHA-256 only if genuinely reported by the provider; neither a custom checksum metadata echo nor another checksum type counts. Uploads use the stable requested name, not auto-rename. Adapters own bounded/chunked transport and translate errors to safe fixed codes.
- `remove(remoteId, signal?) → void`: explicit adapter operation only; no automatic remote deletion or public delete endpoint.

OAuth provider callbacks use `storage.connections.update(principal, { publicId, expectedVersion, credentials })` after validating the callback's single-use session-bound state, provider kind and step-up. Never return credentials to the OAuth UI. Reconnect replaces the whole secret object. Adapter instances receive decrypted fields only inside the server, fresh per test/copy.

Server-only OAuth helper `storage.readProviderSetup(principal, { publicId, kind, expectedVersion }, tx)` validates the live administrator, locks the connection, and returns `{ config, credentials }` with decrypted credentials (or `null`). `connections.update` takes an optional third `tx` to commit credential updates atomically with OAuth state transitions. Never return setup objects in HTTP or tRPC responses.

## Administrator tRPC

All calls require an admin session, `storage.manage` and fresh step-up. Administrative writes are audited with stable IDs and counts, not config or credential values.

| Procedure | Input | Output |
| --- | --- | --- |
| `storage.connections.list` (query) | `{ cursor?, limit? }` | `{ items, nextCursor }` |
| `storage.connections.get` (query) | `{ publicId }` | connection |
| `storage.connections.create` (mutation) | `{ kind, name, config, credentials? }` | disabled connection |
| `storage.connections.update` (mutation) | `{ publicId, expectedVersion, name?, config?, credentials?, enabled? }` | connection |
| `storage.connections.test` (mutation, rate limited) | `{ publicId, expectedVersion }` | connection with `lastTest` |
| `storage.assignments.list` (query) | none | `[{ purpose, connectionPublicId }]` |
| `storage.assignments.set` (mutation) | `{ purpose, connectionPublicIds }` | assignments for the purpose |

Connection view: `{ publicId, kind, name, config, credentialsConfigured, enabled, version, lastTest, createdAt, updatedAt }`; `lastTest` is `null` or `{ ok, code, checkedAt }`. Credentials are never returned. Omit credentials to retain, use `null` to clear, or provide a complete replacement. Kind is immutable. Updating config or credentials resets connection testing and requires an explicit re-enable after a successful test.

Kinds: `s3`, `azure_blob`, `dropbox`, `google_drive`, `sharepoint`, `onedrive`. Purposes: `order_files` (multiple), `backups` (at most one), `order_data` (at most one; provider must declare support). `assignments.set` replaces the selection for that purpose; `[]` clears it. Disabling a connection does not clear its assignments, but it cannot receive new copies while disabled.

Built-in configuration keys:

| Kind | Non-secret config | Write-only credentials |
| --- | --- | --- |
| `s3` | `preset` (`aws`, `wasabi`, `backblaze`, `custom`), `bucket`, `region`, optional `prefix`, `endpoint` only for `custom` (HTTPS origin) | `accessKeyId`, `secretAccessKey`, optional `sessionToken` |
| `azure_blob` | `account`, `container`, optional `prefix`, `auth` (`shared_key`, `sas`) | `accountKey` or `sasToken`, as selected |

## Worker-side ports

- `storage.listAssigned(purpose, tx?) → StorageAssignmentView[]` lists active destinations, including no credentials. Order data has its own Graph mapping/worker; an assignment is not authority to send arbitrary content.
- `storage.readAssignedProvider({ purpose: "order_data", connectionPublicId, kind: "sharepoint", assertStillOwned })` returns privileged `{ config, credentials }` only to the SharePoint sync worker after checking the live assignment, kind and worker fence. Use only in the worker; recheck before writes and never expose the result in a response/log.
- `storage.copy({ purpose, connectionPublicId, path, name, size, sha256, contentType, body, signal?, correlationId?, assertStillOwned }) → StoragePutResult` runs an audited, fenced outbound copy, rechecks enablement and assignment, and verifies reported integrity. The caller owns the stream and must destroy it if the copy rejects before consuming it. Backup callers must pass only a verified, encrypted archive. No automatic remote deletion.
