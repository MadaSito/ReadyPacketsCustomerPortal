# Platform verification

Server tests use isolated MySQL databases created with `tests/helpers/testDb.ts`. The real settings store, presentation service, config transfer and re-encryptor are run against controlled audit, storage, identity and clock substitutes. Evidence markers: `automated-test`, `review` (code reading only), `not-verified`.

## Requirement and evidence

| Requirement | Case | Evidence |
| --- | --- | --- |
| Strict, fail-closed configuration. Errors name variables and rules, never values. Secret files are 0600, owner-only, with no symlinks and a 64 KiB maximum. Trusted proxies are numeric IP/CIDR only. The preview profile is refused on readypackets.com and its subdomains. | `server/config/env.test.ts` (22 cases) | `automated-test` |
| Field encryption: AES-256-GCM with a key id bound into the AAD. Tamper, wrong AAD and unknown key fail closed. Dual-read rotation, re-encryption, blind-index transition and token-hash verification. | `server/security/fieldCrypto.test.ts` (vectors, tamper, AAD swap, rotation) | `automated-test` |
| Settings registry: declared keys only; kind mismatch refused; Zod validation on write and read; secrets encrypted and never returned; flags default off; secrets not exportable by default | `settingsStore.example.test.ts`, `router.example.test.ts` ("secrets never come back") | `automated-test` |
| Optimistic concurrency, plus audit in the same transaction (audit failure ⇒ no write) | `settingsStore.example.test.ts` (VERSION_MISMATCH, audit-failure rollback), `router.example.test.ts` (CONFLICT) | `automated-test` |
| The actor is re-validated inside the transaction (team rule 2): a demoted, revoked or stale-step-up actor, or a missing identity service, writes nothing. Locks are taken in a fixed order: users → sessions → settings → images. | `actorGuard.example.test.ts` | `automated-test`; lock-order deadlock freedom is `review` |
| No second pool connection inside a transaction (team rule 1). Settings reads take `tx`, and storage I/O happens before the transaction. | `settingsStore.example.test.ts` (tx reads bypass cache), `presentation.example.test.ts` (upload) | `automated-test` for behavior; absence of other pool use is `review` |
| Router authorization: anonymous → UNAUTHORIZED; customer, staff and remediation sessions → FORBIDDEN; admin without fresh step-up → STEP_UP_REQUIRED on every mutation; strict input (extra keys, bad keys, markup, undeclared) → BAD_REQUEST; public procedures return safe fields only | `router.example.test.ts` (6 cases) | `automated-test` |
| Image upload: magic-byte type check for PNG, JPEG and WebP; size and dimension bounds; metadata stripped (EXIF/GPS, text chunks, ICC in WebP, trailing data); full JPEG marker walk; single-frame WebP. SVG, HTML and GIF are refused. | `presentation.example.test.ts` (validation cases incl. progressive JPEG) | `automated-test` |
| Upload transaction: guard, slides lock, quota under lock, insert and audit. On audit failure no row and no object remain. On an ambiguous (non-domain) error the object is kept rather than risking a referenced-but-missing image. | `presentation.example.test.ts` ("audit write fails", "ambiguous outcome") | `automated-test` |
| Image deletion (team rule 3): audit written before the soft delete in the same transaction; IMAGE_IN_USE refused; post-commit GC oldest-first with an `object_purged_at` marker and retry | `presentation.example.test.ts` ("references uploads…", "garbage-collects…") | `automated-test` |
| Config export/import: digest-bound preview/apply; HMAC with a passphrase or checksum without one; secrets only in authenticated encrypted documents; one scrypt derivation per operation; bounded KDF concurrency (KDF_BUSY); sorted keys; audit for each step | `configTransfer.example.test.ts` | `automated-test`; the KDF_BUSY queue limit is `review` only |
| Re-encryption: one transaction per batch holding the checkpoint FOR UPDATE; CAS writes; monotonic checkpoint; audit in the transaction; resumable; audited reset | `reencrypt.example.test.ts` | `automated-test` |
| Schema contract, health aggregation (timeouts, sanitized peer reports), readiness from platform components only, setupStatus failing closed, setup checklist | `module.example.test.ts` | `automated-test` |
| Key tooling: generated keys are distinct and accepted by the loader; 0600/0700 files that are never overwritten; output prints paths only; rotate/retire safety; doctor output never includes values | `scripts/ops/keys/lib.test.ts` | `automated-test` |
| Preview profile needs `RP_PREVIEW_ACKNOWLEDGED=synthetic-data-only` (all NODE_ENVs); refusal on readypackets.com kept; one startup WARN; `preview` on public payloads | `env.test.ts` (ack cases), `module.example.test.ts` ("flags the preview profile…") | `automated-test` |
| Admin console UI: lazy admin/staff routes; settings (secrets shown only as Configured, write-only secret dialog, client validation, expectedVersion); features (default off, toggle); health (state as text + tone); setup checklist; sign-in page editor (slides with required alt text, images, upload after step-up); config export/import with preview, an authenticity warning and type-to-confirm apply; loading, empty and error states | `client/src/features/platform/platform.test.tsx` (11 cases, axe on every page family) | `automated-test` in jsdom; real-browser responsive layout (320–1920 px) and screen-reader use are `not-verified` |

