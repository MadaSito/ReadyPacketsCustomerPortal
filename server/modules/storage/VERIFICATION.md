# Storage connections verification

All cloud tests use local protocol fakes. No live tenant, bucket or provider account was used. See [Dropbox and Drive OAuth verification](./oauth/VERIFICATION.md) for those adapters.

| Requirement | Evidence | Class |
| --- | --- | --- |
| Storage admin requires full session, capability, live step-up and durable audit | `storage.test.ts`: staff/remediation refusal, persisted step-up expiry, rollback on audit outage | automated-test |
| Secrets are write-only and encrypted; OAuth tokens cannot enter public CRUD | `storage.test.ts`: encrypted database value, safe view/audit, internal-only token update | automated-test |
| Destinations are disabled by default and credential-bound edits invalidate verification | `storage.test.ts`: explicit credentials on material edit, test gate, stale version, test throttling | automated-test |
| Multiple backup targets, one order-data target, disabled destinations do not dispatch | `storage.test.ts`: multi-assignment and provider-purpose gates | automated-test |
| Atomic upload enqueue and no automatic remote delete or local mutation | `../files/files.test.ts`, `storage.test.ts`: rollback on outbox failure, disabled path, fan-out, encrypted labels and originals preserved | automated-test |
| Live source and destination fences; rotated credentials do not redirect queued bytes | `storage.test.ts`: scope changes after folder stage, credential change and re-enable skips old job | automated-test |
| Provider verification and safe retry | `storage.test.ts`: mismatched digest fails; duplicate-safe failure retries with queue backoff, unknown isn't replayed | automated-test |
| Automation loop marker, deduplication and scope | `storage.test.ts`: origin survives child queue and audit transitions, repeat staging creates no copy, unassigned target refused | automated-test |
| SigV4 and Azure authentication, path confinement, observed integrity | `objectAdapters.test.ts`: published [AWS signing example](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html), synthetic Azure signatures/SAS and streaming protocol responses; check the [Azure Shared Key reference](https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key) | automated-test |
| Real authorization, provider behavior/limits and latency | Test with a synthetic object in a dedicated staging destination on each configured provider. This is not a live provider certification. | not-verified |

## Increment 04 Copy log

- **Service**: [`copyLog.test.ts`](copyLog.test.ts) covers retained attempts, verified versus written outcomes, interrupted leases, bounded filters and pagination, live administrator authorization, safe CSV export, atomic audit and retry delegation to the owning job. The database cases use local MySQL and synthetic data.
- **Console**: [`copyLog.test.tsx`](../../../client/src/features/storage/copyLog.test.tsx) covers filters and keyboard access to unverified write details, with axe checks in light and dark in jsdom. The [Backup](../backup/VERIFICATION.md) and [SharePoint](../sharepoint/VERIFICATION.md) records cover their respective work and provider fakes.
- **Limits**: These checks are not browser or real-provider verification. In particular, a write accepted by a provider is distinct from an independently verified copy.

## Operational limits

- An assignment and the pre-effect worker fence cannot revoke an HTTP request already in flight. Interrupted jobs are not automatically replayed; a row left `copying` paired with an interrupted/unknown job requires reconciliation.
- Connection test proves access to the bucket/container, not write scope, destination retention, restored backups, or isolation between different accounts.
- Order file jobs snapshot the selected destinations at accepted upload time. Changing an assignment does not backfill existing files or remove any remote bytes. Imported files are never automatically sent when adopted.
- S3-compatible endpoints must support the expected HTTPS, SigV4, object properties and conditional-create semantics; the actual behavior of each provider or custom service is unverified. Native Azure MD5 and other alternate digests are transport checks, not SHA-256.

## Increment 04 Part B: Order file routing and transfers

- **Folder contract**: [`orderFileFolder.test.ts`](../../../shared/orderFileFolder.test.ts) checks unsafe literals, traversal, provider-reserved names, controls, token expansion, and paths that become too long or reserved only after expansion.
- **Service**: [`storage.test.ts`](storage.test.ts) uses real MySQL and synthetic files/provider responses for slot/workflow/default precedence, observed target paths, encrypted attempt metadata, order scope and cursors, missing local sources, stale retries and counts. The Jobs lock is exercised in the [Jobs suite](../jobs/VERIFICATION.md); these cases use a job port fake.
- **Console**: [`copyLog.test.tsx`](../../../client/src/features/storage/copyLog.test.tsx) covers the order deep link, bounded target-path display, and light/dark axe checks in jsdom. These checks do not establish real-browser layout, screen reader behavior, or live SharePoint/OneDrive verification.

## Increment 07: Managed Microsoft 365 phase files

- [`orderStageFileSync.test.ts`](../../../shared/orderStageFileSync.test.ts) checks defaults-off parsing for omitted fields, template confinement, Unicode normalization and isolation of managed placeholders from legacy formats.
- [`managedFileSync.test.ts`](managedFileSync.test.ts) uses isolated MySQL and a local Graph fake to check a denied write probe, fresh-admin and route authorization, deduplicated role fan-out, frozen customer folders, staff-only and pending audio limits, retry-after, blocked visibility changes, read-only ambiguous-final-write checks, resync confirmation and restricted receipts.
- [`storage.test.ts`](storage.test.ts) and [`graphDriveRouting.test.ts`](adapters/graphDriveRouting.test.ts) regression-test the pre-existing copy path, retry and conflict behavior. The managed path does not reuse legacy QuickXor-based collision adoption.
- Provider ACLs, rate limits, upload-session behavior and browser layout still need staging verification. No live tenant, production file or real-browser automation is used by these tests.
