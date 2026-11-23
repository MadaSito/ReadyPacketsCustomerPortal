# Promotions Module — Server Port & tRPC API Contract (Increment 05 & Increment 06 D5)

Owner: `siem_engineer` (`server/modules/promotions/**`)

## Module Exports (for `server/container.ts` & `server/trpc/router.ts`)

- `server/modules/promotions/index.ts`:
  - `createPromotionsModule(deps: ModuleDeps): PromotionsModule`
  - `PromotionsModule` (`ModuleLifecycle & PromotionsService`)
  - Settings exports (`PROMOTIONS_ENABLED_FLAG`, `PROMOTIONS_POLICY_SETTING`, `DEFAULT_PROMOTIONS_POLICY`, `parsePromotionsPolicy`, `percentToBps`, `bpsToPercent`)
- `server/modules/promotions/router.ts`:
  - `promotionsRouter` (mount on `appRouter` as `promotions: promotionsRouter`)
- `server/modules/promotions/schema.ts`:
  - `promoBatches` (`promo_batches`: `discount_type` enum `"percent" | "fixed" | "set_total"`, `percent_bps` `1..10_000`, `amount_minor`, `set_total_minor`)
  - `promoCodes` (`promo_codes`)
  - `promoRedemptions` (`promo_redemptions`)
  - `promoCheckAttempts` (`promo_check_attempts`)

## Code Normaliser, Batch Alphabet & Label Hygiene

- **Normaliser (`normalizePromoCode`)**: `raw.trim().toUpperCase()`.
- **Admin custom code rule**: `6..32` characters matching `/^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/` (uppercase `A–Z`, `0–9`, internal `-`; no leading or trailing hyphen).
- **Batch code generation**: CSPRNG (`crypto.randomInt`) over unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (excludes `0, O, 1, I, L`), `12` random characters; optional `codePrefix` matches `/^[A-Z0-9]{1,12}$/` and formats as `<PREFIX>-<12 RANDOM CHARS>`.
- **Label/code separation**: `create` and `update` reject `label` when `label.trim().toUpperCase()` equals the normalized code (or prefix) with `VALIDATION` / `LABEL_MATCHES_CODE` so secret codes never leak via `label` onto orders, invoices, or audit records.
- **Internal `preview` / `guardAttempt` evaluation**: normalizes with `trim().toUpperCase()`; any malformed, out-of-range, or unknown string executes a bounded dummy MySQL lookup + decrypt path for timing parity and fails closed with the uniform `PROMO_NOT_APPLICABLE` error. Rate-limited per account (`promo:acct:<userId>`) and per normalized IPv4/IPv6 `/64` prefix (`rateLimitAddress` -> `blindIndex(..., "promo_check.ip")`); any 5 failed attempts within 15 minutes pause code attempts for 15 minutes and emit `promotion.attempts_blocked` (`WARN`).

## Settings Keys

1. `feature.promotions` (`boolean`, default `false`, `clientVisible: true`, `writeCapability: "promotions.manage"`):
   - Master switch. When `false`, `guardAttempt`, `preview`, and `redeemInTx` refuse with `PROMO_NOT_APPLICABLE`. Switching on/off is audited.
2. `promotions.policy` (`PromotionsPolicyConfig`, `writeCapability: "promotions.manage"`, `managedBy: { href: "/admin/promotions", label: "Discount codes — Limits" }`):
   - `maxDiscountPercent`: `0.01..100` (at most two decimal places), default `100` (basis points `1..10_000`).
   - `maxFixedAmountMinor`: `number | null` (`>= 1` when set), default `null` (unlimited).
   - `allowZeroTotal`: `boolean`, default `true`.
   - `minOrderTotalAfterDiscountMinor`: `number` (`>= 0`), default `0`.
   - Legacy stored values (such as `{ maxDiscountPercent: 50 }` from Increment 05) parse cleanly with defaults via `promotionsPolicySchema` / `parsePromotionsPolicy` and never throw on upgraded sites.

## Discount Kinds, Rounding & Allocation Contract (D5)

