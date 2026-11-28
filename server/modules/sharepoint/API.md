# SharePoint module API (increment 03)

Owner: portable_contract_engineer. Ships disabled. Tested against local fakes only (see VERIFICATION.md).

## Storage adapters
`init()` registers `sharepoint` (purposes `order_files`, `backups`, `order_data`) and `onedrive` (`order_files`, `backups`) with `services.storageConnections.registerAdapter`, backed by `server/modules/storage/adapters/graphDrive*.ts`.

- Config, sharepoint: `{ tenantId, clientId, siteUrl, siteId, driveId, driveName, rootFolderPath }`. Config, onedrive: `{ tenantId, clientId, userPrincipalName, driveId, driveName, rootFolderPath }`. Credentials: `{ clientSecret }`, which is write-only.
- Simple PUT is used up to 4 MiB when the transport supports raw bodies. Otherwise uploads use upload sessions with 10 MiB chunks (multiples of 320 KiB) and `conflictBehavior: fail`. If an object with the same name, size and QuickXorHash already exists, it is reused. QuickXorHash is a transport checksum, not a cryptographic identity: someone with write access to the target library could plant a colliding file. That person can already replace any file in the library, so reuse adds no new trust. Reuse is reported as `verifiedTransportDigest: "quickxor"` and never as SHA-256. Restricting write access to the library reduces the risk of planted files. Content identity would need a SHA-256 read-back, which is not implemented. A different object is never overwritten: it is stored as the next free `name (n).ext` (up to 99). Large uploads compare the hash before committing the final chunk and cancel the session on a match. The adapter verifies the size and QuickXorHash (`verifiedTransportDigest: "quickxor"`).
- Naming (increment 04 part B, package W; `graphDriveNames.ts`). Before any folder or write call, every segment is mapped deterministically:
  - `" * : < > ? / \ |` become `_`, and control and format characters are dropped;
  - leading spaces, trailing spaces and trailing dots are removed;
  - CON/PRN/AUX/NUL/COM0–9/LPT0–9 (also with an extension), `desktop.ini` and `.lock` get a `_`;
  - a leading `~$` becomes `~_`, `_vti_` becomes `_vti-`, and a top-level `forms` folder becomes `forms_`;
  - names over 255 characters are cut with `~` plus 8 hex characters of SHA-256, keeping the extension.

  `.`, `..`, `/`, `\`, empty segments and more than 12 segments are refused with `INVALID_INPUT`. The decoded path is checked against 400 characters; it includes the library's server-relative path, the configured root and the file name, plus room for a conflict suffix. If the path is too long, the file name is shortened first. If the folders alone are too long, the call fails with `INVALID_INPUT` before any write.
- Folders are created one segment at a time with `conflictBehavior: fail`. A folder that a concurrent worker created is reused, keeping the drive's casing. `put()` returns `targetPath`, the real final segments below the configured root, including the committed file name. The adapter declares `putCreatesFolders: true`.
- Upload-session URLs must be https on port 443, with no userinfo, and their host must be in the tenant lineage (`<tenant>.sharepoint.com`, `<tenant>-my.sharepoint.com`). They are sent through `uploadChunk`, narrowed to that exact host, and never carry the bearer token. The URLs are never logged and never included in errors.
- `beforeWrite` runs before every side effect. It is also passed to the transport as `beforeSend`, which runs after token acquisition and before each send or replay. A lost fence propagates unchanged.
- Binding: `graphDriveGraph.ts` connects the adapters to `services.integrations.createScopedGraphClient` and `.graph` (integrations runtime 7668b53). It supports raw small-file bodies and upload-session GET/DELETE through `uploadSessionControl`. The client runs the G-02 `beforeSend` fence after token acquisition and before each send, including cleanup DELETE. Nothing is sent after a lost fence; an abandoned session expires on the provider side. Verified against the real client over a local fake egress only.

## tRPC `sharepoint.admin.*`
Every procedure requires admin, `storage.manage` and a fresh step-up. Each call re-validates the session inside its transaction. Denials are audited (`sharepoint.admin.denied`). Provider calls use the `expensive` rate limit.

| Procedure | Input | Output |
| --- | --- | --- |
| `discoverSite` (mutation) | `{ connectionPublicId, expectedVersion, siteUrl }` | `{ siteId, displayName, webUrl }` |
| `listDrives` (mutation) | `{ connectionPublicId, expectedVersion, siteId }` | `{ drives: { driveId, name, driveType }[] }` |
| `resolveOneDrive` (mutation) | `{ connectionPublicId, expectedVersion, userPrincipalName }` | `{ driveId, driveName }` |
| `listFolders` (mutation) | `{ connectionPublicId, expectedVersion, kind, driveId, parentItemId?, cursor? }` | `{ folders: { itemId, name, path }[], nextCursor }` |
| `orderSync.get` (query) | none | `{ enabled, connectionPublicId, siteId, siteLabel, listId, listLabel, includePortalLink, version, state, lastError, counts }` |
| `orderSync.listLists` (mutation) | none | `{ lists: { listId, displayName, compatible }[] }` |
| `orderSync.createList` (mutation) | `{ displayName }` | `{ listId, displayName }` |
| `orderSync.update` (mutation) | `{ expectedVersion, enabled, listId, listLabel, includePortalLink }` | same as `get`. Enabling requires a passing test. |
| `orderSync.test` (mutation) | none | `{ ok, code }`. Codes: `OK`, `NOT_CONFIGURED`, `LIST_NOT_FOUND`, `LIST_INCOMPATIBLE`, `AUTH_FAILED`, `DESTINATION_DENIED`, `EGRESS_DENIED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` |
| `orderSync.resyncAll` (mutation) | none | `{ enqueued }`. Re-stages orders already known to the sync, at most 500. |
| `orderSync.backfill` (mutation, step-up) | `{ restart?: boolean }` | "Sync all existing orders now". Returns the settings view; progress is in `backfill: { state: running/completed/failed, enqueued, reasonCode, startedAt, finishedAt }` (poll `orderSync.get`). Runs job `sharepoint.backfill_orders` in batches of 200 over `services.orders.listOrderPublicIdsForSync` (keyset order), staging each order through the fenced outbox. A failed run resumes from its cursor; `restart` starts again from the first order. Each batch job carries its cursor, so a replayed batch does nothing. A run is bound to its authorized scope (settings version, connection and destination generation), and that scope is checked under the config lock before each batch is staged. Any settings change ends a running backfill with `SHAREPOINT_BACKFILL_SCOPE_CHANGED`, and the next start begins a new run rather than resuming. Per-order jobs staged by a backfill carry the scope (`SyncJobPayload.backfillScope`). The job compares it with the settings and destination pinned for its own run, and `beforeWrite` holds those pinned values until the write. On a mismatch it is cancelled with `SHAREPOINT_BACKFILL_SCOPE_CHANGED` and nothing is written. Follow-ups inherit the scope of the job that releases the claim. Items are matched by RpOrderId, so a rerun never duplicates them. Audited: `sharepoint.sync.backfill_started`, `_resumed` and `_finished`. |
| `orderSync.status` (query) | `{ cursor?, limit?, state? }` | `{ items: { orderPublicId, reference, state, attempts, lastSyncedAt, reasonCode }[], nextCursor }` |

## Order-data sync
- The `orders.registerChangeListener` callback runs inside the order transaction. When the sync is enabled, it bumps `desired_version` and enqueues `sharepoint.sync_order` with `{ orderPublicId }` and the idempotency key `sharepoint:order:<id>:v<n>`.
- The worker steps are:
  1. Take a durable per-order claim (a token plus a 10-minute expiry; a retry of the same job reclaims it).
  2. Read the assigned `order_data` connection through `readAssignedProvider`.
  3. Find the item by remote ID or by `RpOrderId`.
  4. Recheck before each write: the fence, the assignment, the destination generation, the settings version and the claim.
  5. PATCH the existing item or POST a new one. The `RpOrderId` column is unique, so a conflicting POST is read back and PATCHed instead.
  6. Verify the item's identity after the write.
  7. Publish the result under the fence and the claim, using `GREATEST(synced_version)`.
- List columns, which use the minimal field set: Title (the order reference), `RpOrderId` (indexed and unique), `RpCustomerRef`, `RpStatus`, `RpPackets`, `RpCurrency`, `RpSubtotal`, `RpDiscount`, `RpTotal`, `RpCreatedAt`, `RpSubmittedAt`, `RpClosedAt`, `RpUpdatedAt`, `RpPortalLink` (optional). Customer names and email addresses are never sent.
- Audit events: `sharepoint.order.sync`, `sharepoint.list.created`, `sharepoint.sync.enabled`, `sharepoint.sync.disabled`, `sharepoint.sync.updated`, `sharepoint.sync.tested`, `sharepoint.sync.resync_requested`, `sharepoint.admin.denied`. They carry IDs, counts and codes only.
- Automation action `sharepoint.sync_order` ("Sync order to SharePoint"): `forbidOnStaffOnlyTrigger` is set, and the action is also refused at runtime when the trigger is staff-only. It only enqueues the job.

### Liveness

A job that is refused because another job holds the order's claim (BUSY) retries with backoff and can run out of attempts. To cover that, the job holding the claim enqueues a fresh follow-up (`sharepoint:order:<id>:v<latest>:after:<jobId>`) when it releases the claim, whether it completed or failed permanently, if a newer version was staged in the meantime. This happens on every release, including a retryable failure on the last attempt. A follow-up that turns out to be redundant ends as caught up.

### Copy log (storage package R)

Order sync records one `storage_copy_attempts` row per job attempt (kind `sharepoint_order`) through `recordCopyAttempt`, always inside a fenced owner transaction:

- queued: when a sync job is staged and a SharePoint destination is assigned (idempotent on deduplicated jobs);
- started: after the destination is resolved, in its own `assertStillOwned` transaction;
- finished: `written` for created/updated items (the readback checks only the RpOrderId marker, so never `verified`), `not_written` for unchanged or caught-up runs, `failed` with the fixed reason code (including unknown outcomes).

No remote IDs, list names, paths or provider text are stored. The Copy log has no direct retry for SharePoint; the job queue's own retries (up to 6, safe because items are looked up by RpOrderId) apply. Runs with no assigned destination record nothing.

## Trash, restore, and permanent deletion (increment 09 D2)
- `init()` registers `sharepoint` as a `TrashParticipant` with `services.trash.register`.
- While an order is in the trash (`onTrashedInTx` / `orders.isTrashedInTx` / `orders.getOrderSyncView === null`):
  - Order changes, manual `enqueueOrder`, `resyncAll`, and `backfill` skip trashed and tombstoned orders; trashed orders are hidden from `orderSync.get` counts and `orderSync.status`.
  - Any sync job already queued or claimed before trashing re-checks live order state inside `beforeWrite` immediately before the external Graph list write (`POST`/`PATCH`) and drops itself (`outcome: "canceled"`, `reasonCode: "ORDER_TRASHED"`, copy log `result: "not_written"`) without marking SharePoint sync configuration unhealthy.
- Restoring an order (`onRestoredInTx`) clears the trash marker and re-stages `sharepoint.sync_order` when sync is enabled.
- Permanent deletion (`purge`) erases the portal mapping row in `sharepoint_order_sync` only. Folders, files, and list items already written to SharePoint or OneDrive are intentionally **not** deleted automatically (D2.6).

## Least privilege (administrator guidance)
- For SharePoint, use an Entra app with `Sites.Selected`, granted `write` on the single chosen site only.
- For OneDrive for Business, application permissions are tenant-wide (`Files.ReadWrite.All`). Prefer SharePoint, or restrict the app with an application access policy or RBAC for Applications.
- Enable the `microsoft_graph` and `microsoft_graph_upload` egress presets.
