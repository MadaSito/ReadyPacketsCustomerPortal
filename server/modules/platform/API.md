# Platform module API

Owner: platform_engineer. Paths: `server/config/**`, `server/security/fieldCrypto.ts`, `server/modules/platform/**`,
`client/src/features/platform/**`, `scripts/ops/keys/**`.

Status markers: **[impl]** implemented + tested, **[sig]** signature published, implementation in progress.

## 1. Declaring settings, secrets and feature flags (for every module owner)

Import from `server/modules/platform/index.js` (types and pure helpers only; no module instance needed):

```ts
import { z } from "zod";
import { defineSetting, defineSecret, defineFeatureFlag, readSetting, writeSetting, readSecret, isSecretConfigured } from "../platform/index.js";

// Put declarations in a module-level file of YOUR module, e.g. server/modules/siem/settings.ts.
// They register on import (once per process). Duplicate keys throw at import time.
export const SIEM_BATCH_SIZE = defineSetting({
  key: "siem.delivery.batch_size",          // ^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$, ≤ 96 chars, first segment = your module
  owner: "siem",
  group: "observability",                   // see SETTING_GROUPS
  label: "Delivery batch size",
  description: "Maximum events per delivery attempt.",
  schema: z.number().int().min(1).max(500), // explicit bounds required
  default: 100,
  sensitivity: "internal",                  // "public" (safe for unauthenticated pages) | "internal" (admins only)
  exportable: true,                         // included in configuration export (default true for settings)
});

export const SIEM_CLIENT_KEY = defineSecret({
  key: "siem.tls.client_key",
  owner: "siem",
  group: "observability",
  label: "TLS client private key",
  description: "PEM private key for mutual TLS.",
  schema: z.string().min(1).max(16384),     // validated before encryption; optional (default: 1..8192 chars)
  // exportable defaults to FALSE for secrets — opt in with exportable: true (encrypted export needs a passphrase)
});

export const SIEM_FORWARDING = defineFeatureFlag({
  flag: "siem.forwarding",                  // stored as setting key `feature.siem.forwarding`
  owner: "siem",
  label: "SIEM / syslog forwarding",
  description: "Forward audit events to configured receivers.",
});                                         // ALL flags default OFF; no way to declare a default-on flag

// At call time (inside methods, never at factory time if it needs I/O):
const size = await readSetting(deps.settings, SIEM_BATCH_SIZE, tx?);       // typed; default if unset/invalid; pass tx inside a transaction
await writeSetting(deps.settings, SIEM_BATCH_SIZE, 200, tx);               // validated + audited
const pem = await readSecret(deps.settings, SIEM_CLIENT_KEY, tx?);         // server-side only; null if not configured
const on  = await deps.settings.isFeatureEnabled("siem.forwarding");       // false unless an admin enabled it
```

These helpers work against the core `SettingsStore` interface, so they also work with `MemorySettings` in
`tests/helpers/fakes.ts`. Rules enforced by the real store:

- `set(key)` / `setSecret(key)` on an **undeclared** key is refused (`VALIDATION/UNKNOWN_SETTING`). Declare first.
- `set` on a secret key or `setSecret` on a value key is refused (`VALIDATION/SETTING_KIND_MISMATCH`).
- Values are validated with the declared Zod schema on write (`VALIDATION/INVALID_SETTING_VALUE`) and on read
  (an invalid stored value logs `platform.setting.invalid_stored_value` and returns the default).
- Secrets are AES-256-GCM encrypted (AAD `platform_settings.secret:<key>`); they are never returned by any
  tRPC procedure — the console only ever sees `configured: boolean` + `updatedAt`.
- A secret that cannot be decrypted (unknown/retired key, tamper) makes `getSecret` throw
  `DomainError(UNAVAILABLE, SECRET_UNREADABLE)` — fail closed, never `null`.
- Every change is audited durably (`platform.setting.changed` / `platform.secret.changed` /
  `platform.feature.changed`) in the same transaction as the write. Pass your `tx` if you write inside your
  own transaction; otherwise the store opens one. Audit failure ⇒ no write.
- Process-local read cache: 5 s TTL, invalidated on every local write (other processes may see a stale value for ≤ 5 s).
  Reads with `tx` bypass the cache and read inside the transaction (team rule: never a second pool connection in a tx).

