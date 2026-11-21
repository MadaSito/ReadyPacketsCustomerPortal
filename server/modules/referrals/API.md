# Referrals Module — Public Contract (`server/modules/referrals`)

Owner: `siem_engineer` (Increment 04, Package G)

## 1. Purpose & Default State

Implements Decision 8 (Customer Referrals):
- Ships **disabled by default** via feature flag `referrals` (`feature.referrals = false`, `clientVisible: true`). Switching the programme on or off requires `referrals.manage` (step-up), re-validates the live administrator inside the transaction, and writes a durable audit event.
- One non-guessable `10`-character referral code per customer generated with CSPRNG from the unambiguous 31-character alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (`0-9` and `A-Z` without look-alikes `0, O, 1, I, L`; ~49.5 bits entropy).
- Attribution at registration (`/register?ref=CODE`, plus 30-day first-party functional cookie endpoint `/api/referrals/hold`), refusing self-referral, canonical e-mail alias self-dealing (`user+tag@domain`), and same-account matches.
- Qualification when the referred customer's **first** invoice is fully paid (`onInvoicePaid` domain port), computing integer minor-unit rewards (`fixed` minor amount or `percent` basis points with minor-unit cap and explicit 3-letter ISO currency).
- Approval is **manual by default** (`qualified_pending_approval -> approved | rejected`), guarded by compare-and-set (`version` + status check under `FOR UPDATE`).
- Approved rewards and explicit administrator credit/payout actions (`approved -> credited`) write append-only rows to `referral_reward_ledger`.
- "E-mail my link" uses registered system mail template `referrals.invite_friend`, carries no free-form sender body/URLs, identifies the sender by their verified account display name, and enforces durable rate limits **per customer** and **per recipient** (via HMAC blind index).

---

## 2. Container & Router Mount Exports (for `/root`)

- **Server module (`server/modules/referrals/index.ts`)**:
  - `export interface ReferralsModule extends ModuleLifecycle { ... }`
  - `export function createReferralsModule(deps: ModuleDeps): ReferralsModule`
  - Registry key on `ModuleRegistry` (`server/container.ts`): `referrals: ReferralsModule`
- **tRPC router (`server/modules/referrals/router.ts`)**:
  - `export const referralsRouter = router({ ... })` -> mount at `referrals: referralsRouter` in `server/trpc/root.ts`
- **Browser HTTP routes (`server/modules/referrals/http.ts`)**:
  - `export function registerReferralsHttpRoutes(router: Router, services: Services): void` -> mount at `/referrals` in `server/http/moduleRoutes.ts`
- **Database schema (`server/modules/referrals/schema.ts`)**:
  - Tables: `referralCodes`, `referrals`, `referralRewardLedger`, `referralEmailInvites`
- **Client feature (`client/src/features/referrals/routes.tsx`)**:
  - `export const referralsFeature: FeatureRoutes` -> register in `client/src/app/registry.ts`
  - Customer nav: `{ label: "Referrals", href: "/account/referrals", area: "customer", group: "Account", access: "customer", order: 210, enabledBy: "referrals" }`
  - Console nav: `{ label: "Referrals", href: "/admin/referrals", area: "console", group: "Operations", access: "staff", capability: "referrals.read_all", order: 28 }`
  - Route wrapper on `/register` capturing `?ref=CODE` into `/api/referrals/hold` (30-day first-party hold).

---

## 3. Cross-Module Service Ports (`deps.services.referrals`)

### 3.1 Registration Attribution Port (`identity` -> `referrals`)

```ts
export type ReferralAttributionRefusalCode =
  | "PROGRAM_DISABLED"
  | "CODE_INVALID"
  | "CODE_NOT_FOUND"
  | "CODE_DISABLED"
  | "REFERRER_INELIGIBLE"
  | "NEW_USER_INELIGIBLE"
  | "SELF_REFERRAL"
  | "SAME_ACCOUNT"
  | "ALREADY_ATTRIBUTED";

export interface AttributeRegistrationResult {
  attributed: boolean;
  referralPublicId?: string;
  reasonCode?: ReferralAttributionRefusalCode;
}

export interface ValidateReferralCodeResult {
  valid: boolean;
  programEnabled: boolean;
  normalizedCode: string | null;
  reasonCode?: ReferralAttributionRefusalCode;
}
```

Methods on `ReferralsModule`:

