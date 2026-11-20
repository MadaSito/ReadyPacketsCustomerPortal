# Portable business transfer API

Private administrative transfer; not a system backup. All IDs exposed to callers are public IDs or package digests. Passphrases are processed only in the initiating request. They are not persisted, queued, returned, or logged.

## Service and endpoints

`PortableModule` methods take a resolved `SessionPrincipal` as their first argument. All require a full admin session and the matching portable capability. Operations that mutate state, verify data, create artifacts, or download require fresh MFA step-up. Read-only list/detail returns no customer values, uploaded filenames, encryption data or storage keys.

| Service | tRPC `portable.admin.*` or raw HTTP | Input |
| --- | --- | --- |
| `listExports`, `listImports` | `listExports`, `listImports` | `{ cursor?: string, limit?: number }` |
| `getImport` | `getImport` | `{ importId: string }` |
| `startExport` | `startExport` | `{ selection: { kind: "all" } \| { kind: "customers" \| "orders", ids: string[] }, passphrase: string }` |
| `openExport` | `GET /api/portable/exports/:exportId/download` | private ciphertext; audited delivery attempt and outcome |
| `upload` | `POST /api/portable/imports` | raw `application/octet-stream` streamed into bounded quarantine |
| `verifyAndPlan` | `verifyAndPlan` | `{ importId: string, passphrase: string }` |
| `approve` | `approve` | `{ importId: string, planDigest: string }` |
| `cancel` | `cancel` | `{ importId: string }`; only before approval |
| `accept` | `accept` | `{ importId: string, planDigest: string }`; only after accepted checks/reconciliation |

## Guarantees and events

- Export creates/validates private ciphertext and delegates publication to fenced `portable.export.publish`. Import verifies under the request passphrase and applies only the approved sealed plan in `portable.import.apply`. Durable queue payloads hold a transfer public ID only. The export passphrase is never in job state. Scheduled unattended exports are not supported.
- Import checkpoints: `received`, `quarantined`, `verified`, `planned`, `approved`, `objects-prepared`, `records-committed`, `finalized`, `reconciled`, `accepted`. Uncertain outcomes are retained as `held-unknown`; canceled, refused and failed are distinguishable. Checkpoints and business/audit receipts are durable. The approval is bound to input, target, plan digest, and expiry.
- Default policy is collision refusal, no implicit email matching, no overwrite or privilege/credential onboarding, and read-only order adoption. Existing immutable mapping receipts can link only the exact same package and source portable record. Unsupported optional content is held as inert encrypted evidence. Unknown required content is refused by the independent reader.
- Audit category `portable_transfer`: `portable.export.requested`, `portable.export.prepared`, `portable.export.published`, `portable.export.download`, `portable.import.transition`, `portable.import.record`, and `portable.export.expired`. Correlate with transfer public ID and known package ID. Audit failures prevent business/state transitions.
- No configuration flags or mail templates. Local expiry applies only to server-retained ciphertext. No auto-delete of uncertain prepared objects.
