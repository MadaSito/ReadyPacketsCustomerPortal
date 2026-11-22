# ReadyPackets portal — threat model

Status: base draft 2026-11-20, with the increment 03 review scope in §10. Owner of this document: orders_engineer. Scope is the self-hosted
customer portal at `my.readypackets.com` in this repository. It is a design-and-source document. It is not a
penetration test, an OWASP certification or an ASVS attestation. Controls marked "tested" carry the evidence
class of their test (see `docs/verification/REQUIREMENTS_REGISTER.md`): unit tests, synthetic MySQL, loopback
sockets or jsdom. None of them proves deployed behaviour.

Inputs: `docs/source-specs/MASTER_PROMPT.md`, `ARCHITECTURE.md`, `docs/adr/0001–0012`, `docs/security/REVIEW-*.md`,
module `API.md`/`VERIFICATION.md` files and the test suites.

## 1. System context

```
               Internet
                  │  HTTPS (TLS 1.2+)                                   [B1]
          ┌───────▼────────┐
          │ nginx (TLS,    │  ── NOT YET IN REPO (deploy/ is empty) ──
          │ same host)     │
          └───────┬────────┘
                  │  HTTP on loopback, X-Forwarded-* from RP_TRUSTED_PROXIES  [B2]
   ┌──────────────▼───────────────┐       ┌───────────────────────────┐
   │ Node web (Express 5 + tRPC)  │◀─────▶│ Node worker (jobs, SIEM   │
   │ RP_ROLE=web                  │ via DB│ forwarding, mail, exports)│
   └───────┬───────────┬──────────┘       └──────┬──────────┬─────────┘
           │ mysql2 TLS │ fs (descriptor-based)  │          │ egress policy (in/egress.ts)   [B5]
      [B3] │            │ [B4]                    │          ├──▶ SMTP relay (STARTTLS/TLS)
   ┌───────▼──┐   ┌─────▼──────────────┐          │          ├──▶ SIEM/syslog (RFC 5425 TLS, mTLS, OTLP)
   │ MySQL 8.4│   │ Private object store│◀────────┘          ├──▶ Stripe API / inbound webhook [B6]
   └──────────┘   │ (outside web root)  │                     └──▶ PostHog / Clarity (browser-side) [B7]
                  └─────────────────────┘
   Operator host shell ──▶ scripts/ops/* (migrate, create-admin, keys), portable CLI, backup/restore  [B8]
   Portable packages (.rpkg, files at rest, moved between installations)                             [B9]
   Backups (encrypted archives; off-host copy not implemented)                                       [B10]
```

One artefact runs as `web`, `worker` or `all` (ADR 0001). Web and worker share MySQL and the object store; the
worker has no inbound listener. The public marketing site (`www.readypackets.com`) is a separate system and out
of scope (ADR 0010).

### Trust boundaries

| ID | Boundary | Untrusted side | Notes |
| --- | --- | --- | --- |
| B1 | Browser ↔ nginx | Everything from the browser | TLS termination at nginx (ADR 0008). nginx configuration is not in the repository. |
| B2 | nginx ↔ Node web | Forwarded headers unless the peer is in `RP_TRUSTED_PROXIES` | Node listens on loopback only (ADR 0008). |
| B3 | Node ↔ MySQL | DB contents are trusted for integrity only where audited or chained | TLS with `verifyIdentity` (`server/db/connectionOptions.ts`). |
| B4 | Node ↔ object store | Filesystem paths and links | Descriptor-relative opaque keys (`server/modules/files/storage.ts`). |
| B5 | Worker/web ↔ outbound providers (SMTP, SIEM, Stripe API, HTTPS integrations) | DNS, remote peers, redirects | Central egress policy (`server/modules/integrations/egress.ts`, `ipPolicy.ts`). |
| B6 | Provider ↔ inbound webhook | Request body and headers | Narrow raw-body route, signature and replay window (`server/modules/integrations/stripe.ts`). |
| B7 | Browser ↔ analytics vendors | Third-party script running in the page | Consent-gated and off by default (ADR 0011). |
| B8 | Operator CLI ↔ host | Supplied files and arguments | `scripts/ops/create-admin.ts`, `scripts/ops/migrate.ts`, `scripts/ops/keys/`, `portable/cli/`. |
| B9 | Portable package ↔ importer | The whole package | Authenticated encryption, then quarantine and dry-run planning (`portable/src/reader.ts`, `server/modules/portable/`). |
| B10 | Backup archive ↔ storage/restore target | Archive bytes, restore target | `server/modules/backup/`. |

## 2. Assets

| Asset | Where | Protection |
| --- | --- | --- |
| Credentials: password hashes, TOTP seeds, recovery codes, WebAuthn keys | `identity`, `assurance` tables | Argon2id; seeds encrypted (AES-256-GCM with key id and AAD, `server/security/fieldCrypto.ts`); recovery codes hashed |
| Session identifiers and CSRF secrets | Browser cookie, `user_sessions` | Opaque random IDs, only keyed hashes stored (ADR 0002) |
| Customer PII (name, e-mail, address) | `identity`, `orders` | Field encryption plus blind indexes for lookup |
| Orders, notes, workflow history, price snapshots | `orders` | Object-level authorization (`server/modules/orders/policy.ts`) |
| Files and deliverables | Object store | Private, opaque keys, single-use download tickets |
| Messages, tickets, intake answers, policy acceptances, invoices | `engagement`, `compliance` | Encrypted at rest (per module API.md) |
| Audit trail | `audit_events`, chain, checkpoints | Fail-closed in-tx writes, HMAC chain, Ed25519 checkpoints, keyed tombstones |
| Keys: data keyring, token-hash key, chain key, backup key, package passphrases | Host files (`*_FILE`) | Permission/owner checks (`server/config/env.ts`); never in Git or logs |
| Provider credentials (SMTP, SIEM client keys, Stripe secrets) | Settings store | Encrypted, never returned to the client (`server/modules/platform/settingsStore.ts`) |
| Availability of the portal and audit forwarding | All | Rate limits, bounded queries, fenced jobs |

