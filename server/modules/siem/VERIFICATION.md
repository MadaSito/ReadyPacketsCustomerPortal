# SIEM / Syslog Forwarding — Verification Report (`server/modules/siem/**`)

## 1. Scope & Ownership Summary

- **Owned & Implemented here:** `server/modules/siem/**` (`types.ts`, `schema.ts`, `settings.ts`, `catalogue.ts`, `projection.ts`, `rfc5424.ts`, `formats.ts`, `transport.ts`, `validation.ts`, `router.ts`, `index.ts`, `testPki.ts`, `rfc5424.test.ts`, `siem.test.ts`, `API.md`, `VERIFICATION.md`), `tests/integration/siem-forwarding.test.ts`, + `siem.read` capability registration in `shared/capabilities.ts`.
- **Client UI ownership:** `client/src/features/siem/**` (`/admin/siem`) was reassigned by `/root` to `portable_ops_engineer` and integrated against `server/modules/siem/API.md` & `router.ts`.

---

## 2. Source Defects Fixed (Architecture §8.1 / §8.5)

| Legacy Defect | Remediation in `server/modules/siem/**` | Verified By |
| --- | --- | --- |
| Multiplied syslog facility by `10` instead of `8` (`facility * 10 + severity`) | `computeSyslogPri(facility, severity)` computes RFC 5424 §6.2.1 `facility * 8 + severity` (e.g. `local0` `16 * 8 + 4 = 132` -> `<132>`) | `rfc5424.test.ts` ("computes PRI = facility * 8 + severity...") |
| Appended malformed structured data / extra fields after `MSG` | `formatRfc5424Message` places `STRUCTURED-DATA` (`[<sdIdName>@<PEN> ...]` or `-` when `enterpriseNumber === null`) strictly in the RFC 5424 header slot before canonical single-line JSON `MSG`; never emits fake unassigned PENs (`32473`) | `rfc5424.test.ts` ("formats full RFC 5424 header, nil STRUCTURED-DATA...") |
| Unverified TLS / plaintext syslog fallback | `transport.ts` enforces `minVersion: "TLSv1.2"`, `rejectUnauthorized: true`, strict SAN/hostname verification, and DNS-pinned socket dial on every connection (`syslog_rfc5425`, `jsonl_tls`, `cef_tls`, `otlp_https`); zero plaintext or `rejectUnauthorized: false` paths exist | `siem.test.ts` ("refuses untrusted CA and wrong-hostname certificates with ZERO delivery and ZERO plaintext/unverified fallback") |

---

## 3. Feature & Security Matrix -> Test Mapping

