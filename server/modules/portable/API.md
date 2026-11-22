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
| `accept` | `accept` | `{ importId: string, planDigest: string, independentChecks: true }`; only by a different administrator after reconciliation |

## Guarantees and events

- Export supports all core records, selected customer profiles and their linked orders, or selected orders and their owning profiles. It uses a read-only MySQL repeatable-read snapshot, then checks each active current file against live custody and snapshot SHA-256. Export creates private ciphertext and delegates publication to fenced `portable.export.publish`. Downloads are private, audited, and expire after 24 hours.
- Import verifies under the request passphrase and applies only the approved sealed plan in `portable.import.apply`. Durable queue payloads hold a transfer public ID only. Package limits include 192 MiB ciphertext, 32 MiB for legacy envelopes, 128 MiB per file object, 10,000 records, 1,500 objects, and 16 MiB of collected metadata. Scheduled unattended exports are not supported.
- Import checkpoints: `received`, `quarantined`, `verified`, `planned`, `approved`, `objects-prepared`, `records-committed`, `finalized`, `reconciled`, `accepted`. Uncertain outcomes are retained as `held-unknown`; canceled, refused and failed are distinguishable. Checkpoints and business/audit receipts are durable. The approval is bound to input, target, plan digest, and expiry.
- Default policy is collision refusal, no implicit email matching, no overwrite or privilege/credential onboarding, and read-only order adoption. Dry run checks normalized customer identifiers, target order constraints and current supported status before approval. Existing immutable mapping receipts can link only the same package ID, manifest identity and source record digest. Unsupported optional content is held as inert encrypted evidence. Required non-core modules and external dependency closures are refused by the portal; unknown required extensions are refused by the independent reader.
- Audit category `portable_transfer`: `portable.export.requested`, `portable.export.prepared`, `portable.export.published`, `portable.export.download`, `portable.import.transition`, `portable.import.record`, and `portable.export.expired`. Correlate with transfer public ID and known package ID. Audit failures prevent business/state transitions.
- No configuration flags or mail templates. Local export expiry applies only to server-retained export ciphertext. Import and uncertain-object purge is not automated. See [verification and release limitations](./VERIFICATION.md) before operational use.

## Increment 05 coverage

- **Promo fields on orders.** Contract 3.0 `orders` records carry the optional fields `promoDiscount` (money: the part of `discount` due to a promotion code) and `promoLabel` (≤120 characters or null). Older packages without them import as no promotion. An imported order keeps them as a historical fact only. It gets no promotion link or redemption row, and its read-only adoption is unchanged.
- **Excluded by design.** Promotions (codes, batches and redemptions) and cart upsell offers are listed in the manifest exclusions `promotions` and `cart-upsell-offers`.
  - A promotion code is a live, redeemable secret.
  - Usage limits and redemption counts cannot stay consistent across two installations.
  - Both are installation configuration, not customer business records.
  - No code value, keyed hash or offer is written to a package.
  - Carts are not collected, so their applied promo fields (including the encrypted `applied_promo_code_enc`) and upsell cart state are not transferred either.
- **Workflows (D1) do not overlap.** The workflow transfer (`orders.admin.workflows.transfer.*`, ADR 0042) moves workflow definitions, which are configuration, as draft-only JSON packages. This module moves business records for a whole or selected installation and has no workflow collector. Orders carry the source workflow key only as inert `heldUnknown.sourceWorkflow`. The two features share no format, tables, jobs or settings. Move workflows first if the target needs them.
- **Backups.** Backups (`server/modules/backup`) dump every base table, including the new promotion, upsell and order columns. They do not use this format. Restored encrypted columns (including promotion code values) and keyed hashes are valid only with the same field-encryption and blind-index keys, so restoring to an installation with different keys is unsupported. Use this transfer for moves between installations, and recreate promotions on the target.