```ts
export interface ReferralsModule extends ModuleLifecycle {
  /**
   * Called by `identity` inside the registration transaction immediately after inserting
   * the new `users` row (`lock order: users -> referral_codes -> referrals`).
   *
   * - Normalizes `code` (`trim().toUpperCase()`).
   * - NEVER throws for unknown, malformed, disabled, self-referral, same-account, or
   *   duplicate codes — returns `{ attributed: false, reasonCode }` so registration
   *   responses remain uniform and never leak code/account existence.
   * - Propagates `AuditUnavailableError` if durable audit fails (fail-closed).
   */
  attributeRegistration(
    code: string,
    newUserId: number,
    tx: Tx,
  ): Promise<AttributeRegistrationResult>;

  /**
   * Server-side code check for trusted internal callers. Never returns referrer PII.
   * When `opts.ipAddress` is provided, enforces `auth_high_risk` rate-limiting.
   */
  validateCode(
    code: string,
    opts?: { tx?: DbOrTx; ipAddress?: string },
  ): Promise<ValidateReferralCodeResult>;

  /**
   * Domain event handler invoked by `compliance` (manual invoice payment reaching `paid`)
   * and `payments` (verified provider payment reaching `paid`).
   */
  onInvoicePaid(
    event: InvoicePaidReferralEvent,
    opts?: { tx?: Tx },
  ): Promise<OnInvoicePaidReferralResult>;
}
```

### 3.2 First-Invoice Qualification Port (`compliance` / `payments` -> `referrals`)

```ts
export interface InvoicePaidReferralEvent {
  invoicePublicId: string;
  orderPublicId: string;
  /** Numeric `users.id` of the order owner (the referred customer). */
  customerUserId: number;
  /** 3-letter uppercase ISO 4217 currency code (e.g. `"USD"`). */
  currency: string;
  /** Integer minor units. */
  subtotalMinor: number;
  /** Integer minor units. */
  discountMinor: number;
  /** Integer minor units. */
  taxMinor: number;
  /** Integer minor units (full invoice total paid). */
  totalMinor: number;
  /** Optional explicit flag from caller; if `false`, qualification is skipped (`not_first_invoice`). */
  isFirstPaidInvoice?: boolean;
  paidAt?: Date;
}

export type OnInvoicePaidReferralOutcome =
  | "qualified_pending_approval"
  | "auto_approved"
  | "not_referred"
  | "program_disabled"
  | "already_processed"
  | "already_qualified"
  | "not_first_invoice"
  | "referrer_ineligible";

export interface OnInvoicePaidReferralResult {
  outcome: OnInvoicePaidReferralOutcome;
  referralPublicId?: string;
  rewardAmountMinor?: number;
  currency?: string;
}
```

- Safe to call inside an existing `Tx` (`opts.tx`) or standalone. Uses only `tx` (never opens a second pool connection inside `tx`).
- Idempotent across duplicate webhook/payment retries for the same `invoicePublicId` (`outcome: "already_processed"`), and ignores subsequent invoices (`outcome: "already_qualified"`).

### 3.3 30-Day First-Party Referral Hold (`server/modules/referrals/http.ts`)

Mounted under `/api/referrals`:
- `POST /api/referrals/hold` — JSON `{ code: string }`. Validates syntax (`^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$`), enforces `form_submission` rate limit, and sets first-party `HttpOnly; SameSite=Lax` cookie `rp_ref` (`Max-Age=2592000`, 30 days, `Path=/`, `Secure` when `config.cookieSecure`) containing only the normalized 10-char code. Returns `{ held: boolean }` without querying whether the code exists in `referral_codes` (no enumeration oracle). Strictly functional to honour a visitor's explicit `?ref=CODE` navigation across sign-up.
- `GET /api/referrals/hold` — Reads `rp_ref` cookie (`Cache-Control: no-store`) and returns `{ code: string | null }` (null when absent, malformed, or when `feature.referrals` is off).
- `DELETE /api/referrals/hold` — Clears `rp_ref` cookie (`Cache-Control: no-store`), returning `{ cleared: true }`.

---

## 4. Settings, Feature Flags & Mail Templates

### 4.1 Settings & Feature Flag (`server/modules/referrals/settings.ts`)

- Feature flag:
  - `REFERRALS_ENABLED_FLAG`: `defineFeatureFlag({ flag: "referrals", owner: "referrals", group: "features", clientVisible: true, ... })` -> stored key `feature.referrals` (default `false`).
- Value setting:
  - `REFERRALS_PROGRAM_CONFIG`: `key: "referrals.program"`, `owner: "referrals"`, `group: "general"`, `sensitivity: "internal"`, `writeCapability: "referrals.manage"`, `managedBy: { href: "/admin/referrals", label: "Referrals" }`:
    - `rewardMode`: `"fixed" | "percent"` (default `"fixed"`)
    - `fixedAmountMinor`: `int >= 0 <= 100_000_000` (default `2500` = `25.00`)
    - `percentBps`: `int >= 1 <= 10_000` (default `1000` = `10.00%`)
    - `capAmountMinor`: `int >= 0 <= 100_000_000` (default `10000` = `100.00`)
    - `currency`: `/^[A-Z]{3}$/` (default `"USD"`)
    - `manualApprovalRequired`: `boolean` (default `true`)
    - `inviteMaxPerCustomerPerDay`: `int >= 1 <= 100` (default `10`)
    - `inviteMaxPerRecipientPerWindow`: `int >= 1 <= 5` (default `1`)
    - `inviteRecipientCooldownHours`: `int >= 1 <= 720` (default `168`, 7 days)