### `server/modules/siem/rfc5424.test.ts` (13 tests — all passing)
1. **PRI math & OTel severity mapping:** `TRACE`/`DEBUG`->`7`, `INFO`->`6`, `WARN`->`4` (`<132>`), `ERROR`->`3` (`<131>`), `FATAL`->`2` (`<130>`), range checks on `facility` (`0..23`) and `syslogSeverity` (`0..7`).
2. **RFC 5424 header & JSON `MSG`:** `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG` with RFC 3339 millisecond UTC timestamp, UTF-8 BOM (`\uFEFF`) handling, and nil `-` when no PEN is configured.
3. **32-char `SD-PARAM` collision prevention & JSON `MSG` field isolation:** 40-char attribute keys sharing a 32-char prefix are deterministically disambiguated (`_<idx>`) inside `[rp@PEN ...]`, and untrusted attribute values remain isolated inside `attributes` in JSON `MSG`.
4. **RFC 5424 §6.3.3 escaping:** Escapes `"`, `\`, `]` and neutralizes control characters in `PARAM-VALUE`.
5. **Header injection neutralization:** Strips CR/LF/NUL/non-PRINTUSASCII and enforces RFC 5424 length bounds (`HOSTNAME <= 255`, `APP-NAME <= 48`, `PROCID <= 128`, `MSGID <= 32`).
6. **RFC 5425 octet-counting & multi-byte UTF-8 truncation:** `frameOctetCounted` prefixes exact UTF-8 byte length (`<byteLen> <msg>`); `truncateUtf8Safe` never splits multi-byte UTF-8 sequences (`東京...`) and marks `truncated="true"`.
7. **JSON Lines (`jsonl_tls`) & ArcSight CEF (`cef_tls`) adapters:** Escapes pipe/backslash/newline injection attempts and wraps CEF inside RFC 5424 + RFC 5425 octet-counted TLS frames.
8. **OTLP/HTTP JSON (`otlp_https`) `ExportLogsServiceRequest`:** Maps `timeUnixNano`, `observedTimeUnixNano`, `severityNumber`, `severityText`, `traceId`, `spanId`, and resource attributes.
9. **Defense-in-depth external projection (`projection.ts`):** Strips `actor_user_id`, `resource_public_id`, `session_ref`, `source_address_ref`, raw IPs, emails, secrets, and enforces strict typed allowlists + closed/lowercase value vocabularies across `EXTERNAL_SAFE_COUNT_KEYS`, `EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS`, `EXTERNAL_STRING_ATTRIBUTE_KEYS`, `EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS`, and `EXTERNAL_NUMERIC_ATTRIBUTE_KEYS`.
10. **Increment 06 SIEM catalogue consistency (`catalogue.ts`):** Verifies every `forwardedAttributes` and `forwardedSafeCounts` key in `SIEM_EVENT_CATALOGUE` is allowlisted in `projection.ts`, every `withheldLocalKeys` and `SIEM_NEVER_FORWARDED_ATTRIBUTE_KEYS` entry (`address_ref`, `account_ref`, `incident_public_id`, `ban_public_id`, `reason`, `note`, `warning_text`, etc.) is absent from all outbound allowlists, and `findSiemCatalogueEntry` resolves D7 and Increment 06 events.
11. **D7 `security.incident.*` & `security.ban.*` multi-format serialization & closed-enum enforcement:** Verifies `projectAuditEnvelopeForSiem` forwards `rule_key`, `severity`, `status`, `event_count`, `account_count`, `address_count`, `escalated`, `events_added`, `close_reason`, `action_kind`, `permanent`, and `automatic` across RFC 5424, JSONL, CEF, and OTLP while stripping `address_ref`, `account_ref`, `incident_public_id`, `ban_public_id`, raw IPs, and free-text `reason`, and dropping out-of-vocabulary `rule_key`/`close_reason` values.
12. **Increment 06 business/admin/compliance projection:** Verifies `report.exported` (`spec_hash`, `rows`) and `promotion.settings_updated` (`max_discount_percent`, `max_discount_bps`, `allow_zero_total`) project cleanly while withholding local ULIDs and monetary figures.
13. **Increment 07 SIEM catalogue & privacy-boundary projection:** Verifies all Increment 07 families (`order.stage.*`, `order.progress.lowered`, `order.payment_state.changed`, `order.status_catalog.*`, `order.question.*`, `order.admin_task.*`, `order.stage_run.*`, `order.completion.*`, `automation.rules.reordered`, `ops.alert.*`, `ops.attention.reminder_sent`, `integration.webhook.*`, `integration.egress.preset_changed`, `integration.graph.write_checked`, `file.uploaded`, `file.playback.*`, `file.deliverable.open`, `file.archive.*`, `payments.*`, `payment.refund.flagged`, `identity.saml.*`, `identity.sso.*`, `storage.file_sync.*`) resolve in `SIEM_EVENT_CATALOGUE` (`increment: "07"`) and strip `dedupe_key`, alert titles/text, encrypted question/answer text, local ULIDs (`subscription:*`, `question_public_id`, `alert_public_id`), destination URLs, and SAML XML assertions across RFC 5424, JSONL, and CEF.

### `server/modules/siem/siem.test.ts` (16 module & regression tests — all passing against MySQL 8 + in-process `node:tls` / `node:https` receivers)
1. **Truthful health lifecycle (`ModuleLifecycle.health()`):** Verifies `not_configured` -> `disabled` -> `ok` -> `degraded` (CA expiring <= 14 days) -> `failing` (CA expired), plus write-only secret redaction.
2. **RFC 5425 TLS octet-counted delivery, socket pooling, reconnect, and off-host checkpoint custody:** Proves TLS handshake reuse (`handshakeCount === 1` across batches), clean reconnect on collector restart, filtering by `minSeverity`/`categories`, self-event loop prevention (`siem.*`), and `audit.checkpoint.created` (`checkpoint_seq` + `head_link_hmac_sha256`) custody forwarding.
3. **Certificate & SAN hostname validation:** Wrong hostname (`TLS_HOSTNAME_MISMATCH`) and untrusted CA (`TLS_CERT_UNTRUSTED`) deliver `0` frames with `receiptConfirmation: "none"`.
4. **Mutual TLS (mTLS):** Collector with `requestCert: true, rejectUnauthorized: true` rejects unauthenticated client (`0` frames), `updateDestination` rejects mismatched cert/key pair (`MTLS_KEY_MISMATCH`), and valid client cert/key succeeds (`completed`, `transport_accepted`).
5. **Multi-adapter TLS delivery:** Verifies `jsonl_tls`, `cef_tls`, and `otlp_https` (`Authorization: Bearer ...`, `receiptConfirmation: "collector_2xx"`) against live TLS/HTTPS servers.
6. **SSRF & outbound egress enforcement:** Blocks cloud metadata IP (`169.254.169.254` even when `allowPrivateNetwork: true`) and unapproved RFC1918 addresses (`EGRESS_BLOCKED`).
7. **Retry/backoff, circuit breaker, dead-lettering, spool cap, restart resume, and step-up replay:** Uses `FakeClock` to verify exponential backoff, circuit open (`CONNECTION_REFUSED`), dead-lettering at `maxAttempts`, backpressure pause at `spool_max_events` (qualified honestly against upstream audit retention), clean resume across `createSiemModule` restart, and step-up dead-letter replay draining all 105 events.
8. **Multi-worker concurrency:** Proves concurrent `runDeliveryCycle` calls claim per-destination leases without double-sending.
9. **Zero-trust RBAC, step-up MFA, and fail-closed transactional audit:** Verifies anonymous (`UNAUTHORIZED`), customer/staff/remediation-admin (`FORBIDDEN`), unstepped/stale-step-up admin (`STEP_UP_REQUIRED`), and full transaction + secret rollback on `AUDIT_UNAVAILABLE`.
10. **Cross-Model Review Rules 1, 2, 3:** Runs full `create -> update -> delete` lifecycle on a `connectionLimit: 1` MySQL pool without self-deadlock, catches in-tx role demotion & session revocation (`SESSION_NOT_CURRENT`), and proves `siem.destination.deleted` is recorded in `tx` while the row still exists before deletion.
11. **Security Review — Endpoint identity & per-destination AAD secrets:** Proves concurrent updates on distinct destinations never overwrite each other's secrets, endpoint changes reject retained credentials (`CREDENTIALS_REQUIRE_ROTATION_OR_CLEAR`), and queued backlog is quarantined (`ENDPOINT_CHANGED`) unless `migrateBacklog: true`.
12. **Security Review & Audit `S-1` — Retention-pruned empty pages & missing gaps:** Proves `events: []` with advanced `nextCursor` (`pruned: 250`) persists progress under lease and delivers subsequent events, while `missing > 0` records durable `siem.audit.loss_detected` (`WARN`, `AUDIT_EVENTS_MISSING`) and sets `health()` to `failing`.
13. **Security Review — Cross-job fencing, live egress revocation, and fail-closed egress port:** Proves high `job.fencingToken` on a retried job never starves subsequent scheduled jobs at `fencingToken: 1`, live egress revocation immediately evicts pooled TLS sockets (`EGRESS_BLOCKED`, `0` post-revocation frames), and missing `services.integrations.egress` fails closed.
14. **Security Review — Strict FIFO head-of-line backoff & isolated step-up `sendTestEvent`:** Proves newer queued events never overtake a backed-off head event, `destinations.test` enforces `siem.manage` step-up, and probe sockets are one-shot without evicting the worker's pooled TLS socket.
15. **Assurance Re-Review Regressions (`H1`, `H4`, `M pool`, `M receipt`):** Proves global `SIEM_DEFAULT_CLIENT_CERT`/`KEY` are never implicitly sent without per-destination endpoint consent, narrowing `minSeverity`/`categories` immediately prunes non-matching queued backlog rows, worker leases are anchored to MySQL `UTC_TIMESTAMP(3)` with remaining-lease I/O abort budgets and clean in-flight revision cutoffs, global `SIEM_DEFAULT_CA_BUNDLE` rotation evicts pooled TLS sockets, and OTLP HTTPS `5xx` responses preserve `uncertainDelivery = true` (`HTTP_SERVER_ERROR`).
16. **Increment 06 D7 Security Incidents & Sign-in Bans End-to-End TLS JSONL Delivery:** Proves `security.incident.{opened,updated,acknowledged,action,closed}` and `security.ban.{created,released,policy_updated}` deliver over TLS with `correlation_id`, `resource_ref`, `rule_key`, `severity`, `status`, `event_count`, `account_count`, `address_count`, `escalated`, `events_added`, `action_kind`, `permanent`, `close_reason`, `automatic`, `enabled`, and `threshold`, while zero `address_ref`, `account_ref`, `ban_public_id`, `incident_public_id`, or raw network addresses ever leave the installation.

### `tests/integration/siem-forwarding.test.ts` (1 full-stack HTTP + MySQL + TLS journey — passing)
1. **End-to-end assembled system journey:** Real `createContainer` + MySQL + `createApp` via Supertest -> admin bootstrap (`identity.provisionLocalAccount`), sign-in, password change, TOTP MFA enrolment, and step-up over HTTP -> sanctioned loopback egress rule (`integrations.admin.egress.create`) -> enabled RFC 5425 TLS destination trusting runtime-generated CA -> real failed sign-in (`identity.signIn`) + real setting update (`platform.admin.settings.update`) -> real job queue execution (`audit.chain.seal` + `siem.deliver` via `drainJobs()`) -> verifies octet-framed RFC 5424 messages carry the exact `X-Request-Id` response headers in structured data and JSON payload with zero secret/PII leakage -> verifies untrusted-CA destination delivers `0` bytes and transitions `siem.admin.health` and `platform.admin.health` to `failing`.

---

## 4. Verification Commands Executed

```bash
source scripts/dev/env.sh
scripts/dev/tc.sh 'server/modules/siem|client/src/features/siem|tests/integration/siem-forwarding'
scripts/dev/lint.sh server/modules/siem tests/integration/siem-forwarding.test.ts
scripts/dev/test.sh server/modules/siem
scripts/dev/test.sh tests/integration/siem-forwarding.test.ts
```

All commands exited `0` (`25/25` server & integration tests passing).

---

## 5. Honest Operational Caveats & ADR Candidates

1. **TLS stream write flush vs application acknowledgement (`ADR candidate`):** RFC 5425 syslog-over-TLS (`syslog_rfc5425`, `cef_tls`) and `jsonl_tls` are unidirectional stream protocols without an application-layer ACK frame (unlike RELP or OTLP HTTP `2xx`). SIEM reports `receiptConfirmation: "transport_accepted"` for TLS stream writes and `"collector_2xx"` for OTLP HTTPS, and persists `uncertainDelivery: true` whenever a TLS socket errors after bytes entered the stream.
2. **Per-destination AAD-bound credential columns (`ADR candidate`):** Rather than storing per-destination secrets in a shared JSON blob in `system_settings` (which risks cross-destination RMW races and version skew), credentials live on `siem_destinations.{ca_enc,client_cert_enc,client_key_enc,auth_secret_enc}` sealed with AAD `siem_destinations.<slot>:<publicId>:v<version>:<endpointKey>` and guarded by `endpoint_generation` on `siem_outbox`.
3. **Strict per-destination FIFO vs head-of-line delay (`ADR candidate`):** `siem_outbox` enforces strict head-of-line FIFO per destination so security audit trails arrive in causal order during transient blips, bounded by `maxAttempts` + circuit breaking so poison/unreachable destinations transition cleanly to `dead_letter` / `open` circuit.