## 3. Actors

| Actor | Trust | Typical capabilities |
| --- | --- | --- |
| Anonymous visitor | None | Sign-in, registration, reset request, public policy pages |
| Remediation session | Authenticated, incomplete prerequisites | Only the next transition step (MFA enrolment, password change); no data |
| Customer | Full session, own and shared resources | Orders, files, messages, tickets, invoices for own/shared orders |
| Invitee/grantee | Customer with an accepted grant | Viewer or contributor on one order |
| Staff | Role `staff` plus capabilities | In-scope read, limited writes (e.g. `invoices.manage`) |
| Administrator | Role `admin`, fresh step-up for high-impact actions | Catalog, workflow, reassignment, user admin, audit centre, SIEM, backup, platform |
| Operator (host) | Shell on the host | Migrations, bootstrap admin, keys, backups, portable CLI |
| Worker process | Internal | Jobs with leases and fencing |
| External providers | Untrusted peers | SMTP relay, SIEM collector, Stripe, analytics vendors |
| Attacker variants | — | Remote unauthenticated; authenticated customer; compromised staff; DB-only writer; package/backup supplier; network attacker on egress; malicious analytics script |

## 4. STRIDE per boundary

S = spoofing, T = tampering, R = repudiation, I = information disclosure, D = denial of service, E = elevation of privilege.

### B1/B2 Browser ↔ nginx ↔ Node web

| STRIDE | Threat | Control (code pointer) | Evidence |
| --- | --- | --- | --- |
| S | Session theft or fixation | `__Host-` cookie, Secure, HttpOnly, SameSite=Lax; opaque ID with stored keyed hash; rotation on sign-in, privilege change and password change (`server/modules/identity/sessions.ts`, ADR 0002) | `server/modules/identity/identity.test.ts` "rotation invalidates the previous token…"; `tests/integration/journey-customer.test.ts` "…cookies carry __Host- attributes…" |
| S | Host-header and alias confusion | Canonical host from config; alias 308; unknown host refused before routing (`server/http/edge.ts`) | `tests/http/app.test.ts` "redirects aliases to the exact canonical origin…" |
| S | Spoofed client IP / request ID | Forwarded headers honoured only from `RP_TRUSTED_PROXIES`; server-generated request IDs (`server/http/app.ts`) | `tests/http/app.test.ts` "trusts configured peers but not client-supplied request IDs…" |
| T | CSRF | Origin + Fetch Metadata checks before session lookup; session-bound constant-time CSRF token; mutations over GET refused | `tests/http/app.test.ts` "checks origins before session lookup and validates CSRF against the resolved session", "applies identical CSRF controls to raw module routes…" |
| T | XSS / script injection | Per-response nonce CSP, no `unsafe-inline`/`eval` (`server/security/headers.ts`); React output encoding; no raw HTML sinks (REVIEW-client "Sinks and persistence") | `tests/http/app.test.ts` "sets a fresh strict CSP…"; `server/modules/engagement/engagement.test.ts` "stores XSS payloads encrypted at rest and returns them verbatim as inert NFC plain text" |
| R | User denies an action | Every privileged mutation writes `audit.record(event, tx)` in its transaction with actor pseudonym and request correlation | `server/modules/audit/emitter.test.ts` "writes the canonical envelope with request correlation and actor pseudonym" |
| I | Cached private data | API `no-store`; PWA `/api/` NetworkOnly with no navigation fallback (`vite.config.ts`); client cache purge on identity change (`client/src/app/providers.tsx`) | `client/src/app/isolation.test.tsx` "purges a previous user's private queries across A → 401 → B…" (jsdom; the real service worker is untested) |
| I | Error leakage | Safe error mapper; no stack/raw SQL in responses | `tests/http/app.test.ts` "formats safe HTTP and tRPC errors…"; `tests/foundation.test.ts` "maps domain errors and never leaks raw internals" |
| I | Search-engine exposure | `X-Robots-Tag: noindex`, `robots.txt` (ADR 0010) | `tests/http/app.test.ts` (header suite) |
| D | Request floods, batch amplification | Process-local pre-gate (`server/http/edgeAdmission.ts`), durable HMAC-slot limiter with IPv6 /64 (`server/security/rateLimiter.ts`), batch cap, body limits | `tests/http/rateLimiter.test.ts` "fails closed for API/security traffic…"; `tests/http/app.test.ts` "rejects excessive batches…" |
| E | Calling admin procedures directly | Server-side role/capability/step-up guards on every procedure; remediation sessions denied all data | `tests/integration/journey-admin.test.ts` "no staff/admin-guarded procedure accepts a full customer session or an anonymous caller"; `tests/foundation.test.ts` "enforces role, capability and fresh step-up" |

