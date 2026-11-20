# portable — verification evidence

All tests are synthetic (`*.example.test`, invented values) and run with
`scripts/dev/test.sh portable/tests` (101 tests across 7 files, about 20 s on the shared sandbox). Type check:
`scripts/dev/tc.sh portable`; lint: `scripts/dev/lint.sh portable`. Evidence class: **T** = automated test,
**S** = static or design argument only (not executed).

| Requirement | Evidence | Where |
| --- | --- | --- |
| Round trip: write → open → verify → iterate records/objects | T | `tests/roundtrip.test.ts` |
| Records refused before verify (`NOT_VERIFIED`) | T | roundtrip, legacy |
| Deterministic output, TZ independent | T | roundtrip (two writes, different `TZ`), `tests/golden.test.ts` (byte-identical rebuild) |
| Multi-chunk streaming (300 records, 1 KiB chunks) | T | roundtrip |
| Writer input validation (schema, dup ids, unresolved refs, object hash/size) | T | roundtrip |
| Default KDF parameters recorded in header (N=2^17,r=8,p=1) | T | roundtrip |
| Tamper: magic, header length, header JSON, salt, header MAC | T | `tests/tamper.test.ts` |
| Tamper: ciphertext byte in first/middle/last chunk, GCM tag, chunk length field | T | tamper |
| Reorder / duplicate chunks; drop final chunk; mid-chunk / mid-header / empty truncation; trailing data | T | tamper |
| Wrong passphrase → `PASSPHRASE_REJECTED` | T | tamper, legacy, cli |
| KDF parameters per-value and aggregate (memory/work) ceilings before derivation | T | tamper |
| Tampering detected before any record is parsed | T + S | tamper (failures occur in `openPackage`, which only parses after all chunks authenticated — see `reader.ts`) |
| `ciphertextSha256` equals the hash of the authenticated bytes (single pass) | T | tamper |
| Symlink input refused, relative path refused | T | tamper |
| Content tamper by passphrase holder: record/object/manifest count/content digest/dropped line/missing+extra entries/dup ids/dangling refs/packageId mismatch | T | tamper (re-sealed archives) |
| Zip: traversal, absolute, backslash, drive letter, embedded `..`, non-allowlisted names | T | `tests/archive-exclusions.test.ts` |
| Zip: symlink entries, directory entries, duplicate entries | T | archive-exclusions |
| Zip bomb (20 MiB → ratio > 200) refused before inflating | T | archive-exclusions |
| Entry count / total size / object size limits | T | archive-exclusions |
| Declared vs actual size mismatch never verifies | T | archive-exclusions (accepts either refusal or failed report) |
| Hard exclusions: writer refuses 12 key families at top level and in `heldUnknown`; 5 value shapes; no value leakage in errors | T | archive-exclusions |
| Verifier fails a crafted package containing an argon2 hash in `heldUnknown`, without echoing it | T | archive-exclusions |
| Newer minor: unknown fields → `heldUnknown`, manifest additions reported | T | `tests/cli-policy.test.ts` |
| Same minor strict; unsupported major / too-new minReaderVersion refused | T | cli-policy |
| Required unknown module/extension fails; optional held inert; duplicate/non-canonical inventory refused; deep extension fails closed | T | cli-policy |
| CLI exit codes 0/1/2/3/4/5, `--json`, env/file passphrase only | T | cli-policy (in-process `runCli`) |
| CLI extract: new dir only, verbatim bytes match manifest digests, refuses unverified | T | cli-policy |
| Reference importer: deterministic plan, `UNKNOWN_ENUM` refusal, refuses unverified | T | cli-policy |
| Legacy v2 upgrade: losses, held-unknown, sanitized names (original kept inert), lock/createdAt null, object bytes | T | `tests/legacy.test.ts` |
| Legacy ids stable across re-exports (different `generatedAt`) | T | legacy |
| Legacy forged packageId, bad file hash, invalid shape, wrong passphrase, tampered ciphertext, envelope/AAD mismatch | T | legacy |
| Legacy caller limits enforced before decode, and over the expanded result (derived records, metadata-only) | T | legacy |
| Legacy v1 single-record scope | T | legacy |
| JSON Schemas + RECORDS.md current with Zod; record schemas closed | T | golden |
| No `server/**` imports in `portable/**` | S | `rg "server/" portable/src portable/cli portable/reference-importer` returns no matches (checked at commit time); not enforced by a lint rule |

## Not verified / limitations (stated plainly)

- **No asymmetric signature.** Authenticity = possession of the passphrase. A passphrase holder can forge a
  valid package; the CLI report says so.
- `packageId` (a ULID, which encodes creation time) is in the clear header.
- The decrypted archive is spooled to disk (0700 dir / 0600 file) for the lifetime of the open package;
  a crash can leave it behind in the temp dir. Not encrypted at rest.
- Legacy fixtures are **synthesized** from the source algorithm in `ReadyPackets-SiteSplit-main`; no file
  produced by the old system was available or tested.
- Strict schemas reject unknown **nested** keys even in newer-minor packages (only top-level record keys are
  held). Contract 3.x minors must therefore only add top-level fields.
- Multi-part / aggregate packages (manifest spanning several files) are not implemented.
- The writer emits no extensions (readers accept them).
- Performance at the default limits (multi-GiB packages, 1 M records) is not measured; tests use small data.
- Memory: legacy packages are read fully into memory (≤ 192 MiB by default) — inherent to the v1/v2 format.
- The reference importer is an example mapping (no writes); it refuses every record type outside core CRM
  entities, so an `all-core` package yields `applicable: false` by design.
- Exclusion detection is pattern-based: a secret stored under an innocuous key with a non-matching shape
  would not be detected. The primary control is that producers only map allow-listed fields.