`SETTING_GROUPS`: `general, presentation, security, identity, mail, integrations, observability, backup, jobs,
files, orders, engagement, compliance, portable, analytics, features`. Ask platform_engineer to add a group.

### 1a. Form descriptions, labels, write capability, owning page (increment 03, package A)

`defineSetting` accepts three optional extras (`defineSecret` accepts the last two):

```ts
fields?: Record<string, { label?: string; help?: string }>; // dot path into the value; "" = the value itself
writeCapability?: Capability;  // e.g. "mail.manage": generic writes ALSO need this, re-validated in-tx (+ fresh step-up if in STEP_UP_CAPABILITIES)
managedBy?: { href: string; label: string }; // "/admin/..." console path; the Settings page links there instead of editing
```

Every value setting's `SettingView` (from `platform.admin.settings.list`) carries `field?: SettingFieldDescription`,
derived from its Zod schema by `server/modules/platform/settingFields.ts` (`describeSchema`, pure, never throws;
input side, so `.default()` keys are `required: false`). Secrets and flags never carry one. Exact type:

```ts
type SettingFieldScalar = string | number | boolean;
interface FieldCommon { label: string; help?: string; required: boolean; nullable: boolean; default?: unknown }
type SettingFieldDescription = FieldCommon & (
  | { type: "boolean" }
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string; format?: string } // format: "email" | "uri" | …
  | { type: "number" | "integer"; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number }
  | { type: "enum"; options: Array<{ value: SettingFieldScalar; label: string }> }          // z.enum / literal unions
  | { type: "object"; fields: Array<SettingFieldDescription & { key: string }> }            // nested objects
  | { type: "array"; items: SettingFieldDescription; minItems?: number; maxItems?: number; uniqueItems?: boolean } // items: scalar | enum only
  | { type: "unsupported" }                                                                  // records, tuples, arrays of objects, mixed unions → JSON editor only
);
```

Labels default to the humanised property name (`retention_days` → "Retention days"); help defaults to the
schema's `.describe()` text. The form is a convenience only: writes are validated by the declared schema on the
server, and `INVALID_SETTING_VALUE` errors carry `details.fields` (dot paths, `_` = root) that the client maps
to form fields. `SettingView` also carries `managedBy` / `writeCapability` when declared. The form renderer
lives in `client/src/features/platform/SettingFieldsForm.tsx` (feature-local; ask ui_foundation to promote it
to `@/ui` if another feature needs it).

## 2. Service interface — `deps.services.platform: PlatformModule`

```ts
interface PlatformModule extends ModuleLifecycle {
  /** [impl] Throws DomainError(UNAVAILABLE, SCHEMA_BEHIND | SCHEMA_AHEAD | SCHEMA_UNKNOWN | SCHEMA_JOURNAL_UNREADABLE). */
  assertSchemaContract(): Promise<void>;
  /** [impl] Non-throwing variant for health/readyz: counts + last tag only. */
  schemaStatus(): Promise<SchemaStatus>;
  /** [impl] Aggregates ModuleLifecycle.health() of services.allModules, each bounded by a timeout (default 2 s). */
  healthReport(options?: { timeoutMs?: number }): Promise<HealthReport>;
  /** [impl] For /readyz: { ready, state } only. Uses ONLY platform's own components (database, schema, keys —
   *  all critical); peer modules never make the node unready. Cached 2 s. */
  readiness(): Promise<{ ready: boolean; state: HealthState }>;
  /** [impl] Public first-run state. Never reveals counts or identities. */
  setupStatus(): Promise<{ administratorExists: boolean; preview: boolean }>;
  /** [impl] Admin checklist with honest states pulled from module health + config. */
  setupChecklist(): Promise<SetupChecklistItem[]>;
  /** [impl] Public sign-in presentation (plain text only). */
  presentation(): Promise<PublicPresentation>;
}
type SchemaStatus = { state: "current" | "behind" | "ahead" | "unknown" | "unreadable"; releaseCount: number; appliedCount: number; lastReleaseTag: string | null };
type HealthReport = { state: HealthState; checkedAt: Date; components: ModuleHealth[] };
type SetupChecklistItem = { id: "admin_exists" | "mfa_enforced" | "canonical_origin" | "smtp" | "backups" | "siem" | "keys_distinct" | "schema";
  state: "complete" | "incomplete" | "not_configured" | "unknown"; summary: string; required: boolean };
type PublicPresentation = { preview: boolean; slides; supportText; announcement; slideshow: { autoAdvance: boolean; intervalSeconds: number } };
```