### B3 Node ↔ MySQL

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| S | Rogue DB server | mysql2 TLS with chain and `verifyIdentity`; URIs not passed to the driver (`server/db/connectionOptions.ts`) | `tests/connectionOptions.test.ts`; REVIEW-http-identity C-01–C-03 closed (no live handshake verified) |
| T | SQL injection | Drizzle parameterized queries; audit query builder with enumerated fields (`server/modules/audit/query.ts`) | `server/modules/audit/module.test.ts` "binds hostile values as parameters…" |
| T | DB-only writer edits or deletes audit rows | HMAC hash chain, Ed25519 checkpoints, keyed tombstones, chain-key identity check (`server/modules/audit/chain.ts`) | `server/modules/audit/chain.test.ts` "detects modification of an event row", "detects a forged link…"; `module.test.ts` "a DB-only actor cannot disguise a deletion as pruning…" |
| T | Ciphertext moved between rows | AES-256-GCM with key id and row/column/table AAD | `server/modules/platform/fieldCrypto.test.ts` "refuses AAD mismatch (moved to another row, column or table)" |
| R | Lost audit on failure | Fail-closed: audit insert failure aborts the business transaction | `server/modules/audit/emitter.test.ts` "fails closed: an audit store failure aborts the business transaction" |
| I | DB dump disclosure | Field encryption of PII and secrets; blind indexes for lookup | `fieldCrypto.test.ts` (17 tests) |
| D | Pool starvation / self-deadlock | Team rule: no second pool connection inside a transaction; deterministic lock orders (orders: order row only → policy grant FOR SHARE → users ascending → session → grant FOR UPDATE → files) | `server/modules/orders/oneSlotPool.test.ts`; `identity.test.ts` "never reads settings through the pool while holding a transaction (ID-06)"; `orders.test.ts` "concurrent accept and reassign on the same order never deadlock…" (no proof of global deadlock freedom) |
| E | Stale authority inside long transactions (TOCTOU) | In-transaction actor re-validation via `identity.sessions.assertCurrent(tx)` and persisted step-up (`server/modules/orders/actor.ts`, `server/modules/platform/actorGuard.ts`) | `orders.test.ts` "authority comes from PERSISTED session state…"; `identity.test.ts` "re-validates the actor inside the transaction…" |

### B4 Node ↔ object store

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| T | Path traversal, symlink/hardlink swap | Opaque keys, descriptor-relative traversal, link refusal (`server/modules/files/storage.ts`) | `server/modules/files/storage.test.ts` "rejects traversal, malformed keys, symlink namespaces and linked leaves" |
| I | Serving private bytes as static | Static and private roots must be disjoint | `tests/http/app.test.ts` "refuses static roots that overlap private storage…" |
| I | Unauthorized download | Single-use hashed tickets bound to user and session; live grant recheck before opening | `server/modules/files/files.test.ts` "stores only a hash, denies other people/sessions, and redeems exactly once", "rechecks live grants and reassignment…" |
| D | Disk exhaustion | Per-file, per-request and part-count limits; staged bytes removed on refusal | `files.test.ts` "refuses excessive per-file and total request sizes without retaining staged bytes" |
| R | Unrecorded deletions | Retention commits durable audit intent before a fenced delete; holds rechecked under lock | `files.test.ts` "rechecks holds under lock and refuses to unlink without durable intent" |

### B5 Outbound egress (SMTP, SIEM, Stripe, HTTPS integrations)

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| S | MITM of collector or relay | TLS 1.2+, chain and hostname verification, optional mTLS, no plaintext fallback (`server/modules/siem/transport.ts`, `server/modules/integrations/smtp.ts`) | `server/modules/siem/siem.test.ts` "refuses untrusted CA and wrong-hostname certificates with ZERO delivery…"; `integrations.test.ts` "enforces SMTP TLS, blocks plaintext…" (loopback) |
| T | SSRF via configured URLs, DNS rebinding, redirects | Allowlisted scheme/host/port; every resolved address classified; pinned address; redirects refused (`egress.ts`, `ipPolicy.ts`) | `integrations.test.ts` "classifies loopback, private, link-local, CGNAT, multicast, metadata…", "enforces egress SSRF policy, blocks DNS rebinding & redirects…" |
| T | Header/CRLF injection in mail | Variable allowlists; header injection refused | `server/modules/jobs/jobs.test.ts` "rejects unexpected variables and injected headers" |
| I | PII leaking to SIEM | Privacy projection before spooling (`server/modules/siem/projection.ts`) | `server/modules/siem/rfc5424.test.ts` "enforces fixed pseudonymous security projection…" (open Medium: not an allow-list) |
| R | False "delivered" claims | SMTP acceptance recorded as acceptance, ambiguous outcomes kept `unknown` | `jobs.test.ts` "records SMTP acceptance, not delivery…", "keeps ambiguous transport outcomes unknown…" |
| D | Collector outage blocks the portal | Local audit authoritative; spool, backoff, dead letter; forwarding never in the request path | `siem.test.ts` "handles retry/backoff, circuit breaking, dead-lettering…" |
| E | Read-only admin triggers credentialed probe | — | Open Medium (SIEM "Read capability can initiate an external credentialed test") |

### B6 Inbound webhooks

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| S | Forged provider event | Stripe signature over raw bytes; narrow raw-body route ahead of JSON parsing | `integrations.test.ts` "verifies Stripe webhook signatures, enforces replay window & idempotency…"; `tests/http/app.test.ts` "passes only narrow webhook bytes ahead of JSON parsing…" |
| T | Replay or reorder | Timestamp window, event-ID idempotency | `server/modules/compliance/compliance.test.ts` "handles verified provider payment & refund webhooks idempotently" |
| T | Wrong financial state from a genuine event | — | Open High BILL-01 (completed Checkout treated as paid without checking payment status; cumulative refund treated as a new amount) |

