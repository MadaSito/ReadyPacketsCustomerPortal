# Promotions Module — Server Port & tRPC API Contract (Increment 05, Package C1)

Owner: `siem_engineer` (`server/modules/promotions/**`)

## Module Exports (for `server/container.ts` & `server/trpc/router.ts`)

- `server/modules/promotions/index.ts`:
  - `createPromotionsModule(deps: ModuleDeps): PromotionsModule`
  - `PromotionsModule` (`ModuleLifecycle & PromotionsService`)
  - Settings exports (`PROMOTIONS_ENABLED_FLAG`, `PROMOTIONS_POLICY_SETTING`, `DEFAULT_PROMOTIONS_POLICY`)
- `server/modules/promotions/router.ts`:
  - `promotionsRouter` (mount on `appRouter` as `promotions: promotionsRouter`)
- `server/modules/promotions/schema.ts`:
  - `promoBatches` (`promo_batches`)
  - `promoCodes` (`promo_codes`)
  - `promoRedemptions` (`promo_redemptions`)
  - `promoCheckAttempts` (`promo_check_attempts`)

## Code Normaliser, Batch Alphabet & Label Hygiene

- **Normaliser (`normalizePromoCode`)**: `raw.trim().toUpperCase()`.
- **Admin custom code rule**: `6..32` characters matching `/^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/` (uppercase `A–Z`, `0–9`, internal `-`; no leading or trailing hyphen).
- **Batch code generation**: CSPRNG (`crypto.randomInt`) over unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (excludes `0, O, 1, I, L`), `12` random characters; optional `codePrefix` matches `/^[A-Z0-9]{1,12}$/` and formats as `<PREFIX>-<12 RANDOM CHARS>`.
- **Label/code separation**: `create` and `update` reject `label` when `label.trim().toUpperCase()` equals the normalized code (or prefix) with `VALIDATION` / `LABEL_MATCHES_CODE` so secret codes never leak via `label` onto orders, invoices, or audit records.
- **Internal `preview` / `guardAttempt` evaluation**: normalizes with `trim().toUpperCase()`; any malformed, out-of-range, or unknown string executes a bounded dummy MySQL lookup + decrypt path for §4 timing parity and fails closed with the uniform `PROMO_NOT_APPLICABLE` error. Rate-limited per account (`promo:acct:<userId>`) and per normalized IPv4/IPv6 `/64` prefix (`rateLimitAddress` -> `blindIndex(..., "promo_check.ip")`); any 5 failed attempts within 15 minutes (even with valid previews in between) pause code attempts for 15 minutes and emit `promotion.attempts_blocked` (`WARN`).

## Settings Keys

1. `feature.promotions` (`boolean`, default `false`, `clientVisible: true`, `writeCapability: "promotions.manage"`):
   - Master switch. When `false`, `guardAttempt`, `preview`, and `redeemInTx` refuse with `PROMO_NOT_APPLICABLE`. Switching on/off is audited.
2. `promotions.policy` (`{ maxDiscountPercent: number }`, default `{ maxDiscountPercent: 50 }`, integer `1..100`, `writeCapability: "promotions.manage"`):
   - Global "Largest discount per order" hard ceiling capping combined `(bundle + promo)` discount at `Math.floor((subtotalMinor * maxDiscountPercent) / 100)`. Round-half-up applies only to percentage promotion math, never to the global ceiling (so a `$0.01` subtotal under a `50%` guard caps at `0`, never `1¢`). Order totals are never negative.

## Pricing, Zero-Contribution & First-Order Contract

