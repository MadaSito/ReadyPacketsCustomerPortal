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
  exportable: true,                         // included in configuration export (default true)
});

export const SIEM_CLIENT_KEY = defineSecret({
  key: "siem.tls.client_key",
  owner: "siem",
  group: "observability",
  label: "TLS client private key",
  description: "PEM private key for mutual TLS.",
  schema: z.string().min(1).max(16384),     // validated before encryption; optional (default: 1..8192 chars)
});

export const SIEM_FORWARDING = defineFeatureFlag({
  flag: "siem.forwarding",                  // stored as setting key `feature.siem.forwarding`
  owner: "siem",
  label: "SIEM / syslog forwarding",
  description: "Forward audit events to configured receivers.",
});                                         // ALL flags default OFF; no way to declare a default-on flag

// At call time (inside methods, never at factory time if it needs I/O):
const size = await readSetting(deps.settings, SIEM_BATCH_SIZE);            // typed; falls back to default if unset/invalid
await writeSetting(deps.settings, SIEM_BATCH_SIZE, 200, tx);               // validated + audited
const pem = await readSecret(deps.settings, SIEM_CLIENT_KEY);              // server-side only; null if not configured
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
- Process-local read cache: 5 s TTL, invalidated on every local write.

`SETTING_GROUPS`: `general, presentation, security, identity, mail, integrations, observability, backup, jobs,
files, orders, engagement, compliance, portable, analytics`. Ask platform_engineer to add a group.

## 2. Service interface — `deps.services.platform: PlatformModule`

```ts
interface PlatformModule extends ModuleLifecycle {
  /** [impl] Throws DomainError(UNAVAILABLE, SCHEMA_BEHIND | SCHEMA_AHEAD | SCHEMA_UNKNOWN | SCHEMA_JOURNAL_UNREADABLE). */
  assertSchemaContract(): Promise<void>;
  /** [impl] Non-throwing variant for health/readyz: counts + last tag only. */
  schemaStatus(): Promise<SchemaStatus>;
  /** [impl] Aggregates ModuleLifecycle.health() of services.allModules, each bounded by a timeout (default 2 s). */
  healthReport(options?: { timeoutMs?: number }): Promise<HealthReport>;
  /** [impl] For /readyz: { ready, state } only — no component details. ready=false if db/schema/keys failing. */
  readiness(): Promise<{ ready: boolean; state: HealthState }>;
  /** [impl] Public first-run state. Never reveals counts or identities. */
  setupStatus(): Promise<{ administratorExists: boolean }>;
  /** [impl] Admin checklist with honest states pulled from module health + config. */
  setupChecklist(): Promise<SetupChecklistItem[]>;
  /** [impl] Public sign-in presentation (plain text only). */
  presentation(): Promise<PublicPresentation>;
}
type SchemaStatus = { state: "current" | "behind" | "ahead" | "unknown" | "unreadable"; releaseCount: number; appliedCount: number; lastReleaseTag: string | null };
type HealthReport = { state: HealthState; checkedAt: Date; components: ModuleHealth[] };
type SetupChecklistItem = { id: "admin_exists" | "mfa_enforced" | "canonical_origin" | "smtp" | "backups" | "siem" | "keys_distinct" | "schema";
  state: "complete" | "incomplete" | "not_configured" | "unknown"; summary: string };
```

`createFieldCrypto(config)` (server/security/fieldCrypto.ts) returns `PlatformFieldCrypto extends FieldCrypto` with
extra **[impl]** `keyIdOf(envelope)`, `needsReencryption(envelope)`, `reencrypt(envelope, aad)`,
`blindIndexCandidates(value, purpose)` (current + previous index key during a blind-index transition).

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
| `setupStatus` (query) | public | `{ administratorExists }` |
| `presentation` (query) | public | slides / supportText / announcement (plain text, allowlisted images) |
| `admin.settings.list` (query) | admin | declared settings by group; secrets as `{ configured, updatedAt }`; values + `version` for non-secrets |
| `admin.settings.update` (mutation) | admin + `platform.settings.manage` (step-up) | `{ key, value, expectedVersion }` → optimistic concurrency (`CONFLICT/VERSION_MISMATCH`) |
| `admin.settings.setSecret` (mutation) | admin + `platform.settings.manage` (step-up) | `{ key, value: string \| null, expectedVersion }`; response never echoes the value |
| `admin.features.list` / `admin.features.set` | admin / + step-up | flags default OFF |
| `admin.health` (query) | staff + `platform.health.read` | full HealthReport |
| `admin.setupChecklist` (query) | admin | |
| `admin.presentation.get` / `admin.presentation.update` | admin / + step-up | `expectedVersion` |
| `admin.presentation.images` (query) | admin | allowlisted + uploaded image ids |
| `admin.config.export` (mutation) | admin + `platform.settings.manage` (step-up) | `{ includeSecrets, passphrase? }` |
| `admin.config.importPreview` (mutation) | admin + step-up | dry-run diff, no writes |
| `admin.config.importApply` (mutation) | admin + step-up | `{ document, passphrase?, expectedPreviewDigest }` |

## 5. Raw HTTP routes

| Route | Guard | Notes |
| --- | --- | --- |
| `POST /api/platform/presentation/images` | admin + fresh step-up + CSRF | PNG/JPEG/WebP, ≤ 2 MiB, magic-byte checked, re-served with nosniff |
| `GET /api/platform/presentation/images/:publicId` | public | only images referenced by an allowlist entry or an upload; `Content-Security-Policy: default-src 'none'`, nosniff |

## 6. Audit events

`platform.setting.changed`, `platform.secret.changed`, `platform.feature.changed`, `platform.presentation.changed`,
`platform.presentation.image.uploaded`, `platform.config.exported`, `platform.config.import.previewed`,
`platform.config.imported`, `platform.config.import.refused`, `platform.schema.contract.refused`,
`platform.crypto.reencrypt.batch`. Attributes: `settingKey` (declared key — a fixed identifier, not user data),
`oldValue`/`newValue` only for booleans, numbers and short identifier-like strings; otherwise `valueChanged: true`.
Secrets: never any value; `configured: boolean` only.

## 7. Configuration and keys

- `loadConfig(env)` / `testConfig()` (server/config/env.ts) — strict, fail-closed. `diagnoseConfig(env)` returns
  `{ ok, issues: { variable, rule }[] }` (never values). Every variable is documented in `server/config/env.example`.
- CLIs: `tsx scripts/ops/keys/doctor.ts` (config doctor), `tsx scripts/ops/keys/generate.ts` (prints new keys once),
  re-encryption runbook in `scripts/ops/keys/RUNBOOK.md`.

## 8. Feature flags / settings declared by platform

See `server/modules/platform/settings.ts` (presentation slides, support text, announcement banner).
