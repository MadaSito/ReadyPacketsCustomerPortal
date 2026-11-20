# Audit, logging and audit center — verification

Run with `source scripts/dev/env.sh` then `scripts/dev/test.sh server/modules/audit`,
`scripts/dev/test.sh server/observability` and `scripts/dev/test.sh client/src/features/audit`. MySQL suites
create and drop an isolated database; all identities and values are synthetic (`*.example.test`).

Evidence classes: **AT** = automated test (real MySQL where noted), **RV** = code review only, **NV** = not verified.

## Requirement → evidence

| Requirement | Evidence | Class |
| --- | --- | --- |
| Structured OTel-aligned JSON logs with request/trace/span/correlation ids | `observability/redact.test.ts` › createLogger, reserved keys | AT |
| Secrets/PII never logged (key + value redaction: JWT, PEM, bearer/basic, URL creds, kv secrets, rpenc envelopes, e-mail, Luhn PAN, long tokens) | `redact.test.ts` › redaction corpus (11 cases + negatives) | AT |
| Log injection (CR/LF/U+2028/ESC) and correlation-field forging | `redact.test.ts` › log injection | AT |
| Bounded redaction (depth/keys/arrays/cycles/getters), oversized lines capped not split, logger never throws | `redact.test.ts` | AT |
| Error messages/stacks only in non-production debug, still scanned | `redact.test.ts` › errors | AT |
| Canonical envelope, encrypted source IP, actor pseudonym, unsafe attributes dropped, malformed names rejected | `emitter.test.ts` | AT (MySQL) |
| Durable audit fails closed and rolls back the business write in the same tx | `emitter.test.ts` › in-tx rollback; fail-closed by renaming `audit_events` | AT (MySQL) |
| Best-effort notes bounded; drops recorded durably | `emitter.test.ts` › notes | AT (MySQL) |
| Hash chain: modification, JSON modification, deletion, seq gap, reorder, forged link, tail truncation (head + signed checkpoint), checkpoint signature tamper, out-of-order commit | `chain.test.ts` (11) | AT (MySQL) |
| Pruned events verify only with a keyed tombstone receipt (DB-only actor cannot mask deletion) | `module.test.ts` › tombstone receipts are keyed | AT (MySQL) |
| Chain key identity bound; append/checkpoint refused under another key | `module.test.ts` › refuses to extend a chain under a different key | AT (MySQL) |
| Search newest-first, self-audited, correlation filter (`?correlationId=` deep link backend) | `module.test.ts` › search | AT (MySQL) |
| Cursor stability with concurrent inserts | `module.test.ts` › cursor pagination | AT (MySQL) |
| Query SQLi: hostile values rejected by per-field grammar or bound; unknown fields rejected | `module.test.ts` › binds hostile values; rejects unknown fields | AT (MySQL) |
| Query limits: depth 3, 30 terms, `in` 25, 400-day window, 5000-deep payload rejected without recursion | `module.test.ts` › rejects … without recursion blow-ups | AT |
| AuthZ re-checked in service: customer, staff, remediation, stale and future step-up | `module.test.ts` › authorization | AT |
| Actor re-validated inside the mutation tx (disabled/demoted admin refused) | `module.test.ts` › re-validates the actor | AT (MySQL) |
| Exports: job → private storage, pinned snapshot (head seq + cutoff) in manifest, requester-only, durable attempted before bytes, truthful result after | `module.test.ts` › exports | AT (MySQL) |
| Export job re-derives requester standing (cancels if no longer active admin); per-user cap | `module.test.ts` › exports | AT (MySQL) |
| Export escaping: CSV formula (incl. full-width, leading space/NBSP), RFC 4180; CEF header/extension; JSONL U+2028/2029 | `formats.test.ts` (18) | AT |
| Retention: only sealed + past cutoff; legal hold and open-case events kept; dry-run; per-batch durable audit in the delete tx; chain verifies with `pruned` | `module.test.ts` › retention | AT (MySQL) |
| Cases (encrypted notes, closed-case attach refused), saved queries owner-scoped | `module.test.ts` › cases and saved queries | AT (MySQL) |
| Manual checkpoint step-up gated, signed + audited in one tx | `module.test.ts` › manual checkpoint | AT (MySQL) |
| Health components | `module.test.ts` › health | AT (MySQL) |
| Retention gate serialises hold create / case attach / reopen against deletion | lock design in `retention.ts` (`lockGate`) | RV — no concurrent two-connection race test |
| tRPC router wiring and raw download route (`router.ts`, `http.ts`) | typecheck only | RV |
| Export job fencing (`assertStillOwned(tx)` at every transition) | code; FakeJobs fence is a no-op | RV |
| UI query model: bounded window, quick filters ANDed, ID search ORed across id fields by shape, advanced AND/OR group, `in` splitting, malformed ID refused client-side | `client/src/features/audit/audit.test.tsx` › audit query model, rejects malformed IDs | AT (jsdom) |
| UI deep links: `?correlationId=` and `?saved=<id>` honoured under hash routing; saved query applied verbatim; return to filters | `audit.test.tsx` › audit center page | AT (jsdom) |
| UI event list loading/empty/error states, stacked mobile cards, drawer with pivots and seal state; source address shown only after explicit reveal | `audit.test.tsx` › audit presentational parts | AT (jsdom + axe) |
| UI integrity summary shows break reason + first break seq; "sealing is behind" warning | `audit.test.tsx` › integrity summary | AT (jsdom + axe) |
| UI exports: download only for completed/unexpired; `sessionFetch` with `no-store`; refuses non-attachment or size ≠ manifest | `audit.test.tsx` › exports | AT (jsdom + axe) |
| UI retention: real run needs typed `REMOVE`, runs under step-up wrapper; saved searches/cases/retention views axe-clean | `audit.test.tsx` › retention, saved searches | AT (jsdom + axe) |
| UI export download retry after HTTP `STEP_UP_REQUIRED` (403 JSON `safe.domainCode`) | code in `ExportsPage.tsx` | RV — not tested (step-up dialog not driven) |

## Known limitations (not done / not verified)

- **Symmetric chain key on the host.** HMAC links and Ed25519 checkpoint seed are derived from `AUDIT_CHAIN_KEY`.
  An attacker with both DB write access AND the host secret can rewrite history; checkpoints only help when
  exported off-host (SIEM forwarding / export manifests). Key rotation is not implemented (mismatch fails closed).
- **No DB-level append-only enforcement.** Recommended grants for the runtime account:
  `GRANT SELECT, INSERT ON audit_events TO app; GRANT SELECT, INSERT ON audit_chain, audit_checkpoints, audit_tombstones TO app;`
  with a separate retention account holding `DELETE ON audit_events`. Not applied by migrations.
- **Sealing horizon.** Transactions open longer than 15 minutes can commit events below the scan watermark; the
  daily full-scan sweep seals them, and verify reports `unsealedOlderThanHorizon`.
- **No `MAX_EXECUTION_TIME`** on search/stats queries; attribute (JSON) filters are unindexed and scan the time window.
- **Field allowlisting is pattern-based, not per-event typed.** Attributes pass a denylist of secret/PII shapes
  plus a short-string charset; external projections copy all attributes. A per-event field registry with an
  external allowlist is an open ADR item.
- Session revocation is not re-checked inside mutation transactions (role/status are).
- Concurrency of verify vs. sealing is bounded to the sampled head (statement-level reads, not one snapshot).
- UI: jsdom + axe tests only; no browser layout, screen-reader or 320–1920 px visual verification (NV).