- **Zero-contribution suppression**: when `!combineWithBundle` and `bundleDiscountMinor >= rawPromoMinor`, or when the global guard leaves `promoDiscountMinor === 0`, the promotion contributes `0`: `discountLabel` omits the promotion label (`bundleLabel ?? ""`), and `redeemInTx` does **not** insert a `promo_redemptions` row, increment redemption counters, or emit `promotion.redeemed`.
- **Smallest free slot reuse**: `redeemInTx` acquires row locks (`FOR UPDATE`) on `promo_batches`, `promo_codes`, and the active `promo_redemptions` rows, selecting the smallest free slot (`1..cap`) across `activeCodeSequence`, `activeBatchSequence`, and `activeCodeSlot` so releasing a non-last redemption under `cap >= 2` frees that exact slot for reuse.
- **`firstOrderOnly`**: requires zero prior historical `orders` rows for `customerUserId` (`FOR SHARE` under redemption lock), including cancelled historical orders (so previously cancelled paid orders never re-qualify a customer as first-order).

## Binding Service Port (`deps.services.promotions`)

Implements `INCREMENT_05_CONTRACT.md` §3 plus `isEnabled`, `guardAttempt`, and `recheck`:

```ts
export interface PromotionLine {
  productPublicId: string;
  packetNumber: number | null;
  tierKey: string | null;
  lineTotalMinor: number;
}

export interface PromotionContext {
  /** Raw input; normalised by promotions (`trim().toUpperCase()`). Never logged or audited. */
  code: string;
  /** The order owner, not the actor. */
  customerUserId: number;
  actorUserId: number;
  currency: string;
  lines: readonly PromotionLine[];
  subtotalMinor: number;
  bundleDiscountMinor: number;
  bundleLabel: string | null;
}

export interface PromotionOutcome {
  promoPublicId: string;
  label: string;
  promoDiscountMinor: number;
  bundleDiscountMinor: number;
  discountMinor: number;
  discountLabel: string;
  totalMinor: number;
}

export interface PromotionsPort {
  isEnabled(opts?: { tx?: DbOrTx }): Promise<boolean>;
  /**
   * Wraps active caller entrypoints (`orders.quote`, `orders.create`) outside their business `db.transaction(...)`
   * so rate-limit / 15m pause checks and post-rollback `PROMO_NOT_APPLICABLE` failure accounting persist on the pool.
   */
  guardAttempt?<T>(actorUserId: number, fn: () => Promise<T>): Promise<T>;
  /**
   * Pass `recheck: true` when re-evaluating an already-saved cart code (e.g. `cart.get`, line edits, pre-checkout)
   * so passive re-evaluations do not increment the 5-failures-in-15-minutes brute-force counter.
   */
  preview(ctx: PromotionContext, opts?: { tx?: DbOrTx; recheck?: boolean }): Promise<PromotionOutcome>;
  redeemInTx(tx: Tx, ctx: PromotionContext & { orderPublicId: string; correlationId: string }): Promise<PromotionOutcome>;
  releaseForOrderInTx(tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }): Promise<{ released: boolean }>;
}
```

## Error Reason Codes (`SafeErrorData.reasonCode`)

- `PROMO_NOT_APPLICABLE` (`VALIDATION` / HTTP 400): `"This code cannot be applied."` (uniform message for feature off, unknown/malformed code, paused, revoked, scheduled, expired, exhausted, per-customer cap reached, not first order, unverified e-mail, staff/admin self-redemption, currency mismatch, or allow-list mismatch).
- `PROMO_ATTEMPTS_BLOCKED` (`RATE_LIMITED` / HTTP 429): `"Too many unsuccessful code attempts. Please wait 15 minutes before trying another code."` (`details: { retryAfterSeconds }`).
- `PROMO_MIN_SUBTOTAL` (`VALIDATION` / HTTP 400): `"Add <formatted amount> more to use this code."` (`details: { minSubtotalMinor, shortfallMinor, currency }` — returned ONLY after code validity and customer entitlement succeed).
- `PROMO_NOT_ELIGIBLE_ITEMS` (`VALIDATION` / HTTP 400): `"None of the items in your order are eligible for this code."` (returned ONLY after code validity and customer entitlement succeed).
- `LABEL_MATCHES_CODE` (`VALIDATION` / HTTP 400): `"The customer-facing label must not match the promotion code."`
- `REDEMPTION_RELEASE_NOT_ELIGIBLE` (`CONFLICT` / HTTP 409): `"This redemption can only be released when the order is cancelled, nothing was ever paid, no invoice is open, and no online payment attempt was ever started."`