### B7 Browser ↔ analytics vendors

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| I | Session replay captures private screens | Off by default; consent gate; route exclusion; CSP admits vendor origins only while enabled and only on non-sensitive routes (ADR 0011, `server/modules/integrations/analytics.ts`) | `integrations.test.ts` "validates Clarity & PostHog identifiers strictly and scopes analyticsCsp to /privacy and /terms only"; `tests/http/app.test.ts` "permits only exact HTTPS analytics sources…" |
| E/I | Vendor script running in the app realm keeps observers after navigation | — | Open High INT-01 (feature off by default): purge runs after render; observers survive script removal |

### B8 Operator CLI

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| S | Second "first admin" on a live install | Bootstrap refuses when an active admin exists; concurrent bootstraps serialize | `identity.test.ts` "bootstrap refuses when an active administrator exists (ADMIN_EXISTS)", "two concurrent bootstraps on an empty install: exactly one succeeds" |
| I | Secrets via argv/env dumps | `*_FILE` secrets with owner/mode/type/size checks; errors never echo contents or paths | `server/config/env.test.ts` "refuses world-readable, group-writable…", "never includes file contents or paths in errors" |
| I | Migration diagnostics leak DSN | Bounded diagnostics (`scripts/ops/migrate.ts`) | REVIEW-http-identity C-02 closed (review only) |
| E | Application gaining root | Out of the application by design; privileged helpers are not implemented (MP §2.5) | — |

### B9 Portable packages

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| T | Tampered package | Authenticated header + chunked AEAD with authenticated finalization before ZIP parsing (`portable/src/crypto/envelope.ts`, `portable/src/reader.ts`) | `portable/tests/tamper.test.ts` (23); `server/modules/portable/portable.test.ts` "refuses tampering before planning or writing business rows" |
| T | Zip bomb, traversal, links, duplicate names | Name allowlist; duplicate/special entries rejected; size and ratio caps | `portable/tests/archive-exclusions.test.ts` (11) |
| D | KDF parameter bomb | Aggregate KDF ceiling before derivation | REVIEW-platform-portable-contract C1 closed; `tamper.test.ts` |
| E | Import links to an existing account or grants admin | No email-based linking; imported orders read-only; two-admin approval bound to package and plan hashes | `portable.test.ts` "refuses email-based linking to an existing account…"; `orders.test.ts` "imports read-only, idempotently…" |
| S | Package author impersonation | — | Not addressed: no asymmetric signature; authentication proves passphrase/key possession only |
| I | Secrets exported | Contract exclusions (hashes, MFA, tokens, provider secrets, paths) | `archive-exclusions.test.ts` |

### B10 Backups

| STRIDE | Threat | Control | Evidence |
| --- | --- | --- | --- |
| I | Backup theft | Encrypted archives; refusal when the key is missing, weak or world-readable (`server/modules/backup/`) | `server/modules/backup/backup.test.ts` "refuses backup fail-closed when encryption key is missing, weak, or stored in a world-readable file" (pending owner report; no independent review) |
| T | Tampered or truncated archive | Header/ciphertext/truncation/trailing-byte detection before touching targets | `backup.test.ts` "detects header bit-flips, ciphertext tampering, truncation…" |
| T | Restore over production / rewinding security state | Refuse live or non-empty targets; continuity checks | `backup.test.ts` "refuses live database target, non-empty target database…", "…§7.3 security-state continuity" |
| D | Loss of all copies | — | Not implemented: no off-host or immutable copy, no RPO/RTO, no drill |

## 5. OWASP Top 10 (2021) mapping

