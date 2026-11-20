# ReadyPackets portable package — contract v3.0

Status: normative for `readypackets.portable-contract` 3.0, package format `readypackets.portable-package`
formatVersion 3, envelope `readypackets.portable-envelope` version 1. The Zod schemas in
`portable/src/contract/` are the source of truth; `portable/schemas/v3/*.json` (JSON Schema 2020-12) and
[`RECORDS.md`](RECORDS.md) are generated from them and checked by `portable/tests/golden.test.ts`.

A third party can read and verify a package with only `portable/**`, Node.js built-ins, `zod`, `yazl` and
`yauzl`. Nothing in `portable/**` imports the ReadyPackets server.

## 1. Layers

```
file.rpkg = envelope( zip( manifest.json, records/*.jsonl, extensions/*.jsonl, objects/<sha256> ) )
```

Encryption is mandatory; there is no plaintext package mode. Readers authenticate and decrypt every byte to a
private spool (directory mode 0700, file mode 0600) **before** any archive member, manifest or record is
parsed. Tampering with any ciphertext byte therefore fails at open time.

## 2. Envelope (byte layout)

| offset | size | content |
| --- | --- | --- |
| 0 | 8 | magic `RPPKG3\r\n` |
| 8 | 4 | `hlen`, uint32 big-endian, 64..4096 |
| 12 | hlen | header: canonical JSON (sorted keys, no whitespace), UTF-8 |
| 12+hlen | 32 | HMAC-SHA256(macKey, bytes 0..12+hlen) |
| … | | chunks until end of file |

Header fields: `format` = `readypackets.portable-envelope`, `envelopeVersion` = 1, `cipher` = `AES-256-GCM`,
`kdf` = `{name:"scrypt", N, r, p, keyLength:32, salt}` (salt = 32 random bytes, base64url without padding),
`hkdf` = `HKDF-SHA256`, `chunkSize` (1 KiB..1 MiB plaintext, default 64 KiB), `packageId` (ULID). Unknown
header keys or a non-canonical encoding are rejected (`HEADER_INVALID`).

Keys: `master = scrypt(NFC(passphrase) as UTF-8, salt, 32, N, r, p)`;
`encKey = HKDF-SHA256(master, salt, "readypackets portable v3 chunk key", 32)`;
`macKey = HKDF-SHA256(master, salt, "readypackets portable v3 header mac", 32)`. Passphrases are 12..1024 bytes.

KDF parameters come from the (not yet authenticated) header, so readers check them before deriving:
N is a power of two with 2^14 ≤ N ≤ 2^20, 1 ≤ r ≤ 16, 1 ≤ p ≤ 4, **and** aggregate memory 128·N·r·p ≤ 256 MiB
and work N·r·p ≤ 2^21 (`KDF_PARAMS_REJECTED`). Writer default: N = 2^17, r = 8, p = 1 (128 MiB).
Operators may raise reader ceilings only through explicit `limits`.

Header MAC: compared in constant time. A wrong passphrase and a modified header are indistinguishable
(`PASSPHRASE_REJECTED`) by design.

Chunk `i` (from 0): `uint32 BE L` ‖ `L` bytes ciphertext ‖ 16-byte GCM tag; L ≤ chunkSize.
`nonce = 0x00000000 ‖ uint64 BE i`; `AAD = SHA-256(bytes 0..12+hlen) ‖ uint64 BE i ‖ final` where `final` is
one byte, 1 only for the last chunk. A fresh random salt per package makes keys unique per package, so
counter nonces never repeat under a key. Detection: modified bytes or reordered/duplicated chunks →
`CHUNK_AUTH_FAILED`; missing final chunk or cut file → `TRUNCATED`; bytes after the final chunk →
`TRAILING_DATA`. The reported `ciphertextSha256` is computed over exactly the bytes authenticated in that
same pass.

## 3. Archive

Plain ZIP produced deterministically: fixed DOS timestamp 1980-01-01 00:00, mode 0100644, `manifest.json` and
`records/*`/`extensions/*` deflated, `objects/*` stored, entries in fixed order (manifest, record types in
`RECORD_TYPE_ORDER`, objects by sha256). The 3.0 writer emits no extensions; readers accept them (§6). Identical inputs + identical randomness ⇒
identical bytes (golden fixture).

Readers enforce, before inflating any entry:

- name allowlist `^(manifest\.json|records/[a-z-]{1,40}\.jsonl|extensions/[a-z0-9-]{1,64}\.jsonl|objects/[a-f0-9]{64})$`
  — no traversal, absolute paths, backslashes, drive letters, directories (`ENTRY_NAME_REJECTED`);