`createFieldCrypto(config)` (server/security/fieldCrypto.ts) returns `PlatformFieldCrypto extends FieldCrypto` with
extra **[impl]** `keyIdOf(envelope)`, `needsReencryption(envelope)`, `reencrypt(envelope, aad)`,
`blindIndexCandidates(value, purpose)` (current + previous index key during a blind-index transition).

### Internals for platform's own router/http (not for other modules)

- `actorGuard(principal, capability = "platform.settings.manage") → (tx) => Promise<void>` — runs FIRST inside every
  privileged mutation transaction: `identity.sessions.assertCurrent(principal, tx)` (locks users → sessions), then
  requires full session, role admin, step-up younger than `STEP_UP_MAX_AGE_MS`. Failure ⇒ `FORBIDDEN` with
  `ACTOR_UNVERIFIABLE | NO_FULL_SESSION | ROLE_NOT_PERMITTED | STEP_UP_REQUIRED`; nothing is written.
  Lock order: users → user_sessions → platform_settings → platform_presentation_images.
- `updateSetting(key, value, expectedVersion, guard)`, `presentationService.uploadImage(bytes, guard)`,
  `presentationService.deleteImage(id, guard)` (refused `IMAGE_IN_USE` while referenced; audit before soft delete),
  `presentationService.purgeDeletedImageObjects(limit ≤ 500)` (oldest first, `object_purged_at` success marker,
  retried next sweep; also runs bounded after each delete), `configTransfer().exportDocument(options, guard)` /
  `apply(raw, digest, guard, passphrase?)`.
- Config transfer KDF: scrypt, async, one derivation per operation, concurrency 1, queue 4; over the limit ⇒
  `RATE_LIMITED/KDF_BUSY`.

## 3. What platform needs from others (coded against these; tell me if you differ)

| Provider | Signature | Use |
| --- | --- | --- |
| identity | `hasActiveAdministrator(): Promise<boolean>` | setupStatus, checklist (missing method ⇒ `unknown`, setupStatus fails closed to `administratorExists: true`) |
| all modules | `health(): Promise<ModuleHealth[]>` | health page / readyz / checklist |
| jobs or integrations | health component `mail.smtp` (`not_configured` / `disabled` / `ok` …) | checklist "SMTP configured" |
| backup | health component with prefix `backup.` | checklist "backups configured" |
| siem | health component with prefix `siem.` | checklist "SIEM configured" |

## 4. tRPC procedures (`trpc.platform.*`)

| Procedure | Guard | Notes |
| --- | --- | --- |
| `setupStatus` (query) | public | `{ administratorExists, preview }` |
| `presentation` (query) | public | `preview`, slides, slideshow, supportText, announcement (plain text, allowlisted images) |
| `admin.settings.list` (query) | admin | declared settings by group; secrets as `{ configured, updatedAt }`; values + `version` for non-secrets |
| `admin.settings.update` (mutation) | admin + `platform.settings.manage` (step-up) | `{ key, value, expectedVersion }` → optimistic concurrency (`CONFLICT/VERSION_MISMATCH`) |
| `admin.settings.setSecret` (mutation) | admin + `platform.settings.manage` (step-up) | `{ key, value: string \| null, expectedVersion }`; response never echoes the value |
| `admin.features.list` / `admin.features.set` | admin / + step-up | flags default OFF |
| `admin.health` (query) | staff + `platform.health.read` | full HealthReport |
| `admin.setupChecklist` (query) | admin | |
| `admin.presentation.get` (query) | admin | `{ settings: SettingView[] (presentation group), images: PresentationImageSummary[] }`; edit values via `admin.settings.update` |
| `admin.presentation.deleteImage` (mutation) | admin + step-up | `{ id }`; `IMAGE_IN_USE` if referenced by slides |
| `admin.config.export` (mutation) | admin + `platform.settings.manage` (step-up) | `{ includeSecrets, passphrase? }` |
| `admin.config.importPreview` (mutation) | admin + step-up | dry-run diff, no writes |
| `admin.config.importApply` (mutation) | admin + step-up | `{ document, passphrase?, expectedPreviewDigest }` |

### Preview profile