## Not done / not verified

- UI: the raw image upload and the export download (Blob URL) are not covered by automated tests, and the UI has not been tested in a real browser.
- Images get no full decode/re-encode, so there is no malware or polyglot scan beyond the structural checks. Hardening target: a sandboxed decoder.
- The concurrent upload-quota race is protected by `FOR UPDATE` on the slides row, but no test runs it under real concurrency.
- The settings cache is per process, so other nodes may read a value up to 5 s stale. Readers that need consistency pass `tx`.
- There is no re-encryption CLI and no central target registry. Owners construct `ReencryptTarget`s, and the RUNBOOK lists the AAD inventory gathered from source.
- No GC sweep job is registered with the jobs module. `purgeDeletedImageObjects` runs after each delete and can be scheduled.
- The config-transfer format v1 has never shipped and uses a single salt from the start (secrets `kdf.salt` = integrity salt). There are no older dual-salt documents, so no compatibility path exists.

## Decisions for the architecture record

- Field-crypto AAD binds the key id (`rpenc:v1:<keyId>:<aad>`) as well as table, column and row, so envelopes cannot be moved or have their key id swapped.
- Settings are declared in code (a registry with owner, group, Zod schema and sensitivity). The database stores only values. Undeclared keys are refused.
- Secrets are never readable over the API. Export of secrets is opt-in per secret (`exportable: false` by default) and requires a passphrase.
- An export without a passphrase is checksum-only (integrity against accidents, not authenticity). This is labelled in the UI/API.
- One scrypt derivation per operation, with bounded concurrency to prevent CPU exhaustion through import/export.
- Privileged mutations re-validate the actor inside the transaction under row locks, in a fixed lock order.
- Readiness depends only on platform's own critical components. Peer modules affect health, not readiness.
- `setupStatus` fails closed (`administratorExists: true` when unknown), so the first-run flow cannot be reopened by an outage.
- Uploaded images have their metadata stripped and are served from a separate path with `default-src 'none'` and nosniff. Object GC happens only after a definitive transaction outcome.

## Increment 03, package A: settings forms

| Check | Evidence |
|---|---|
| Field descriptions derived from Zod (scalars, enums/literal unions, bounds, required/optional/nullable, defaults, nested objects, arrays of scalars; everything else "unsupported" so JSON only) | `settingFields.test.ts` |
| Secrets never get a description; `fields` paths, `writeCapability` and `managedBy` href are validated at declaration (console paths only) | `settingFields.test.ts` |
| Generic update / setSecret / import also re-validate each declared `writeCapability` inside the transaction (fresh step-up where required) | `router.ts` `settingWriteGuard` (code review; DB example tests unchanged) |
| Edit dialog: Form tab by default, JSON tab on the same value, client pre-checks, server `details.fields` mapped onto fields (`aria-invalid`), axe clean | `client/src/features/platform/platform.test.tsx`, `fieldForm.test.ts` |
| Settings page: search (live count for screen readers), collapsible groups (disclosure buttons with `aria-expanded`), link-out rows for E-mail delivery / Storage / SharePoint sync / Single sign-on, axe clean | `platform.test.tsx` |
| Not run here: browser checks at 320 px and keyboard walkthrough (no browser in this sandbox); the layout is single-column below `sm` and uses kit controls |  |