- no symlinks/special files (unix mode), no directory entries, no encrypted members, methods 0/8 only
  (`ARCHIVE_INVALID`); no duplicate names (`DUPLICATE_ENTRY`);
- entry count, per-entry and total uncompressed size limits (`ENTRY_LIMIT`, `SIZE_LIMIT`); compression ratio
  ≤ 200 for entries over 1 MiB (`RATIO_LIMIT`); declared sizes validated against actual inflated sizes.

## 4. Manifest (`manifest.json`)

Canonical JSON (sorted keys) + `\n`; a same-minor manifest that is not canonical is rejected.

| field | meaning |
| --- | --- |
| `format`, `formatVersion` | `readypackets.portable-package`, 3 |
| `contract` | `{name:"readypackets.portable-contract", version:"3.0"}` |
| `compatibility` | `{minReaderVersion, requiredModules[]}` — reader refuses if it cannot meet them |
| `packageId` | ULID; must equal the envelope header `packageId` |
| `exportId` | opaque producer operation id or null |
| `producer` | `{name, version}` |
| `sourceSystem.pseudonym` | non-identifying source label (no hostnames) |
| `sourceRelease`, `generatedAt` | producer release; RFC 3339 UTC |
| `snapshot` | `{kind: repeatable-read \| point-in-time \| none, takenAt, identity}` |
| `scope` | `{profile, description, selection:{mode: fixed \| dynamic-all, count} \| null}`; profiles: `customer-only`, `complete-order-with-files`, `selected-files`, `all-core`, `custom` |
| `modules` | contract modules present: `core`, `engagement`, `compliance`, `billing` |
| `records[]` | `{type, file: records/<type>.jsonl, count, bytes, sha256}` — one per type, unique |
| `objects[]` | `{sha256, size}` sorted, unique |
| `extensions[]` | `{name, version, required, file: extensions/<name>.jsonl, count, bytes, sha256}` — unique |
| `dependencyClosure.external[]` | references intentionally outside the package (e.g. selected-files → order) |
| `exclusions[]` | declared exclusions; always includes every hard exclusion (§7) |
| `limitations[]` | free-text producer limitations |
| `contentDigest` | SHA-256 of canonical JSON `{records:[{type,sha256,count,bytes}], objects:[{sha256,size}], extensions:[{name,sha256,count,bytes}]}` — recomputed by readers from what they hashed |

## 5. Records

One JSON object per line (`\n`), UTF-8, ≤ 1 MiB per line, nesting depth ≤ 32. Field dictionaries:
[`RECORDS.md`](RECORDS.md). Record types, in dependency order: customers, orders, order-items,
order-status-history, order-shares, files, file-versions, message-threads, messages, tickets,
ticket-comments, policy-versions, policy-acceptances, intake-definitions, intake-submissions, invoices,
payments, refunds, provenance.

- `publicId`: ULID, stable across exports of the same source record, unique in the package (`DUPLICATE_ID`).
- References: `<x>PublicId` fields; each must resolve inside the package or be listed in
  `dependencyClosure.external` (`REFERENCE_UNRESOLVED`).
- Money: `{amountMinor: integer, currency: ISO-4217 upper-case}`. Times: RFC 3339 UTC with `Z`,
  calendar-validated.
- Enumerations (`status`, `paymentStatus`, `category`, …) are lower-case tokens, **open** at contract level.
  Importers must refuse values they do not know instead of mapping them (the reference importer does).
- Objects are referenced only by `file-versions.objectSha256`; file names inside records are display
  metadata, never paths. `mediaType` is untrusted declared metadata.

## 6. Unknown-field and compatibility policy

- Same major, same minor: schemas are strict; any unknown key fails (`RECORD_INVALID`, `MANIFEST_INVALID`).
- Same major, newer minor: unknown top-level record keys are moved into `heldUnknown` (name collisions are
  prefixed `contract:`); the count appears in the report (`heldUnknown`) and a `NEWER_MINOR_VERSION` warning
  is raised. Unknown manifest top-level keys are reported by name in `NEWER_MINOR_MANIFEST_FIELDS`. Unknown
  keys nested inside known objects still fail (strict) — a known limitation of 3.0.
- `compatibility.minReaderVersion` newer than the reader, or another major → `UNSUPPORTED_CONTRACT`.
- Required unknown module or extension → `UNSUPPORTED_EXTENSION` (package fails). Optional unknown
  extensions are hash-checked, exclusion-scanned (fail closed beyond depth 32) and exposed only as inert
  lines via `heldExtension(name)`.
- `heldUnknown` is preserved byte-for-byte as JSON (≤ 16 KiB per record) and is never interpreted.
  Nothing is silently dropped.

## 7. Hard exclusions