| Category | Primary controls | Tests (evidence class) | Open items |
| --- | --- | --- | --- |
| A01 Broken Access Control | Server-side guards; object-level policy per owning module with NOT_FOUND for invisible records (ADR 0005); live grant checks; in-tx actor re-validation; read-only imported orders; download tickets bound to current authority | `orders.test.ts` "other customer: NOT_FOUND on read, write, summary…", "viewer cannot write; contributor can write content but not share or transition", "a revoked admin session is refused…" [db]; `files.test.ts` "rechecks live grants and reassignment…"; `journey-admin.test.ts` "no staff/admin-guarded procedure accepts…" | COMP-04/05 (policy audience, questionnaire applicability), ENG-01 (search crowding), client cache isolation (C-02, addressed by `isolation.test.tsx`) |
| A02 Cryptographic Failures | Argon2id; AES-256-GCM with key id and AAD; blind-index HMAC; TLS with identity verification to DB, SMTP and SIEM; HSTS without preload | `fieldCrypto.test.ts` "matches the independently computed test vector", "detects tampering of IV, ciphertext and tag"; `siem.test.ts` "refuses untrusted CA and wrong-hostname…" | No HSM/KMS; symmetric audit chain key without rotation; files not application-encrypted |
| A03 Injection | Drizzle parameters; bounded audit query builder; strict Zod schemas; CRLF/log-injection neutralization; RFC 5424 escaping; React encoding | `audit/module.test.ts` "binds hostile values as parameters…"; `redact.test.ts` "neutralises CR/LF/U+2028/ESC…"; `rfc5424.test.ts` "neutralizes C0/C1/DEL and Unicode bidi override…"; `jobs.test.ts` "rejects unexpected variables and injected headers" | RFC 5424 SD-name collision (Medium) |
| A04 Insecure Design | Account-transition service; fail-closed audit; job fencing with `unknown` outcome; two-admin portable approval; preview profile refused on readypackets.com | `pure.test.ts` "every combination yields a subsequence of the canonical order…"; `jobs.test.ts` "marks expired unsafe jobs unknown…"; `env.test.ts` "never allows the preview profile on readypackets.com…" | H-3 residual (preview with `NODE_ENV=production` on other hosts) |
| A05 Security Misconfiguration | Fail-closed env validation; secret files permission checks; nonce CSP; host allowlist; mail capture refused in production | `env.test.ts` (23); `tests/http/app.test.ts` "sets a fresh strict CSP…" | No nginx/systemd/container profiles in repo; no least-privilege DB user scripts |
| A06 Vulnerable and Outdated Components | Locked dependencies (`pnpm-lock`); `docs/engineering/DEPENDENCIES.md`; `scripts/dev/add-dep.sh` review path | None automated | No SCA scan, no SBOM, no CI |
| A07 Identification and Authentication Failures | 15–128 code-point passwords with common list; mandatory TOTP; WebAuthn; uniform responses; per-account and per-address throttles; session rotation and expiry; step-up | `pure.test.ts` "counts Unicode code points after NFC…"; `assurance.test.ts` "rejects enrollment-code replay…"; `identity.test.ts` "uniform error for unknown account…", "throttles by account blind index…" | ID-04 partial (registration work differs per branch); no timing measurement; client-address sign-in throttle is an integration target |
| A08 Software and Data Integrity Failures | Portable AEAD + manifest hashes; config export HMAC; audit hash chain + signed checkpoints; webhook signatures; jobs fencing | `tamper.test.ts`; `configTransfer.example.test.ts`; `chain.test.ts`; `integrations.test.ts` "verifies Stripe webhook signatures…" | No release signing/provenance; no portable sender signatures; BILL-01 |
| A09 Security Logging and Monitoring Failures | Canonical audit envelope; correlation; self-audited search/export; SIEM forwarding with health; at-least-once semantics | `emitter.test.ts`; `audit/module.test.ts` "returns newest first, is self-audited…"; `siem.test.ts` "reports truthful health states…" | Four open SIEM High findings; attribute allow-list (Medium); no immutable off-host audit copy |
| A10 Server-Side Request Forgery | Central egress policy; address classification incl. IPv6 transition forms; pinned resolution; redirect refusal; SIEM private destinations separately approved | `integrations.test.ts` "classifies loopback, private…", "rejects decimal, octal, hex, shorthand IPv4…", "enforces egress SSRF policy, blocks DNS rebinding & redirects…"; `siem.test.ts` "blocks SSRF / forbidden egress targets…" | INT-02 (HTTPS pinning callback), SIEM pooled sockets skip current egress authorization |

## 6. Abuse cases