`RP_DEPLOYMENT_PROFILE=preview` additionally requires `RP_PREVIEW_ACKNOWLEDGED=synthetic-data-only` (exact value, in every
NODE_ENV; otherwise `ConfigError` naming the variable) and is always refused on readypackets.com hosts and aliases.
Platform logs one WARN at startup (`init()`): "preview profile active: relaxed framing/CORS, in-memory session transport,
synthetic data only". `preview: true` on `setupStatus` and `presentation` tells shells to render a permanent
"Preview — synthetic data only" banner.

## 5. Raw HTTP routes

| Route | Guard | Notes |
| --- | --- | --- |
| `POST /api/platform/presentation/images` | admin + fresh step-up + CSRF | PNG/JPEG/WebP, ≤ 2 MiB, magic-byte checked, re-served with nosniff |
| `GET /api/platform/presentation/images/:publicId` | public | only images referenced by an allowlist entry or an upload; `Content-Security-Policy: default-src 'none'`, nosniff |

## 6. Audit events

`platform.setting.changed`, `platform.secret.changed`, `platform.feature.changed`, `platform.presentation.changed`,
`platform.presentation.image.uploaded`, `platform.config.exported`, `platform.config.import.previewed`,
`platform.config.imported`, `platform.config.import.refused`, `platform.schema.contract.refused`,
`platform.crypto.reencrypt.batch`, `platform.crypto.reencrypt.reset`, `platform.presentation.image.deleted`,
`platform.presentation.image.refused`. Attributes: `settingKey` (declared key — a fixed identifier, not user data),
`oldValue`/`newValue` only for booleans, numbers and short identifier-like strings; otherwise `valueChanged: true`.
Secrets: never any value; `configured: boolean` only.

## 7. Configuration and keys

- `loadConfig(env)` / `testConfig()` (server/config/env.ts) — strict, fail-closed. `diagnoseConfig(env)` returns
  `{ ok, problems: { variable, rule, severity }[] }` (never values). Every variable is documented in `server/config/env.example`.
- CLIs: `tsx scripts/ops/keys/doctor.ts [--json]` (exit 0/78), `tsx scripts/ops/keys/generate.ts --out-dir DIR | --stdout`
  plus `--rotate-data-key` / `--retire-data-key ID`. Rotation, blind-index transition, AAD inventory and backup-key notes:
  `scripts/ops/keys/RUNBOOK.md`.
- Health component names emitted by platform: `platform.database`, `platform.schema`, `platform.keys` (critical for readiness), `platform.settings`.

## 8. Feature flags / settings declared by platform

See `server/modules/platform/settings.ts` (presentation slides, support text, announcement banner).

## 9. Increment 04, package J: cookie consent, privacy centre, public bootstrap

Status: ports published first; implementation follows in the same files.

### 9.1 Client ports (`client/src/lib`, platform-owned new files)

```ts
// @/lib/consent
export type ConsentCategory = "necessary" | "preferences" | "analytics" | "session_replay";
export interface ConsentChoices { preferences: boolean; analytics: boolean; session_replay: boolean }
export interface ConsentState {
  enabled: boolean;            // feature.privacy.consent is on (bootstrap); when false has() is false for all optional categories
  decided: boolean;            // a choice exists for the CURRENT policy version and is younger than renewMonths
  choices: ConsentChoices;     // all false until decided
  policyVersion: number | null;
  decidedAt: string | null;    // ISO
  gpc: boolean;                // navigator.globalPrivacyControl === true or doNotTrack === "1"
}
export const consent: {
  has(category: ConsentCategory): boolean;   // "necessary" is always true
  snapshot(): ConsentState;
  subscribe(listener: (state: ConsentState) => void): () => void; // fires on every change, incl. withdrawal
  openPreferences(): void;                    // opens the preference centre (footer link / account page)
};
export function useConsent(): ConsentState & { has: (c: ConsentCategory) => boolean; openPreferences: () => void };

// @/lib/features
export function useFeatureEnabled(flag: string): boolean; // false while loading, unknown or not clientVisible
export function useFeatureFlags(): (flag: string) => boolean; // one hook call for filtering many nav items
export function useBootstrap(): { features: Record<string, boolean>; consent: { enabled: boolean; policyVersion: number; renewMonths: number } } | undefined;
```