Never in a package: password hashes, MFA secrets, recovery codes, sessions, tokens (reset, verification,
API, refresh, JWT), SAML bindings, provider secrets/credentials, encryption keys, original storage keys,
audit-chain keys. The writer refuses (`EXCLUDED_FIELD`) and the verifier fails a package when, at any depth
(including `heldUnknown`, extensions and the manifest):

- a key, normalized to lower-case alphanumerics, contains `password`, `passwd`, `passphrase`, `secret`,
  `token`, `totp`, `hotp`, `otpauth`, `mfaseed`, `mfakey`, `recoverycode`, `backupcode`, `sessionid`,
  `sessionkey`, `saml`, `apikey`, `privatekey`, `encryptionkey`, `storagekey`, `objectkey`, `chainkey`,
  `hmackey`, `signingkey`, `credential`, `keymaterial`, `webauthn`, `passkey`, or equals `session(s)`,
  `cookie(s)`, `dek`, `kek`, `jwt`, `salt`, `pin`;
- a string value looks like a PEM private key, an argon2/bcrypt/scrypt/pbkdf2 hash, an `otpauth://` URI or
  a JWT;
- a branch is nested too deeply to scan (treated as a hit, never skipped).

Errors and reports name only the record type and a sanitized key path, never the value.

## 8. Legacy v1/v2 (`.rptransfer`) adapters

Shapes and algorithm derived from `ReadyPackets-SiteSplit-main/scripts/portableDataTransfer.ts` and
`portableTransferBatch.ts`: one-line JSON envelope `{format, kdf:"scrypt", salt(16B), iv(12B), tag, ciphertext}`
(base64url), scrypt N=2^15 r=8 p=1 → 32-byte key, AES-256-GCM over the whole payload, AAD = payload format
string; payload `{format, sourceSystemRef, generatedAt, sourceRelease, scope, contents:{customers, orders,
files}, packageId}` with `packageId = SHA-256(JSON.stringify(payload without packageId))`.

The adapter upgrades in memory to v3 records and reports, in `report.losses`, everything the old formats did
not carry (billing evidence, legal acceptances, intake, messages, custom fields, file history, access
evidence, customer numbers/creation times, lock state, history actors) plus per-record transformations (file
name sanitization, media type generalization). Fields v3 does not model (`priceSource`, `manualPriceCents`,
`bundleApplied`, `integrityChoice`, `mndaAcceptedAt`, `intakeCompletedAt`, `phase2ScheduledAt`, original
unsafe file names, unknown keys) go to `heldUnknown`. Record ids are derived deterministically from
(source ref, record kind, legacy ref) with a fixed ULID time component (2020-01-01), so re-exports of the
same source records keep their ids. The legacy `packageId` digest — which the old system only checked for
shape — is recomputed (`DIGEST_MISMATCH`). Legacy fixtures in tests are synthesized from the source
algorithm, not produced by the old system.

## 9. Limits (defaults, `PortableLimits`)

package 4 GiB · entries 200 000 · records per type 1 000 000 · record line 1 MiB · object 1 GiB · total
uncompressed 8 GiB · compression ratio 200 · manifest 64 MiB · heldUnknown 16 KiB/record · extension 16 MiB ·
scrypt as §2 · legacy package 192 MiB.

## 10. Verifier CLI

```
tsx portable/cli/verify.ts verify  <pkg> (--passphrase-file F | --passphrase-env VAR) [--json]
tsx portable/cli/verify.ts extract <pkg> <new-dir> (--passphrase-file F | --passphrase-env VAR)
tsx portable/cli/verify.ts plan    <pkg> (--passphrase-file F | --passphrase-env VAR)
```

The passphrase is never accepted as an argument value. Exit codes: 0 verified · 1 verification failed
(including archive-structure and integrity failures) · 2 usage · 3 passphrase rejected or header altered ·
4 unsupported envelope/contract/KDF parameters or required module/extension · 5 local I/O error.
`extract` refuses existing directories and unverified packages; for v3 it writes the verified archive
entries verbatim plus `verification-report.json` and `extraction-info.json` (`mode: "verbatim"`); for
legacy it writes reconstructed records, `upgraded-manifest.json` and `mode: "reconstructed-from-legacy"`.
`plan` prints the reference importer's JSON plan (`planSha256` binds approvals to its exact content).

## 11. Trust statement

Integrity proves that the bytes are exactly what a holder of the passphrase sealed. It does not prove the
identity of the source organization: there is no asymmetric signature in 3.0. Anyone with the passphrase
can produce a valid package; importers must treat package content as untrusted input.

## 12. Test vector

`portable/fixtures/golden-v3.rpkg` (passphrase `correct horse battery staple 2026`, test KDF N=2^14) — see
`portable/fixtures/README.md`.