### 4.2 Shipped Mail Template (`server/modules/referrals/mail.ts`)

- Key: `referrals.invite_friend` (registered via `deps.mailer.registerTemplate`, automatically editable in `/admin/email-templates` via `mailTemplates`).
- Declared variables: `["senderName", "referralCode", "referralLink"]` (all server-derived; zero free-form user body or arbitrary links).

### 4.3 Outbound Webhook / Automation Event Names

Emitted to durable audit (and published to `deps.services.integrations` / automations trigger bus if present):
- `referral.program.updated` (`category: "admin"`, `action: "update"`)
- `referral.attributed` (`category: "business"`, `action: "create"`)
- `referral.attribution.refused` (`category: "security"`, `action: "refuse"`)
- `referral.qualified` (`category: "business"`, `action: "transition"`)
- `referral.approved` (`category: "admin"`, `action: "transition"`)
- `referral.rejected` (`category: "admin"`, `action: "transition"`)
- `referral.credited` (`category: "admin"`, `action: "transition"`)
- `referral.invite.sent` (`category: "business"`, `action: "create"`)
- `referral.invite.refused` (`category: "security"`, `action: "refuse"`)
- `referrals.exported` (`category: "admin"`, `action: "export"`)

---

## 5. tRPC Procedures (`trpc.referrals.*`)

| Procedure | Guard | Step-Up | Description |
| --- | --- | --- | --- |
| `referrals.publicStatus` | `publicProcedure` (`standard_browsing`) | No | Returns `{ enabled: boolean }` + syntactic code check `{ codeAcceptedFormat: boolean, normalizedCode: string \| null }` when optional `code` is passed (never queries DB existence — zero enumeration oracle). |
| `referrals.me.overview` | `protectedProcedure` (customer) | No | Ensures & returns customer's 10-char code, share URL (`/register?ref=CODE`), programme reward summary, and stats (`total`, `pending`, `approved`, `credited`, `approvedRewardMinor`, `creditedRewardMinor`, `currency`). Throws `NOT_FOUND` when `feature.referrals` is off. |
| `referrals.me.history` | `protectedProcedure` (customer) | No | Cursor-paginated referral history for the signed-in customer. Privacy-preserving: returns `referralPublicId`, `referredAccountHint` (non-reversible masked customer reference such as `Customer ••••42`, never referred e-mail or legal name), `status`, `rewardAmountMinor`, `currency`, `attributedAt`, `qualifiedAt`, `reviewedAt`, `creditedAt`. |
| `referrals.me.sendInviteEmail` | `protectedProcedure` (`form_submission`, customer) | No | Sends `referrals.invite_friend` to `{ recipientEmail }`. Enforces per-customer and per-recipient durable rate limits, refuses self-referral, silently suppresses existing platform accounts without leaking existence. |
| `referrals.admin.getSettings` | `staffProcedure` + `referrals.read_all` | No | Reads `{ enabled, config }` + aggregate programme summary counts. |
| `referrals.admin.updateSettings` | `adminProcedure` + `referrals.manage` | **Yes** | Updates `enabled` (`feature.referrals`) and/or `referrals.program` config inside one audited transaction with live actor re-validation. |
| `referrals.admin.list` | `staffProcedure` + `referrals.read_all` | No | Cursor-paginated referrals with filters (`status`, `query` by code or `publicId`, `from`, `to`, `limit`). |
| `referrals.admin.ledger` | `staffProcedure` + `referrals.read_all` | No | Cursor-paginated immutable `referral_reward_ledger` entries (`referralPublicId`, `referrerCustomerRef`, `entryType`, `amountMinor`, `currency`, `payoutMethod`, `reference`, `createdAt`). |
| `referrals.admin.approve` | `adminProcedure` + `referrals.manage` | **Yes** | CAS-transitions `qualified_pending_approval -> approved`, appends `reward_approved` ledger entry, audits. |
| `referrals.admin.reject` | `adminProcedure` + `referrals.manage` | **Yes** | CAS-transitions `attributed \| qualified_pending_approval -> rejected` with required `reason` (`3..500` chars), audits. |
| `referrals.admin.markCredited` | `adminProcedure` + `referrals.manage` | **Yes** | CAS-transitions `approved -> credited` with `payoutMethod` (`"account_credit" \| "manual_payout"`), required `reference` (`2..160` chars), optional `note`, appends `credit_applied` ledger entry, audits. |
| `referrals.admin.export` | `adminProcedure` + `referrals.manage` | **Yes** | Bounded export (`csv` or `json`, up to 2,000 rows matching filters) with CSV formula-injection neutralization and durable audit `referrals.exported`. |

---

## 6. Operator & Help Documentation Paths

- Administrator guide chapter (for Package P index): `server/modules/referrals/ADMIN_GUIDE.md` — title: *"Referral Programme Administration"*
- Customer help article draft: `server/modules/referrals/HELP_ARTICLE.md` — title: *"Referring Colleagues to ReadyPackets"*
