# Package L (`cart`) & Backup Copy-Log Continuity — Verification Record (Increment 04)

Owner: `recovery_ops_engineer`

## 1. Commands Executed & Verified

- **TypeScript (`scripts/dev/tc.sh`):**
  - Clean (`0` errors) across `server/modules/cart/*`, `server/modules/backup/*`, and `client/src/features/cart/*`.
- **Server integration & abuse-case suite (`scripts/dev/test.sh server/modules/cart/cart.test.ts`):**
  - **7/7 passing** against real MySQL (`carts`, `cart_items`, `orders`, `compliance_*`, `users`) + real `OrdersModule` + real `ComplianceModule`:
    1. Feature switch (`feature.cart`) defaults off; `badgeCount` returns `{ enabled: false, itemCount: 0 }`; customer reads/mutations fail closed with `NOT_FOUND:CART_FEATURE_DISABLED`; hourly `cart.abandoned.expire` schedule registered on `init()`.
    2. 5-actor authorization matrix (anonymous, customer owner, other customer, staff with `carts.read_all`, admin) + remediation-session rejection + `authz.cart.denied` audit emission.
    3. Abuse cases (§4): strict Zod input validation rejects forged `unitPriceMinor` / discount / tax fields; packet quantity `> 1` rejected (`PACKET_QUANTITY_ONE`); single open cart invariant (`open_customer_key`); tier switching replaces prior tier of the same packet; optimistic CAS (`STALE_VERSION`); live catalogue price & `orders.bundle_rule` recomputation when admin changes product prices mid-cart.
    4. Field-level AES-256-GCM encryption at rest for `note_enc` (`cart.note`) and `billing_enc` (`cart.billing`); staff `cart.admin.listOpen` and `cart.admin.getOpen` expose zero decrypted notes or billing PII.
    5. Atomic checkout in one DB transaction (`tx`): required policy enforcement (`CONFLICT:POLICY_ACCEPTANCE_REQUIRED`), fail-closed audit rollback (no orphan order or invoice when `audit` throws), idempotent checkout replay (`checkout_idempotency_key`), and offline `mode: "invoice"` checkout when `payments` provider is `"none"`.
    6. Hosted redirect checkout (`mode: "redirect"`), Decision 12 strictly read-only `cart.checkoutStatus` (`pending_confirmation` until webhook marks paid — browser return never marks an invoice or attempt paid), explicit `POST` `cart.restoreCheckout` idempotency, and `CONFLICT:CHECKOUT_ALREADY_PAID` refusal once paid.
    7. Fenced worker job `cart.abandoned.expire` transitions inactive open carts past `cart.abandoned_ttl_hours` to `expired` with `cart.expired` audit events while preserving active carts.
- **Backup 3-2-1 copy-log & restore mail-quarantine suite (`scripts/dev/test.sh server/modules/backup/backup.test.ts`):**
  - **9/9 passing** against real MySQL + `mysqldump`:
    - `storage_copy_attempts` recording (`verification: "checksum"` for verified SHA-256 / QuickXorHash digests), `mayRetryOffsiteCopy`, guarded `copyOffsiteNow(..., { expectedFailedJobId })` (`CONFLICT:COPY_RETRY_STALE` on stale job IDs), and `mail_outbox.payload_enc = NULL` during post-restore quarantine.
- **Client UI & WCAG 2.2 AA accessibility suites (run one file at a time):**
  - `scripts/dev/test.sh client/src/features/cart/AdminOpenCartsPage.test.tsx` — **11/11 passing** (`pageA11y` in light & dark on `/admin/carts` list, open detail `Drawer`, and `/orders/new` `OrderFormCartBanner` wrapper; cursor `LoadMore`, search/reset, feature-off banner, zero-PII rendering).
  - Coordinated companion suites: `CartPage.test.tsx` (`ui_foundation_engineer`, 9/9 passing with light/dark `pageA11y`) and `CheckoutPages.test.tsx` (`files_engineer`, 11/11 passing with light/dark `pageA11y`).
- **ESLint:**
  - Verified clean on all owned `server/modules/cart`, `server/modules/backup`, and `client/src/features/cart` files.

## 2. What Used Controlled Fakes in Unit/Integration Tests

- In `server/modules/cart/cart.test.ts`, `OrdersModule`, `ComplianceModule`, and MySQL transactions are **real**, while `CartPaymentsPort` uses an in-memory protocol fake (`FakePayments`) to simulate Stripe redirect URLs, `redirected` -> `paid` webhook state transitions, and `cancelAttemptIfUnpaid` without outbound internet traffic. Real Stripe/Square wire signing and webhook verification are exercised in `server/modules/payments/`.
- Client component tests mock `@/lib/trpc` query/mutation handlers in JSDOM with `axe-core` (`pageA11y`) in both light and dark themes.

## 3. What Is Not Verified Here

- Live browser round-trip against external production Stripe or Square hosted checkout endpoints (by design, self-hosted CI/dev runs offline without live merchant credentials).
- Assistive-technology manual screen-reader walkthroughs (NVDA/JAWS/VoiceOver); automated checks cover `axe-core` WCAG 2.2 AA rules, landmark structure, heading order, form label association, and light/dark token usage (designed and tested against WCAG 2.2 AA).