| # | Abuse case | Attack path | Controls | Evidence | Residual |
| --- | --- | --- | --- | --- | --- |
| AC-1 | Account takeover | Credential stuffing, reset-link theft, session theft, MFA bypass via reset or batching | Rate limits by account blind index and address; mandatory TOTP/WebAuthn; reset tokens single-use and never returned by the API; reset revokes all sessions; `__Host-` HttpOnly cookies; remediation sessions cannot see data | `identity.test.ts` "redeem: single use, revokes all sessions…", "forgot-password via the API never carries a link, even in preview"; `assurance.test.ts` "redeems a recovery code exactly once concurrently…" | Phishing of TOTP codes (TOTP is not phishing-resistant); SMTP channel security depends on the relay |
| AC-2 | Account enumeration | Compare registration, sign-in and reset responses | Uniform response shapes and messages; reset enqueues identical work | `identity.test.ts` "existing address: same response shape…", "public response is identical for known, unknown and ineligible accounts…"; `auth.test.tsx` "shows one uniform, announced message…" | ID-04 partial: registration does different DB/outbox work; timing not measured |
| AC-3 | IDOR | Guess or tamper order/file/grant IDs | ULID public IDs; owning-module authorization on every access; NOT_FOUND for invisible records; consistent snapshot for authz+projection | `orders.test.ts` "tampered / malformed / unknown identifiers are indistinguishable NOT_FOUND", "detail read uses one snapshot: a transfer committed mid-request never leaks the new owner's data" | Concurrency test covers detail across transfer, not summary or grant list (REVIEW O-02 note) |
| AC-4 | Privilege escalation via staff console | Staff calls admin procedures; demoted admin finishes an in-flight write; customer reaches admin routes | Capability gates; fresh step-up; in-tx `assertCurrent` with persisted role/step-up; last-admin invariant | `orders.test.ts` "customer cannot reach admin procedures; reassignment requires fresh step-up", "authority comes from PERSISTED session state…"; `identity.test.ts` "two admins demoting each other concurrently…"; `journey-admin.test.ts` "staff (invited after step-up) can read orders but every admin-only capability is refused" | Client "staff console" UI is not a control; only the server is |
| AC-5 | Audit tampering | DB-only writer edits, deletes or reorders events; disguises deletion as pruning; signs with a substitute key | HMAC chain, Ed25519 checkpoints, keyed tombstones, chain-key identity pinning, step-up-gated manual checkpoints | `chain.test.ts` (12); `audit/module.test.ts` "a DB-only actor cannot disguise a deletion as pruning…", "refuses to extend a chain under a different key" | A host-root attacker holding the chain key can rewrite local evidence; no immutable off-host copy; no DB-level append-only grants |
| AC-6 | Malicious upload | Polyglot or script file, oversize, many parts, path tricks in names | Extension + magic agreement; allowlisted formats; size/count limits; display-name sanitizing; private storage; `Content-Disposition: attachment` + `nosniff`; optional scanner fails closed | `files.test.ts` "rejects empty, extension/magic mismatch, and disallowed types…", "sets safe attachment headers…"; `classification.test.ts` "normalizes display filenames…" | No malware scanner configured; branding images parsed structurally, not fully re-encoded |
| AC-7 | SSRF via integrations | Admin configures SIEM/SMTP/webhook URL pointing at metadata, loopback or private networks; DNS rebinding; redirects | Egress policy with explicit operator-approved private exceptions; pinned addresses; redirect refusal | `integrations.test.ts` SSRF matrix; `siem.test.ts` "blocks SSRF / forbidden egress targets…" | INT-02; pooled SIEM sockets not re-authorized after policy change |
| AC-8 | Malicious import package | Tampered or replayed package; zip bomb; traversal; email-link takeover; admin-role grant | AEAD before parsing; archive limits; contract exclusions; dry run default; two-admin approval bound to hashes; no email linking; read-only orders; replay produces immutable links | `portable.test.ts` "reimports the exact same package as immutable links…", "refuses email-based linking…"; `archive-exclusions.test.ts` | No sender authenticity (no signatures); a holder of the passphrase can produce an authentic package |
| AC-9 | Backup theft | Copy of backup archive or storage volume | Encrypted archives; key file permission checks; key custody separate from archives | `backup.test.ts` "refuses backup fail-closed…" | Pending owner report; no off-host/immutable copy; key custody runbook covers keys only |
| AC-10 | Preview-profile misuse | Run the preview profile (header token transport, `ACAO *`, framing, mail capture, preview links) against real data or the real domain | Preview refused on `readypackets.com` and subdomains; exact synthetic-data acknowledgement required; permanent preview banner; preview links never returned by the reset API | `env.test.ts` "never allows the preview profile on readypackets.com…", "requires the exact synthetic-data acknowledgement…"; `review.test.tsx` "shows a permanent, non-dismissible banner…"; `identity.test.ts` "forgot-password via the API never carries a link, even in preview" | H-3 residual: allowed with `NODE_ENV=production` on any other host |
| AC-11 | Price or discount tampering (increment 02) | Client sends its own amounts, orders a packet twice or in two tiers to game the bundle, or replays a stale quote; a non-admin edits the bundle rule; the offerings import runs as an unaudited actor | Server computes subtotal, discount and total from the current catalog version and `orders.bundle_rule` inside the create transaction; the create/quote input has no amount fields (strict zod); packet quantity 1 and one tier per packet are enforced on the server; bundle rule writes need admin + `catalog.manage`, are re-validated in the transaction and audited; the `system` import actor is in-process only (never routed) and audited as `system` | `packets.test.ts` "enforces quantity 1 and one tier per packet…", "quotes the bundle hint, then applies the discount server-side…", "admin bundle rule edit is validated, audited and capability-gated", "upsertFromOfferings is idempotent…, audits as system…" | A quote can differ from the created order if the catalog or rule changes in between; the order stores the figures it was created with |
| AC-12 | Workflow rules and console access (increment 04) | Customer skips a required upload or acceptance by calling transition directly; accepts a text other than the one shown (stale or swapped); edits files after a phase was reviewed; a viewer or another customer accepts; staff silently unlocks a phase; stored script in acknowledgement text; staff enumerates accounts through the grant dialog or grants themselves; an API key moves orders it should not | Requirements checked on the server inside the transition transaction (cancel exempt, fail closed when Files is unavailable); acceptance bound to the SHA-256 of `title + "\n\n" + body` of the pinned version and current status, insert-only, one per side; phase locks enforced in the Files write ports and in `acknowledge`; side = owner/contributor or staff/admin, viewers read-only; unlock needs `orders.phase.unlock`, a 10–500 character reason kept as an encrypted internal note, audited, re-locks at the next change; acknowledgement and hint text plain-text only (markup refused at design time, rendered as text); grants need admin + `orders.access.grant` + step-up + setting, identical answer for unknown/ineligible/owner addresses, masked e-mails only; `api` acts only where `allowedBy` lists it | `requirements.test.ts` "shows the checklist and refuses to leave the status", "records an acknowledgement of the exact text, once", "authorisation matrix for read and acknowledge", "locks the phase being left…", "refuses unknown, ineligible and owner addresses with the same answer", "lists, gets, creates as system and refuses transitions the workflow does not give to api"; `rules.test.tsx` acknowledgement dialog | Typed names show intent only; they are not identity proof. IP is captured only in the audit event. A customer-wide grant reveals every future order of that customer to the grantee until it is revoked. |

## 7. Accepted exceptions (from ADRs)

| Source | Exception | Rationale |
| --- | --- | --- |
| ADR 0002 | Preview profile uses a header session token held in memory and credentialless CORS | The hosted preview frame has no cookies or storage; guarded by AC-10 controls |
| ADR 0003 | TOTP is mandatory; passkeys are an additional factor, not a replacement | TOTP is not phishing-resistant and is not labelled so |
| ADR 0008 | TLS terminates at nginx on the same host; Node trusts forwarded headers only from listed proxies | Single-host deployment |
| ADR 0009 | Ordinary read browsing fails open when the limiter store is down; fixed windows allow about a 2× edge burst | Availability of reads; auth/mutation fail closed |
| ADR 0010 | Portal is `noindex`; SEO/GEO/AEO belongs to the public site | Private data behind auth |
| ADR 0011 | Analytics vendors may run on non-sensitive routes after consent | PI-17; off by default |
| ADR 0012 | Two TypeScript versions (7 for typecheck, 6 for lint) | Tooling support gap |
| Files VERIFICATION | No distributed transaction across filesystem and DB; staged objects reconciled | MP §7 acknowledges DB and object storage are not one transaction |