- **Kinds**:
  - `percent`: `percentBps` in `1..10_000` (`0.01%` to `100.00%`, or `percent` in `0.01..100` on `admin.create`); optional `maxDiscountMinor`.
  - `fixed`: `amountMinor >= 1` + `currency` (`amountMinor === 0` is rejected on `admin.create` with `PROMO_ZERO_FIXED_USE_SET_TOTAL`).
  - `set_total`: `setTotalMinor >= 0` + `currency` (e.g. `$0.00` or `$0.01` test-order codes). Requires `subtotalMinor >= setTotalMinor` (otherwise `PROMO_MIN_SUBTOTAL`), and rejects mixed ineligible lines (`PROMO_NOT_ELIGIBLE_ITEMS`) when `ineligibleSubtotalMinor > setTotalMinor` so order scalar and per-line net totals never diverge.
- **Single half-up rounding & remainder allocation (`computePromotionPricing`)**:
  - Percentage discounts compute `Math.floor((eligibleSubtotalMinor * percentBps + 5_000) / 10_000)` once at the order level, capped by `maxDiscountMinor` and `eligibleSubtotalMinor`.
  - Line discounts allocate proportionally across eligible lines by largest fractional remainder (ties broken by earlier line index), capped at each line's remaining gross capacity, guaranteeing:
    - `sum(lineAllocations[i].discountMinor) === discountMinor`
    - `sum(lineAllocations[i].netMinor) === totalMinor`
    - `lineAllocations[i].netMinor >= 0` for every line `i`
- **Explicit limit rejections**: checked only after code validity, customer entitlement, minimum subtotal, and line eligibility pass, naming the specific limit (`PROMO_LIMIT_MAX_PERCENT`, `PROMO_LIMIT_MAX_FIXED`, `PROMO_LIMIT_ZERO_TOTAL`, `PROMO_LIMIT_MIN_TOTAL`). Staff/admin callers additionally receive `details.limitsHref = "/admin/promotions#limits"`.
- **`canReachZero` list flag**: `PromotionView.canReachZero` is `true` for `percent` with `percentBps === 10_000`, any `fixed` (`amountMinor >= 1`, since an eligible subtotal `<= amountMinor` reaches `0`), and `set_total` with `setTotalMinor === 0`. Creating a zero-capable promotion or updating zero-total policy limits enforces step-up MFA against a live non-revoked session inside the MySQL transaction.

## Binding Service Port (`deps.services.promotions`)

```ts
export interface PromotionLine {
  productPublicId: string;
  packetNumber: number | null;
  tierKey: string | null;
  lineTotalMinor: number;
}

export interface PromotionLineAllocation {
  lineIndex: number;
  grossMinor: number;
  bundleDiscountMinor: number;
  promoDiscountMinor: number;
  discountMinor: number;
  netMinor: number;
}

export interface PromotionOutcome {
  promoPublicId: string;
  label: string;
  promoDiscountMinor: number;
  bundleDiscountMinor: number;
  discountMinor: number;
  discountLabel: string;
  totalMinor: number;
  lineAllocations?: readonly PromotionLineAllocation[];
}

export interface PromotionsPort {
  isEnabled(opts?: { tx?: DbOrTx }): Promise<boolean>;
  guardAttempt?<T>(actorUserId: number, fn: () => Promise<T>): Promise<T>;
  preview(ctx: PromotionContext, opts?: { tx?: DbOrTx; recheck?: boolean }): Promise<PromotionOutcome>;
  redeemInTx(tx: Tx, ctx: PromotionContext & { orderPublicId: string; correlationId: string }): Promise<PromotionOutcome>;
  releaseForOrderInTx(tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }): Promise<{ released: boolean }>;
}
```

## Error Reason Codes (`SafeErrorData.reasonCode`)

