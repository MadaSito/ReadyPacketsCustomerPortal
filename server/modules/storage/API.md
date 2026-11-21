# Storage connections API

The local private store remains authoritative. Storage connections are optional, disabled on creation, and represent copy destinations, not replacement storage. No storage adapter may bypass the integration egress policy; use HTTPS, an enabled purpose-specific allowlist rule, public addresses only, and no redirects. Never log credentials, provider response text, remote IDs, URLs or path labels.

## Adapter registration

Import the ports from `server/modules/storage/contracts.ts`. During the provider module's `init()`, call `deps.services.storageConnections.registerAdapter(kind, { configSchema, credentialsSchema, purposes, create })`. `deps.services.storage` remains the local object storage port. The schemas are strict Zod objects: config is non-secret `Record<string, string | number | boolean>`; credentials are secret `Record<string, string>`. `create({ publicId, config, credentials })` returns a `StorageAdapter`. Register a kind once, including both `sharepoint` and `onedrive` if supporting both. Only the adapter defines provider-specific keys; communicate those keys to the storage UI owner.

- `test(signal?) → { ok, code }`: non-mutating provider verification and fixed safe codes, never a provider error body. May run on disabled connections. Connectivity tests do not prove write permission.
- `ensureFolder(path: readonly string[], signal?, beforeWrite?) → void`: idempotent; virtual-directory adapters may no-op.
- `put({ path, name, size, sha256, contentType, body: Readable, signal?, beforeWrite? }) → { remoteId, size, sha256?, verifiedTransportDigest? }`: metadata uses lower-case hex SHA-256; `size` must be provider-observed. Report SHA-256 only if genuinely reported by the provider, never from a custom metadata echo. A provider-generated MD5 or QuickXorHash checked by the adapter may be reported separately; neither is equivalent to SHA-256. Uploads use the stable requested name, not auto-rename. Adapters own bounded/chunked transport and translate errors to `StorageAdapterError`; use `retryable: true` only for duplicate-safe retry, and `OUTCOME_UNKNOWN` for an ambiguous write.
- `remove(remoteId, signal?) → void`: explicit adapter operation only; no automatic remote deletion or public delete endpoint.

When supplied, invoke `beforeWrite` before every provider side effect, including folder creation, upload-session creation and every chunk or final commit. It rechecks the live assignment, source (where applicable), credentials and worker fence without holding SQL locks across network I/O. A request already in flight cannot be recalled.

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

Connection view: `{ publicId, kind, name, config, credentialsConfigured, oauthConnected, enabled, version, lastTest, createdAt, updatedAt }`; `lastTest` is `null` or `{ ok, code, checkedAt }`. Credentials are never returned. Omit credentials to retain for non-config changes, use `null` to clear, or provide a complete replacement. If credentials exist, a material config change must explicitly replace or clear them; disconnect an active OAuth grant first. OAuth refresh tokens are accepted only from the internal verified consent flow. Kind is immutable. Updating config or credentials resets connection testing and requires an explicit re-enable after a successful test.

Kinds: `s3`, `azure_blob`, `dropbox`, `google_drive`, `sharepoint`, `onedrive`. Purposes: `order_files` and `backups` (up to eight each), `order_data` (at most one); the provider must declare support. `assignments.set` replaces the selection for that purpose; `[]` clears it. Disabling a connection does not clear its assignments, but it cannot receive new copies while disabled. See [OAuth adapter setup](./oauth/API.md) for Dropbox and Google Drive.

Built-in configuration keys:

| Kind | Non-secret config | Write-only credentials |
| --- | --- | --- |
| `s3` | `preset` (`aws`, `wasabi`, `backblaze`, `custom`), `bucket`, `region`, optional `prefix`, `endpoint` only for `custom` (HTTPS origin) | `accessKeyId`, `secretAccessKey`, optional `sessionToken` |
| `azure_blob` | `account`, `container`, optional `prefix`, `auth` (`shared_key`, `sas`) | `accountKey` or `sasToken`, as selected |

## Worker-side ports

