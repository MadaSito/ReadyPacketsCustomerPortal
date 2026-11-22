# Promotions Module Verification Matrix (Increment 05, Package C1)

Owner: `siem_engineer` (`server/modules/promotions/**`)

## Commands Executed

- `scripts/dev/test.sh server/modules/promotions/promotions.test.ts` — 7/7 tests passing against real MySQL (`createTestDb`).
- `scripts/dev/test.sh server/modules/orders/promotions.test.ts` — 12/12 cross-module Orders + Promotions integration tests passing against real MySQL.
- `scripts/dev/test.sh server/modules/cart/cartUpsellPromo.test.ts` — 4/4 cross-module Cart + Promotions integration tests passing against real MySQL.
- `scripts/dev/tc.sh` — workspace-wide TypeScript check.
- `scripts/dev/lint.sh server/modules/promotions` — ESLint on owned module paths.

## Contract & Security Verification Matrix

| Requirement / Finding | Implementation | Verified By (`server/modules/promotions/promotions.test.ts`) |
| --- | --- | --- |
| RBAC (`promotions.read` vs `promotions.manage`), step-up MFA, in-transaction actor re-validation (`users` + `user_sessions` `FOR UPDATE`), and no client-priced `promotions.check` endpoint exposed (`"check" in promotionsRouter._def.procedures === false`) | `router.ts`, `service.ts` (`revalidatePrivilegedActorInTx`) | `enforces role, capability, step-up MFA, and in-transaction actor re-validation across all procedures` |
| `feature.promotions` default off (`false`) & `promotions.policy` (`maxDiscountPercent` default `50`), label != code (`LABEL_MATCHES_CODE`) | `settings.ts`, `codes.ts`, `service.ts` | `rejects label matching code/prefix (LABEL_MATCHES_CODE) and keeps feature.promotions off by default` |
| Pricing math: percentage (`percentBps`, optional `maxDiscountMinor`) & fixed (`amountMinor` + `currency`), scope filters (`all`, `products`, `tiers`, `packets`), `combineWithBundle` vs winner-takes-more, floored global guard (`Math.floor`), never-negative total | `service.ts` (`computeDiscountOutcome`, `computeEligibleSubtotal`) | `computes pricing accurately: bundle vs promo winner, combineWithBundle, scopes, caps, and global 50% guard` and `reuses smallest free slot after non-last release, floors guard on tiny subtotals, suppresses zero-contribution redemptions...` |
| Zero-contribution suppression (no `promo_redemptions` row, counter increment, `promotion.redeemed` audit, or promo label when bundle ties/wins or floored guard leaves `promoDiscountMinor === 0`) | `service.ts` (`computeDiscountOutcome`, `redeemInTx`) | `reuses smallest free slot after non-last release, floors guard on tiny subtotals, suppresses zero-contribution redemptions...` + `server/modules/orders/promotions.test.ts` |
| Keyed-hash (`blindIndex(..., "promo_codes.code")`) + AEAD encrypted code value (`encrypt(..., "promo_codes.code:<publicId>")`), masked summaries (`SA••••20`), never logged/audited | `codes.ts`, `service.ts` | `prevents enumeration with uniform errors, blocks IDOR/self-redemption, and pauses account after 5 failures in 15m (WARN SIEM event)` |
| Anti-enumeration uniform `PROMO_NOT_APPLICABLE`, bounded dummy lookup + decrypt timing parity on unknown/malformed codes, cart hints (`PROMO_MIN_SUBTOTAL`, `PROMO_NOT_ELIGIBLE_ITEMS`) gated behind entitlement, verified e-mail required, staff/admin self-redemption blocked, cross-customer IDOR blocked (`orders.manage` required) | `service.ts` (`runBoundedDummyLookup`, `evaluateCode`) | `prevents enumeration with uniform errors, blocks IDOR/self-redemption, and pauses account after 5 failures in 15m (WARN SIEM event)` |
| Rate limit (`rateLimitAddress` IPv4 / IPv6 `/64` normalization before blinding), concurrency-safe `promo_check_attempts` (`ON DUPLICATE KEY UPDATE` + `FOR UPDATE`), non-consecutive 5 failures in 15m -> 15m pause (`PROMO_ATTEMPTS_BLOCKED` + `promotion.attempts_blocked` `WARN`), `guardAttempt` post-rollback accounting | `service.ts` (`consumeCheckRateLimits`, `recordFailedAttempt`, `guardAttempt`) | `prevents enumeration with uniform errors...` and `reuses smallest free slot after non-last release... enforces guardAttempt + non-consecutive 5-fail pause + IPv6 /64 normalization` |
| Atomic MySQL redemption under row locks (`FOR UPDATE` on batch, code, and active redemptions) + unique active slot keys, smallest free slot reuse (`1..cap`), concurrency race ("last redemption: exactly one wins") | `schema.ts`, `service.ts` (`smallestFreeSlot`, `redeemInTx`) | `enforces atomic redemption under real MySQL concurrency: last redemption — exactly one wins` and `reuses smallest free slot after non-last release...` |
| `firstOrderOnly` checks all historical `orders` rows (`FOR SHARE`), including cancelled orders | `service.ts` (`evaluateCode`) | `reuses smallest free slot after non-last release...` (`FIRST-STRICT` against cancelled historical order) |
| CSPRNG single-use batch generation (unambiguous alphabet, 12 random chars, idempotent replay + `IDEMPOTENCY_KEY_MISMATCH`), formula-safe CSV exports (`exportCodes` `/promo#promo=...`, `exportRedemptions`) | `codes.ts`, `service.ts` (`generateBatch`, `exportCodes`, `exportRedemptions`) | `generates idempotent CSPRNG single-use batches, neutralizes CSV formulas, and enforces G-C3-02 release fence` |
| Strictly conservative G-C3-02 release fence (`isCancelState` against bound `order_workflow_versions.definition` + `grossPaidMinor === 0`, `!payableInvoiceOpen`, `!providerCapturePending`, `!providerAttemptEver`) | `service.ts` (`releaseForOrderInTx`, `releaseRedemption`) | `generates idempotent CSPRNG single-use batches, neutralizes CSV formulas, and enforces G-C3-02 release fence` |

## What Is Not Verified Here

- Browser UI rendering, keyboard navigation, and client `#promo=` fragment capture on `/promo`, `/cart`, `/orders/new`, and `/admin/promotions` are owned and verified by the client packages (B2, C2, C3).
- End-to-end live Stripe/Square webhook delivery into `payment_attempts` is covered by Compliance's module tests (`server/modules/compliance/**`); C1 verifies the authoritative `orderPaymentExposureInTx` contract including `providerAttemptEver === true` refusal and absent-port fail-closed refusal.