- `PROMO_NOT_APPLICABLE` (`VALIDATION` / HTTP 400): `"This code cannot be applied."` (uniform message for feature off, unknown/malformed code, paused, revoked, scheduled, expired, exhausted, per-customer cap reached, not first order, unverified e-mail, staff/admin self-redemption, currency mismatch, or allow-list mismatch).
- `PROMO_ATTEMPTS_BLOCKED` (`RATE_LIMITED` / HTTP 429): `"Too many unsuccessful code attempts. Please wait 15 minutes before trying another code."` (`details: { retryAfterSeconds }`).
- `PROMO_MIN_SUBTOTAL` (`VALIDATION` / HTTP 400): `"Add <formatted amount> more to use this code."` (`details: { minSubtotalMinor, shortfallMinor, currency }`).
- `PROMO_NOT_ELIGIBLE_ITEMS` (`VALIDATION` / HTTP 400): `"None of the items in your order are eligible for this code."` (or ineligible items exceed a `set_total` target).
- `PROMO_LIMIT_MAX_PERCENT` (`VALIDATION` / HTTP 400): names `details.limit = "maxDiscountPercent"` (`maxDiscountPercent`, `maxDiscountBps`, optional `limitsHref`).
- `PROMO_LIMIT_MAX_FIXED` (`VALIDATION` / HTTP 400): names `details.limit = "maxFixedAmountMinor"` (`maxFixedAmountMinor`, `currency`, optional `limitsHref`).
- `PROMO_LIMIT_ZERO_TOTAL` (`VALIDATION` / HTTP 400): names `details.limit = "allowZeroTotal"` (`allowZeroTotal: false`, optional `limitsHref`).
- `PROMO_LIMIT_MIN_TOTAL` (`VALIDATION` / HTTP 400): names `details.limit = "minOrderTotalAfterDiscountMinor"` (`minOrderTotalAfterDiscountMinor`, `currency`, optional `limitsHref`).
- `PROMO_ZERO_FIXED_USE_SET_TOTAL` (`VALIDATION` / HTTP 400): guides admins creating a `0` fixed discount to use `type: "set_total"` with `setTotalMinor: 0`.
- `LABEL_MATCHES_CODE` (`VALIDATION` / HTTP 400): `"The customer-facing label must not match the promotion code."`
- `REDEMPTION_RELEASE_NOT_ELIGIBLE` (`CONFLICT` / HTTP 409): conservative G-C3-02 release fence.

## Audit Events & Safe Attributes (`promotion.*`)

Raw codes, batch code arrays, request payloads, and `#promo=` URLs are **never** written to logs or audit attributes.

| `eventName` | `category` | `severity` | `subject` | `attributes` |
| --- | --- | --- | --- | --- |
| `promotion.created` | `admin` | `INFO` | `{ type: "promotion", id: promoPublicId }` | `{ promoPublicId, label, discountType, scopeKind, isBatch, batchSize, canReachZero }` |
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
| `promotion.settings_updated` | `admin` | `WARN` | `{ type: "setting", id: "promotions.policy" }` | `{ enabled, maxDiscountPercent, maxDiscountBps, maxFixedAmountMinor, allowZeroTotal, minOrderTotalAfterDiscountMinor }` |

## Admin Console (`trpc.promotions.admin.*`)

Reads require `staffProcedure.use(requireCapability("promotions.read"))`.
Writes, reveals, manual redemption releases, and CSV exports require `adminProcedure.use(requireCapability("promotions.manage"))` (step-up MFA + in-transaction actor re-validation).

- `promotions.admin.list`: `type?: "percent" | "fixed" | "set_total"` filter; returns `{ items: PromotionView[]; nextCursor: string | null }` where each `PromotionView` includes `percent: number | null`, `percentBps: number | null`, `amountMinor: number | null`, `setTotalMinor: number | null`, and `canReachZero: boolean`.
- `promotions.admin.get`: `{ publicId }` -> `PromotionView`.
- `promotions.admin.create`: accepts `type: "percent" | "fixed" | "set_total"`, `percentBps` (`1..10_000`) or `percent` (`0.01..100`), `amountMinor`, `setTotalMinor`, `currency`, `scope`, caps, schedule, allow-lists, and single/batch options.
- `promotions.admin.update` / `pause` / `resume` / `revoke` / `setStatus` / `generateBatch` / `reveal` / `redemptions` / `releaseRedemption` / `stats` / `exportCodes` / `exportRedemptions`.
- `promotions.admin.getSettings`: returns `{ enabled, maxDiscountPercent, maxDiscountBps, maxFixedAmountMinor, allowZeroTotal, minOrderTotalAfterDiscountMinor }`.
- `promotions.admin.updateSettings`: updates `{ enabled?, maxDiscountPercent?, maxFixedAmountMinor?, allowZeroTotal?, minOrderTotalAfterDiscountMinor? }` and audits `promotion.settings_updated`.