- `storage.listAssigned(purpose, tx?) → StorageAssignedDestination[]` lists active destinations in public-ID order, including `destinationVersion`, `kind`, and the admin-facing `name` but no credentials or endpoint. Pass `expectedDestinationVersion` to `copy` when staging a durable dispatch. Any credential replacement, clear, or material config change invalidates the prior generation, even after re-enable. Order data has its own Graph mapping/worker; an assignment is not authority to send arbitrary content.
- `storage.readAssignedProvider({ purpose: "order_data", connectionPublicId, kind: "sharepoint", assertStillOwned })` returns privileged `{ config, credentials }` only to the SharePoint sync worker after checking the live assignment, kind and worker fence. Use only in the worker; recheck before writes and never expose the result in a response/log.
- `storage.copy({ purpose, connectionPublicId, path, name, size, sha256, contentType, body, signal?, correlationId?, assertStillOwned }) → StoragePutResult` runs an audited, fenced outbound copy, rechecks enablement and assignment, and verifies reported integrity. The caller owns the stream and must destroy it if the copy rejects before consuming it. Backup callers must pass only a verified, encrypted archive. No automatic remote deletion.
- `storage.stageOrderFile(filePublicId, tx)` inserts one durable `storage.copy_order_file` job and copy record per active assignment as part of a normal accepted upload. Portable imports and earlier files are not automatically backfilled. The local file remains authoritative. The worker checks live source ownership, deletion, legal hold, local bytes, live assignment, destination generation and lease, with an encrypted stable path and remote reference. Six attempts maximum for explicitly duplicate-safe failures; an interrupted or ambiguous dispatch needs operator reconciliation, not replay. Removing or purging a local file never removes a cloud copy.

Audit events: `storage.admin.denied`, `storage.connection.created`, `storage.connection.updated`, `storage.connection.configuration_changed`, `storage.connection.tested` (attempt and result), `storage.assignments.changed`, `storage.copy` (attempt and completion), `storage.order_file.copy` (state transitions). Job type: `storage.copy_order_file`. Health component: `storage.connections` (enablement summary, not an active provider probe). No public file bytes, copy/remove endpoints, new flags or templates.

## Administrator setup

1. Create a dedicated private bucket/container or folder, with provider-side encryption, access controls, retention and residency selected for the data being copied. Do not reuse a broadly shared team folder. Native bucket/container credential tests are read-only; they do not grant write access.
2. Enable the exact provider egress rule in Integrations. The S3 adapters use path style against the regional hostname: `s3.<region>.amazonaws.com`, `s3.<region>.wasabisys.com`, or `s3.<region>.backblazeb2.com`; use the actual bucket region. Custom S3 requires an explicit exact HTTPS host on port 443. Azure uses `<account>.blob.core.windows.net`. No redirects, private networks, embedded URL credentials or custom SAS hosts.
3. For S3 use a dedicated principal or bucket-scoped application key with bucket access for the test/object absence check and object read/write on the chosen destination prefix. Do not grant delete. Accept only a compatible service that honors conditional object creation; AWS SHA-256 is required there, while compatible presets may report size only. For Azure, prefer a time-limited HTTPS-only container SAS restricted to reading and creating blobs; use Shared Key only if you have consciously accepted its account-wide authority. Do not give the copy credential delete permissions. Azure validates its provider-generated MD5 if present; it is not a SHA-256 proof.
4. Save, test, explicitly enable and assign. `order_files` sends copies of newly accepted local uploads, including staff-only files. `backups` sends only archives that the backup worker has already encrypted and verified. `order_data` uses the dedicated SharePoint sync. Backups can target several destinations; verify independent failure domains and perform restore tests before counting them toward 3-2-1.
5. Test a synthetic file/archive before copying real customer material. Check Jobs and Audit for safe outcome codes. If a worker lost its lease or the provider did not confirm the result, reconcile the stable object manually; the system does not overwrite it, delete it or retry an ambiguous PUT automatically. Disabling/unassigning stops future outbound stages, not an HTTPS request already in flight or previously created copies.

Object copies use one bounded request, not multipart. S3 max: 5 GiB; Azure block blob max: 5,000 MiB. The egress stream deadline is at most 10 minutes. Some compatible services may impose lower limits. Before using for disaster recovery, test the size and throughput of a representative encrypted backup.