The choice itself lives in first-party `localStorage["rp.consent.v1"]` (strictly necessary: it stores the
choice; listed in the inventory). The preview build keeps it in memory only. Withdrawal removes the
`_clck`, `_clsk`, `CLID`, `ANONCHK`, `MR`, `MUID`, `SM` and `ph_*` cookies and `ph_*` / `_cl*` storage
entries that are readable from this origin. Third-party cookies on vendor domains cannot be removed by the
site; the preference centre says so.

### 9.2 Feature flags in the bootstrap

`defineFeatureFlag({ ..., clientVisible: true })` publishes the flag's on/off state (and nothing else) in
the public `platform.bootstrap` query, so `useFeatureEnabled("community")` can hide navigation. Flags
without `clientVisible` never appear. Hiding navigation is UX only; every procedure still checks the flag.

### 9.3 tRPC

| Procedure | Guard | Notes |
|---|---|---|
| `platform.bootstrap` (query) | public | `{ features, consent: { enabled, policyVersion, renewMonths } }`, cached 60 s client-side |
| `platform.consent.inventory` (query) | public | `{ policyVersion, renewMonths, categories[], items: CookieItem[] }`; items are plain text |
| `platform.consent.record` (mutation) | public, `rateLimit: "form_submission"` | input `{ receipt?, policyVersion, choices, action: "accept_all" \| "reject_all" \| "save" \| "withdraw", source: "banner" \| "preferences" \| "account" \| "gpc", gpc }`; returns `{ consentId, receipt, recordedAt, policyVersion }`. `receipt` is `<consentId>.<HMAC>` signed by the server; an unsigned or forged receipt is ignored (warn log) and a new id is issued, so a client cannot join another browser's history. The consent id is a grouping key only — never authority; `consent.mine` selects by the session user. Refused when the feature is off (`NOT_FOUND`/`CONSENT_DISABLED`), on a stale policy version (`CONFLICT`/`CONSENT_POLICY_CHANGED`) or inconsistent action/choices (`VALIDATION`). A full session attaches the user's public id. |
| `platform.consent.mine` (query) | authenticated (full session) | my last 200 decisions (download is client-side JSON of the same data) |
| `platform.admin.consent.stats` | admin + `privacy.consent.read` | counts by action, acceptance per category, by policy version, over `days` (1–400) |
| `platform.admin.consent.search` | admin + `privacy.consent.read` | filters `from,to,action,source,policyVersion,consentId,userPublicId,gpc`; cursor, limit ≤ 100 |
| `platform.admin.consent.export` | admin + `privacy.consent.read` | CSV of the same filters, ≤ 10 000 rows, audited `privacy.consent.exported` |

Inventory, policy version and renewal period are settings (group `privacy`, `writeCapability:
"privacy.consent.manage"`, `managedBy: /admin/privacy`) written through `platform.admin.settings.update`:
`privacy.cookie_inventory`, `privacy.consent.policy_version` (1–100000), `privacy.consent.renew_months` (6–13,
default 12). Flag `feature.privacy.consent` (clientVisible, off by default).

Ledger table `platform_consent_records` (schema.ts): consent id (random, 22 chars), user public id when
signed in, policy version, the three choices, action, source, GPC flag, keyed HMAC of the IP (never the IP),
time. No user agent and no IP in clear.

#### Client store additions (assurance review)
- `applyConsentDecision(choices, { policyVersion, receipt?, decidedAt?, bySignal? })`, `attachConsentReceipt(receipt)`, `consentReceipt()`, `removalsOnly(choices)`. Before the ledger call only `current ∩ requested` is applied (removals); the full choice, including any new grant, is applied after the server recorded it. With no previous decision, an all-off choice is applied first.
- The store re-checks on `storage` events (other tabs), `focus`/`visibilitychange`/`pageshow`, and a timer at the renewal deadline; `has()` never returns a cached grant past expiry. Withdrawal in any tab removes reachable vendor cookies/storage and notifies subscribers.

#### Retention (decided by /root)
- Setting `privacy.consent.retention_months` (12–72, default 36): a record is deleted that many months after it was superseded by a newer decision of the same browser, or after it expired (renewal period).
- Job `platform.consent.purge` every 6 h, batches of 1000, audits `privacy.consent.purged` with counts only.
- `ctx.services.platform` internals: `consent.forgetUser(userPublicId, tx?)` — account erasure unlinks the person (sets `userPublicId` null); the anonymous record stays until retention ends. Identity's erasure flow should call it.
