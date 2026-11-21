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
| SigV4 and Azure authentication, path confinement, observed integrity | `objectAdapters.test.ts`: published [AWS signing example](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html), synthetic Azure signatures/SAS and streaming protocol responses; check the [Azure Shared Key reference](https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key) | automated-test |
| Real authorization, provider behavior/limits and latency | Test with a synthetic object in a dedicated staging destination on each configured provider. This is not a live provider certification. | not-verified |

## Operational limits

- An assignment and the pre-effect worker fence cannot revoke an HTTP request already in flight. Interrupted jobs are not automatically replayed; a row left `copying` paired with an interrupted/unknown job requires reconciliation.
- Connection test proves access to the bucket/container, not write scope, destination retention, restored backups, or isolation between different accounts.
- Order file jobs snapshot the selected destinations at accepted upload time. Changing an assignment does not backfill existing files or remove any remote bytes. Imported files are never automatically sent when adopted.
- S3-compatible endpoints must support the expected HTTPS, SigV4, object properties and conditional-create semantics; the actual behavior of each provider or custom service is unverified. Native Azure MD5 and other alternate digests are transport checks, not SHA-256.