## 8. Open findings carried from reviews (as of 2026-11-20)

| Finding | Severity | Area | Status |
| --- | --- | --- | --- |
| BILL-01 | High | Stripe paid-state and refund semantics | Open (REVIEW-compliance-engagement-integrations) |
| INT-01 | High, off by default | Clarity in app realm; purge after render | Open |
| SIEM collector identity not bound to credentials/backlog | High | SIEM | Open (REVIEW-audit-siem-backup) |
| SIEM concurrent secret updates can undo rotation | High | SIEM | Open |
| SIEM retention can silently stall forwarding | High | SIEM | Open |
| SIEM destination lease uses unrelated fence identity | High | SIEM | Open |
| SIEM pooled connections skip current egress authorization | Medium | SIEM | Open |
| SIEM projection not an allow-list; retry ordering/ambiguity; RFC 5424 key collisions; read capability starts probe | Medium | SIEM | Open |
| Audit: partial checks vs full-chain health, fast backlog count, generic external attributes, JSON query work, export manifest completeness under pruning | Medium | Audit | Open in part after `a5cd080` |
| COMP-04, COMP-05, COMP-06 | Medium | Compliance | Open |
| ENG-01, ENG-02 | Medium | Engagement | Open |
| ENG-03 | Low | Engagement | Open |
| INT-02, INT-03 | Medium | Integrations | Open |
| ID-04 | Medium | Identity enumeration | Partially remediated |
| H-3 (env part) | Low–Medium | Preview profile in production runtime | Open |
| Client C-06, C-07 | Low | Dialog overflow, toast focus | Per REVIEW-client; not re-verified here |
| Backup and deployment | — | — | No review yet ("pending owner handoff") |

Closed on re-review (not repeated here): ID-01–03, ID-05, ID-06, DB C-01–C-03, F-01–F-03, O-01 (closed at
`8902534`, recorded in `7e9c5b0`), O-02, H-1, H-2, J-1, P1–P5, portable C1–C7, bootstrap password file, legacy
file handle, COMP-01–03, IPv6 transition classification. Client C-01–C-05 and C-08 have regression tests in
`client/src/app/isolation.test.tsx` and `review.test.tsx`; a formal re-review is not recorded.

## 9. Residual risks

- **No deployed edge.** nginx, TLS certificates, systemd units and least-privilege DB users are not in the
  repository, so B1/B2 controls are verified only in-process.
- **Host compromise.** A root attacker or key holder can read keys, decrypt data and rewrite local audit
  evidence. Signed checkpoints detect, but do not prevent, tampering by anyone without the key; with the key,
  detection fails. There is no independent immutable copy.
- **Key management.** Keys are host files with permission checks; no HSM/KMS; audit chain key has no rotation.
- **Third-party scripts.** If analytics is enabled, vendor code runs in the app realm (INT-01).
- **Financial correctness.** BILL-01 can mark invoices paid incorrectly.
- **SIEM delivery.** Four High findings affect which collector receives which data and whether forwarding
  stalls silently.
- **Browser behaviour.** CSP enforcement, the generated service worker, cache isolation, layout and assistive
  technology have not been exercised in real browsers.
- **Timing side channels.** Enumeration resistance relies on uniform responses; timing was not measured.
- **Deadlock freedom.** Lock orders are documented per module (orders: order → [grant FOR SHARE] → users
  ascending → session → grant FOR UPDATE → files; identity API.md records the order-first exception) and
  tested for specific interleavings, not proven globally.
- **Supply chain.** No SCA, SBOM, provenance or release signing.

## 10. Increment 03 trust boundaries and validation gates

Increment 03 adds optional provider and data flows; all are disabled by default under the increment contract.
Use [the independent findings ledger](INCREMENT_03_REVIEW.md) for current findings and fix verification.
The controls below are review gates unless labelled verified. No live Entra tenant, audit mailbox, cloud storage
or SharePoint destination is verified here. The historical base sections above are not a current deployment inventory.