## Audit Events & Safe Attributes (`promotion.*`)

Raw codes, batch code arrays, request payloads, and `#promo=` URLs are **never** written to logs or audit attributes.

| `eventName` | `category` | `severity` | `subject` | `attributes` |
| --- | --- | --- | --- | --- |
| `promotion.created` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, discountType, scopeKind, isBatch, batchSize }` |
| `promotion.updated` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, version }` |
| `promotion.paused` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, previousStatus, status: "paused" }` |
| `promotion.resumed` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, previousStatus, status: "active" }` |
| `promotion.revoked` | `admin` | `WARN` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, previousStatus, status: "revoked" }` |
| `promotion.batch_generated` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, generatedCount, totalBatchSize }` |
| `promotion.revealed` | `security` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, codePublicId }` |
| `promotion.exported` | `security` | `INFO` | `{ type: "promotion_export", id: promoPublicId ?? "all" }` | `{ exportKind: "codes" \| "redemptions", promoPublicId, rowCount }` |
| `promotion.redeemed` | `order` | `INFO` | `{ type: "order", id: orderPublicId }` | `{ promoPublicId, redemptionPublicId, label, orderPublicId, promoDiscountMinor, discountMinor, currency }` |
| `promotion.released` | `order` | `INFO` | `{ type: "order", id: orderPublicId }` | `{ promoPublicId, redemptionPublicId, label, orderPublicId, releaseReason, manual: boolean }` |
| `promotion.attempts_blocked` | `security` | `WARN` | `{ type: "user", id: customerPublicId }` | `{ failedCount, windowMinutes: 15, pauseMinutes: 15 }` |
| `promotion.settings_updated` | `admin` | `WARN` | `{ type: "setting", id: "promotions.policy" }` | `{ enabled, maxDiscountPercent }` |

## tRPC Router Shapes (`trpc.promotions.*`)

### Customer / Order Entry
- No direct customer `promotions.*` procedure is exposed (preventing client-supplied line prices or standalone code-oracle probing per contract §4). Customers and console operators apply codes exclusively through server-priced `cart.applyCode` and `orders.quoteWithPromo` / `orders.create` / `orders.admin.createForCustomer`, which call `services.promotions.{guardAttempt,preview,redeemInTx}`.

### Admin Console (`trpc.promotions.admin.*`)

Reads require `staffProcedure.use(requireCapability("promotions.read"))`.
Writes, reveals, manual redemption releases, and CSV exports require `adminProcedure.use(requireCapability("promotions.manage"))` (step-up MFA + in-transaction actor re-validation).

- `promotions.admin.list` (query, `promotions.read`):
  - Input: `{ status?: "active" | "paused" | "revoked" | "scheduled" | "expired" | "exhausted"; type?: "percent" | "fixed"; endingWithinDays?: number; query?: string; cursor?: string; limit?: number }`
  - Output: `{ items: PromotionView[]; nextCursor: string | null }`
- `promotions.admin.get` (query, `promotions.read`):
  - Input: `{ publicId: string }`
  - Output: `PromotionView`
- `promotions.admin.create` (mutation, `promotions.manage` + step-up):
  - Input: `{ name: string; label: string; type: "percent" | "fixed"; percentBps?: number | null; maxDiscountMinor?: number | null; amountMinor?: number | null; currency?: string | null; scope: PromotionScope; minSubtotalMinor?: number; startsAt?: string | null; endsAt?: string | null; maxRedemptions?: number | null; maxPerCustomer?: number; firstOrderOnly?: boolean; allowCustomerPublicIds?: string[]; allowEmailDomains?: string[]; combineWithBundle?: boolean; note?: string | null; isBatch?: boolean; code?: string; codePrefix?: string | null; initialBatchCount?: number; idempotencyKey?: string }`
  - Output: `{ promotion: PromotionView; initialCode: string | null; generatedCount: number }`
- `promotions.admin.update` (mutation, `promotions.manage` + step-up):
  - Input: `{ publicId: string; expectedVersion: number; name?: string; label?: string; maxDiscountMinor?: number | null; scope?: PromotionScope; minSubtotalMinor?: number; startsAt?: string | null; endsAt?: string | null; maxRedemptions?: number | null; maxPerCustomer?: number; firstOrderOnly?: boolean; allowCustomerPublicIds?: string[]; allowEmailDomains?: string[]; combineWithBundle?: boolean; note?: string | null }`
  - Output: `PromotionView`
- `promotions.admin.pause` / `promotions.admin.resume` / `promotions.admin.revoke` (mutations, `promotions.manage` + step-up):
  - Input: `{ publicId: string; expectedVersion: number }`
  - Output: `PromotionView`
- `promotions.admin.setStatus` (mutation, `promotions.manage` + step-up):
  - Input: `{ publicId: string; expectedVersion: number; status: "active" | "paused" | "revoked" }`
  - Output: `PromotionView`
- `promotions.admin.generateBatch` (mutation, `promotions.manage` + step-up):
  - Input: `{ publicId: string; count: number; prefix?: string | null; idempotencyKey: string }`
  - Output: `{ promotion: PromotionView; generated: number }`
- `promotions.admin.reveal` (mutation, `promotions.manage` + step-up, audited `promotion.revealed`):
  - Input: `{ publicId: string; codePublicId?: string }`
  - Output: `{ code: string }`
- `promotions.admin.redemptions` (query, `promotions.read`):
  - Input: `{ promotionPublicId?: string; status?: "redeemed" | "released"; cursor?: string; limit?: number }`
  - Output: `{ items: PromotionRedemptionView[]; nextCursor: string | null }`
- `promotions.admin.releaseRedemption` (mutation, `promotions.manage` + step-up, audited `promotion.released`):
  - Input: `{ redemptionPublicId: string; reason: string }`
  - Output: `PromotionRedemptionView`
  - Enforces the strictly conservative G-C3-02 evidence fence inside the MySQL transaction: order must be in a terminal cancel state of its bound `order_workflow_versions` definition (`isCancelState`), and compliance's authoritative `orderPaymentExposureInTx(tx, orderPublicId)` must report `grossPaidMinor === 0`, `payableInvoiceOpen === false`, `providerCapturePending === false`, and `providerAttemptEver === false` (no provider payment attempt row was ever created in any status).
- `promotions.admin.stats` (query, `promotions.read`):
  - Input: `{ promotionPublicId?: string }`
  - Output: `{ activePromotions: number; redemptions: number; releasedRedemptions: number; discountMinorByCurrency: Record<string, number> }`
- `promotions.admin.exportCodes` (mutation, `promotions.manage` + step-up, audited `promotion.exported`):
  - Input: `{ publicId: string }`
  - Output: `{ fileName: string; csv: string; rowCount: number }` (includes pre-filled `/promo#promo=<encodedCode>` capture path; spreadsheet formulas neutralized).
- `promotions.admin.exportRedemptions` (mutation, `promotions.manage` + step-up, audited `promotion.exported`):
  - Input: `{ promotionPublicId?: string; status?: "redeemed" | "released" }`
  - Output: `{ fileName: string; csv: string; rowCount: number }`
- `promotions.admin.getSettings` (query, `promotions.read`):
  - Output: `{ enabled: boolean; maxDiscountPercent: number }`
- `promotions.admin.updateSettings` (mutation, `promotions.manage` + step-up, audited `promotion.settings_updated`):
  - Input: `{ enabled?: boolean; maxDiscountPercent?: number }`
  - Output: `{ enabled: boolean; maxDiscountPercent: number }`
