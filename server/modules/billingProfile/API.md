# Billing Profile Module (`server/modules/billingProfile`)

Owner: `compliance_engineer` (Increment 08, Decision D4).

## Purpose
Stores at most one saved billing contact and address per account (`customer_billing_profiles`), validated strictly with `shared/billingDetails.ts` (`billingDetailsSchema`) so a saved profile is always valid at cart checkout.

## Storage & Encryption
- Table: `customer_billing_profiles`
  - `id` (`BIGINT UNSIGNED` PK), `public_id` (`CHAR(26)` ULID unique)
  - `user_id` (`BIGINT UNSIGNED NOT NULL UNIQUE`, `FK -> users.id ON DELETE CASCADE`)
  - `details_enc` (`TEXT NOT NULL`): AES-256-GCM encrypted JSON (`BillingDetails`) with AAD `customer_billing_profiles.details:<userPublicId>`
  - `country` (`CHAR(2) NOT NULL`), `region` (`VARCHAR(64) NULL`)
  - `version` (`INT UNSIGNED NOT NULL DEFAULT 1`), `created_at`, `updated_at` (`DATETIME(3)`)

## tRPC Surface (`billingProfile.*`)
- `billingProfile.get` (`protectedProcedure` query): returns `{ publicId: string, details: BillingDetails, version: number, updatedAt: Date } | null` for `ctx.session.userId`.
- `billingProfile.save` (`protectedProcedure` mutation, rate limit `form_submission`): input `{ details: BillingDetailsInput, expectedVersion?: number, expectedPublicId?: string }` (`expectedVersion = 0` asserts none existed; `expectedVersion >= 1` requires `expectedPublicId` and asserts both exact row `version` and `publicId` generation so hard-delete + recreation at `version = 1` cannot be overwritten by a stale tab). Returns `{ publicId, details, version, updatedAt }`; throws `CONFLICT` (`BILLING_PROFILE_VERSION_CONFLICT`) on stale version or generation mismatch.
- `billingProfile.clear` (`protectedProcedure` mutation, rate limit `form_submission`): input `{ expectedVersion: number, expectedPublicId: string }`. Returns `{ cleared: boolean }` (`false` when already absent); throws `CONFLICT` (`BILLING_PROFILE_VERSION_CONFLICT`) when `expectedVersion` or `expectedPublicId` mismatches.

## Cross-Module Transactional Ports (`services.billingProfile`)
- `getForUserInTx(tx: DbOrTx, userId: number, options?: { forUpdate?: boolean; forShare?: boolean }): Promise<BillingProfileRecord | null>` (`{ forUpdate: true }` / `{ forShare: true }` issue a current locking read under caller-held `users` lock so InnoDB `REPEATABLE READ` does not return an earlier pre-lock snapshot)
- `saveForUserInTx(tx: Tx, userId: number, details: BillingDetailsInput, actor: BillingProfileWriteActor): Promise<BillingProfileRecord>`
  - Runs strictly on `tx` (never opens a nested transaction or second pool connection).
  - Never enqueues mail; records durable audit event `billing_profile.saved` on `tx` without field values.
- `clearForUserInTx(tx: Tx, userId: number, actor: BillingProfileWriteActor): Promise<{ cleared: boolean }>`

## Audit Events (Zero PII)
- `billing_profile.saved` (`category: "business"`, `action: "create" | "update"`, `outcome: "completed"`)
- `billing_profile.cleared` (`category: "business"`, `action: "delete"`, `outcome: "completed"`)
- `billing_profile.save_refused` / `billing_profile.clear_refused` (`outcome: "refused"`, `reasonCode: "BILLING_PROFILE_VERSION_CONFLICT"`)