| Boundary | Main abuse case | Control and evidence boundary |
| --- | --- | --- |
| Browser and Entra to the portal | Callback replay, login CSRF, takeover via linking or stale step-up | Require exact canonical callback, single-use purpose/session/browser-bound state, PKCE, nonce, strict token claims, and a verified tenant/object link. Apply remediation before access and do not allow an email collision to link identities. Require fresh MFA from the same identity before Entra step-up. Final session issuance serializes with SSO configuration changes (I-A02; three MySQL race regressions passed). Native and container proxy refusal is verified in source; runtime is a separate gate. |
| Identity administration to local recovery | Unavailable or compromised IdP leaves no usable local administrator | Serialize removal of local credential paths and enforce the last local-MFA administrator invariant across role, status and factor changes. Role/status mutation uses the Assurance policy lock and same-transaction invariant check (I-A01). Host-only recovery must durably audit credential reset and session revocation without logging the temporary password; service tests do not verify the host wrapper. |
| Mail transports, audit mailbox and stored content | Duplicate sends; secrets in copied, retained or rendered content | Do not replay ambiguous submissions or fail over on a permanent/policy rejection. Graph requires HTTP 202 for acceptance; SMTP uses the same effective sender passed by Jobs. Render redacted copies from masked inputs; verify audit mailbox control; encrypt, expire and audit stored content behind live step-up. The Jobs view uses inert source text. Graph/SMTP local integration tests passed; no live mailbox proof was performed. |
| Template/editor preview to browser | Stored script, tracking request, navigation or network data exfiltration | Sanitize delivery HTML and validate typed placeholders. Preview semantic HTML only with tokenless sandboxed `srcdoc`, child CSP and no navigation/network sinks; otherwise render text. Do not relax the portal CSP for the canvas or editor. Verify functionality and absence of network/navigation in a real browser. |
| Audit tap to automation worker and external receivers | Internal event becomes public, recursive automation, duplicate dispatch, escaped audit transaction | Validate catalogue projections and live recipients; carry an origin marker through jobs and mail; deduplicate event/version/action and use fences, limits and signed bounded webhook delivery. Staff-only triggers may produce only in-app notifications: mail and external actions default-deny. Notifications persist the audience, suppress secondary mail and use same-statement live-role predicates on reads and mutations. A missing savepoint must fail closed; see J-A01/J-A02. MySQL/local-fake regression evidence is recorded in the ledger. |
| Portal to OAuth/storage and SharePoint | Credential substitution, redirect or resumable-session SSRF, revoked assignment still copies customer bytes | Bind OAuth state to actor, session, provider and connection revision. The callback stages only an encrypted code; a first-party CSRF POST with the original persisted session and live authority is required for exchange (G-O01; local MySQL/HTTP tests with synthetic provider transport). Require exact provider lineage and central egress, no Graph bearer on upload-session URLs. Recheck destination generation and scope before each write; an already in-flight upload cannot be recalled. SharePoint also needs dispatch-time settings enforcement and uniqueness across jobs. Local files remain authoritative; remote backups must be verified and encrypted before copy. |

## 10a. Increment 04 — workflow rules and console order actions (orders_engineer)

| Boundary | Main abuse case | Control and evidence boundary |
| --- | --- | --- |
| Customer browser to `orders.requirements.*` | Bypassing requirements, accepting a swapped or stale text, acting on a locked phase | All rules run on the server against the order's pinned workflow version; the client only displays and sends the hash it was shown. See AC-12. DB tests use fake Files/identity adapters. |
| Orders to Files (slot and lock ports) | Upload into a locked phase or a slot the side may not use | `getFileUploadSlots` / `assertFileStatusWritable` re-read the order in the caller's transaction after the order row lock; Files applies its own type and size rules. Verified with a fake Files adapter only. |
| Console to `orders.admin.access.*` / `createForCustomer` | Over-sharing, enumeration, unaudited creation on behalf | Features ship off; capability + step-up; uniform refusals; audit in the transaction; both parties notified. Not verified against the real identity step-up. |
| Public API to the `orders` provider | Integration moves or creates orders beyond its scope | Scopes checked by the public API module; provider acts as `system`, transitions only where the workflow lists `api`, tier must match. Tested through the provider directly, not over HTTP. |

## 10b. Increment 04 part B — console order workspace (orders_engineer, S1)

| Boundary | Main abuse case | Control and evidence boundary |
| --- | --- | --- |
| Console to `orders.console.rename` | Customer renames, stale overwrite, hidden characters, names leaking through audit/SIEM | staffProcedure + `orders.rename` re-checked in the tx; optimistic version; NFC, 1–120 characters, control characters refused. The audit event carries only `renamed` and the old/new lengths. Names go to `order_name_history` (orders-owned, never exported); the customer view of that history has no names and no staff identity. consoleOrder.test.ts. |
| Other modules to `orders.gates` | Customer side-steps a required acceptance (upload, record, intake, submit) or an integration acts for a customer who has not accepted | One server check in the caller's tx: staff pass; system/API v1 checked against the owner; gates but no provider → `UNAVAILABLE ORDER_GATES_UNAVAILABLE` (fail closed); unmet → `CONFLICT ORDER_ACCEPTANCE_REQUIRED`. Cancellation is never gated. Tested with a fake provider; the real provider (compliance) is not covered here. |
| Designer to `storageFolder` templates | Path traversal or reserved names in a SharePoint folder | `isOrderFileFolderTemplate` at save and publish (tokens only, no `..`, absolute paths, backslashes, control characters or reserved names). The copy worker re-checks the resolved path. Pure tests only; no real SharePoint. |
| Contributed order banners/tabs | A feature's UI hides or fakes a gate | UI only; every rule is enforced by the server. |

## 11. Non-goals (explicit)

- Native iOS/Android apps (Day-2, MP §3).
- Public marketing site and its SEO/GEO/AEO (ADR 0010).
- SAML and multi-tenant federation. The increment adds optional single-tenant Entra OIDC and SharePoint integrations.
- Offline authenticated data, background upload, push notifications (MP §3 requires separate threat models).
- Defending against a compromised host root or a holder of the installation keys.
- Exactly-once delivery to any external system (at-least-once with idempotency and `unknown` outcomes instead).
- Malware detection (scanner hook exists; no scanner shipped).
- DDoS protection beyond application rate limits (expected from the network edge).

## Change log

- 2026-11-20 — first complete draft (orders_engineer).
- 2026-11-20 — AC-11 (increment 02 pricing and offerings import) added (orders_engineer).
- 2026-11-21 — Increment 03 boundary, review gates and evidence distinctions added (http_security_engineer).
- 2026-11-21 — AC-12 and section 10a (increment 04 workflow rules and console order actions) added (orders_engineer).
