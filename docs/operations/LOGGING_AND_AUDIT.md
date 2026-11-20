# Logging and audit: operator guide

This guide is for operators of a self-hosted ReadyPackets installation. There are two distinct record streams:

| Stream | Purpose | Where | Durable? |
|---|---|---|---|
| **Application logs** | Diagnostics: requests, failures, health | JSON lines on stdout (collect with your container runtime / journald) | Only as durable as your log collector |
| **Audit events** | Evidence: who did what, with outcome, tamper-evident | MySQL `audit_events` + hash chain, searchable in **Admin → Audit center**, forwardable to SIEM/syslog | Yes. Security-relevant changes commit in the same DB transaction as the change itself |

Neither stream contains passwords, tokens, TOTP seeds, e-mail bodies, raw IP addresses, request bodies or credential
headers. Free text is never stored in audit attributes. Actors, sessions, resources and source addresses appear as
keyed pseudonyms (`*_ref`).

## 1. Application log fields

One JSON object per line (OpenTelemetry-style names):

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601 UTC |
| `severity_text` / `severity_number` / `level` | OTel severity (`INFO`=9, `WARN`=13, `ERROR`=17) and the logger level |
| `body` | Fixed message (redacted, ≤ 512 chars, control characters neutralised) |
| `service_name`, `service_version`, `deployment_profile` | Installation identity and release |
| `request_id` | Per request / per job execution. Returned to clients as `X-Request-Id` and inside every error as `safe.requestId` |
| `trace_id`, `span_id` | W3C trace context. Taken from an inbound `traceparent` **only** when the peer is a configured trusted proxy (`RP_TRUSTED_PROXIES`), otherwise generated |
| `correlation_id`, `parent_correlation_id` | Business workflow id spanning request → job → mail/SIEM delivery |
| `origin` | `http`, `worker`, `scheduler`, `cli`, `test` |
| `actor_role` | Role of the authenticated actor (never the user id) |
| `error_name`, `error_code`, `reason_code`, `errno` | Error serialisation: name and safe codes only. Messages and stacks are emitted only with `RP_LOG_LEVEL=debug` outside production, and are scanned for secrets |
| other keys | Context fields, recursively redacted. Lines over the size cap keep only `attribute_keys` and set `attributes_truncated: true` |

The access log line `http request` carries `method`, `route` (the route **template**, never the raw path or query),
`status` (`499` if the client went away), `durationMs` and the ids above.

Set the level with `RP_LOG_LEVEL` = `debug | info | warn | error` (default `info`). Do not use `debug` in production.

## 2. Correlation: following one workflow

1. Copy the `requestId` the user sees in an error message, or the `X-Request-Id` response header.
2. In the audit center, search **Request ID = …**. Open the event and use the **Correlation** pivot. Alternatively, open
   `/admin/audit?correlationId=<id>` directly (30-day window).
3. The correlation id travels from the request to every job it enqueues (stored on the job row, restored in the
   worker), then to every mail row and delivery attempt. It is then stored in each audit event's `correlation_id`
   and forwarded to SIEM unchanged.
4. In your log platform, filter on `correlation_id` to see request and worker log lines together, and `job_id` for
   the attempts of one job.

## 3. Audit center (Admin → Security → Audit center)

Access requires an administrator with the matching capability. Exports, the source-address reveal, checkpoints and
retention changes also require a recent step-up (re-entering the password and MFA). Every search, view, reveal and
export is itself audited.

### Filters

- **Time window** (required). The maximum window is 400 days. Hourly statistics cover at most 14 days, and daily statistics at most 400 days.
- **ID search.** Paste a request, trace, correlation, job, event or resource id. The shape decides which fields are matched.
- **Quick filters** (ANDed):
  - category, outcome, event name (exact or prefix, e.g. `auth.`), action and reason code (exact or prefix)
  - actor role, actor reference, resource type and resource id
  - origin and source address class
- **Advanced builder.** Use AND/OR groups, nested up to 3 levels deep, with up to 30 conditions. An `in` list takes up to 25 values. Available fields: `category, event_name, action, outcome, reason_code, actor_ref, actor_role, session_ref, resource_type, resource_public_id, resource_ref, request_id, trace_id, correlation_id, parent_correlation_id, job_id, package_id, import_id, delivery_id, provider, source_address_ref, source_address_class, origin, release_ref, durability`.
- **Attribute conditions** (`attribute.<key> = value`) are not indexed. You can use at most **3** per query, and only in windows of at most **31 days**.

Useful starting queries:

| Goal | Filter |
|---|---|
| Failed or denied sign-ins | `event_name prefix auth.login` AND `outcome in (denied, failed)` |
| All access denials | `event_name in (authz.access.denied, authz.order.denied, authz.engagement.denied)` OR `outcome = denied` |
| Privilege changes | `event_name in (admin.staff.role_changed, admin.customer.status_changed, admin.staff.status_changed, admin.credentials.mfa_reset)` |
| Secret and settings changes | `event_name in (platform.secret.changed, platform.setting.changed, platform.feature.changed)` OR `event_name prefix integration.` |
| Data leaving the system | `event_name prefix audit.export.` OR `event_name prefix portable.export.` OR `event_name prefix backup.archive.` |
| Integrity problems | `event_name in (audit.integrity.break_detected, siem.delivery.dead_lettered)` |

### Saved queries, cases and exports

- **Saved searches** are per administrator. Open one with `/admin/audit/saved` or `?saved=<id>`. Only the owner can delete it.
- **Cases** group events under investigation. Events attached to an **open case** are protected from retention.
- **Exports** write JSONL, CSV or CEF to private storage. Each export has a manifest, which records:
  - `row_count`, `byte_size` and `sha256`
  - the pinned `chain_head_seq` and `snapshot_cutoff`
  - `snapshot_isolation` (one consistent database snapshot for the whole file)
  - `retention_removed_in_window`
  - `completeness`

  Exports have a few further properties:
  - The `external` profile omits user ids, resource ids, session and address references, and non-vocabulary attributes. The `local` profile keeps them.
  - Downloads expire after 7 days and only the requester can download.
  - The UI refuses a file whose size differs from the manifest.
  - CSV cells are protected against formula injection.

  Verify a downloaded file with `sha256sum <file>` against the manifest's `sha256`.

## 4. Integrity verification

- **Hash chain.** Each sealed event gets a sequence number and an HMAC-SHA256 link over the previous link and the event digest. Sealing runs every 10 s, with a daily full sweep.
- **Retention.** Retention deletions leave a **tombstone** with a keyed receipt. Pruning therefore stays verifiable, and a database-only attacker cannot pass off a deletion as pruning.
- **Verify.** Use **Audit center → Integrity → Verify**. It reports `ok`, `checked`, `pruned`, the first break (seq + reason: `SEQ_GAP`, `PREV_MISMATCH`, `LINK_MISMATCH`, `DIGEST_MISMATCH`, `EVENT_MISSING`, `HEAD_MISMATCH`, `CHECKPOINT_MISMATCH`, `CHECKPOINT_SIGNATURE_INVALID`) and `unsealedOlderThanHorizon`.
  - The stored "last verified" status changes only on a **full-chain** run. A break found by any run is always kept.
- **Signed checkpoints.** Ed25519 checkpoints are created hourly, after each retention run, and manually by an administrator with step-up. Each one emits `audit.checkpoint.created` with `checkpoint_seq` and `head_link_hmac_sha256`.

What to do on a break:
1. Do not run retention.
2. Export the affected window (local profile) and keep it.
3. Compare the off-host checkpoint copies (§5).
4. Open an audit case.

## 5. Off-host checkpoint custody

Checkpoints only help against a privileged attacker if a copy lives **outside** this host and database:

- Every `audit.checkpoint.created` event is forwarded to your SIEM with `checkpoint_seq` and
  `head_link_hmac_sha256`. Keep these events in the SIEM under a retention at least as long as the audit
  retention, ideally on write-once storage.
- Periodically (e.g. weekly) compare the latest SIEM copy with **Integrity → Checkpoints**. They must show the same seq and the same head link. Also run **Verify**: it checks that the chain row at each checkpoint seq still carries that link.
- Keep each export manifest's `sha256` and `chain_head_seq` with the exported file, in separate custody.
- `RP_AUDIT_CHAIN_KEY` derives both the HMAC key and the checkpoint signing seed. Anyone holding **both** database write access and this key can rewrite history undetectably, except by comparison with off-host copies. Therefore:
  - Store the key in your secret manager.
  - Never put it in backups next to the database.
  - Do not rotate it. Rotation is not implemented, and a mismatched key refuses sealing (fail closed).

## 6. SIEM / syslog forwarding

Configure SIEM destinations in the admin console (tRPC `siem.admin.destinations.*`; the client UI is owned by the SIEM module, so check its labels there):

| Format | Transport |
|---|---|
| `syslog_rfc5425` | RFC 5424 messages over RFC 5425 TLS (default port 6514) |
| `jsonl_tls` | One JSON object per line over TLS |
| `cef_tls` | ArcSight CEF over TLS |
| `otlp_https` | OTLP logs over HTTPS |

- **TLS.**
  - TLS 1.2 or later, with full chain and hostname verification.
  - Optional custom CA and mTLS client certificate.
  - Plaintext UDP/TCP and disabling verification are not supported.
  - Destinations must pass the egress allowlist (Admin → Integrations → Egress). Private-network targets need explicit approval.
- **Delivery.** At-least-once delivery. Deduplicate on `event_id`, and order by `(occurred_at, chain_seq)`.
  - Failed items go to dead letters, which you can replay or purge (both audited).
  - A full spool pauses projection, and no event is lost: it stays in `audit_events`.
- **Gaps.** The forwarder reports `pruned` (authenticated retention removals) and `missing` (unexplained loss: no or
  invalid tombstone, a chain gap or head overrun). Alert on any `missing > 0` and run Verify.
- **What is forwarded.**
  - The external projection: event names, categories, outcomes, reason codes, pseudonymous `actor_ref`/`resource_ref`, correlation ids, `chain_seq`.
  - Boolean attributes, and attributes with a fixed vocabulary (states, roles, formats, modes, versions, checkpoint seq and head link).
  - Withheld values are counted in `dropped_attributes`.
  - Not forwarded: user ids, resource public ids, session and source-address references, business references, amounts.
- **Test.** The destination test action (`siem.admin.destinations.test`) writes `siem.destination.test` with the request's correlation id, so you can find it in both systems.

## 7. Append-only database account (recommended)

Migrations need a separate, more privileged migrator account. Grant the **runtime** account only what it uses on the
audit tables. Adjust `` `app`@`%` `` and the schema name `readypackets` to your installation.

```sql
-- Evidence tables: no UPDATE, no DELETE (append-only).
GRANT SELECT, INSERT ON readypackets.audit_chain        TO 'app'@'%';
GRANT SELECT, INSERT ON readypackets.audit_checkpoints  TO 'app'@'%';
GRANT SELECT, INSERT ON readypackets.audit_tombstones   TO 'app'@'%';

-- Events: insert-only. DELETE is needed ONLY for in-app retention (see below). Never grant UPDATE.
GRANT SELECT, INSERT ON readypackets.audit_events TO 'app'@'%';
-- Profile A (in-app retention enabled):
GRANT DELETE ON readypackets.audit_events TO 'app'@'%';

-- Chain head (seal position, verifier status) and audit-center working tables.
GRANT SELECT, INSERT, UPDATE ON readypackets.audit_chain_head      TO 'app'@'%';
GRANT SELECT, INSERT, UPDATE ON readypackets.audit_exports         TO 'app'@'%';
GRANT SELECT, INSERT, UPDATE ON readypackets.audit_cases           TO 'app'@'%';
GRANT SELECT, INSERT         ON readypackets.audit_case_events     TO 'app'@'%';
GRANT SELECT, INSERT         ON readypackets.audit_case_notes      TO 'app'@'%';
GRANT SELECT, INSERT, UPDATE ON readypackets.audit_legal_holds     TO 'app'@'%';
GRANT SELECT, INSERT, UPDATE ON readypackets.audit_retention_runs  TO 'app'@'%';
GRANT SELECT, INSERT, DELETE ON readypackets.audit_saved_queries   TO 'app'@'%';
GRANT SELECT, INSERT, DELETE ON readypackets.audit_retention_policies TO 'app'@'%';
```

You can choose between two retention profiles:

- **Profile A (in-app retention).** As above.
  - The runtime account can delete events, but it cannot modify them.
  - It cannot remove chain rows or tombstones. Any deletion outside retention therefore shows as `EVENT_MISSING` on Verify.
- **Profile B (strict).** Omit `DELETE ON audit_events`. In-app retention runs then **fail closed**: the run is
  marked failed, nothing is removed, and a log error is emitted. A separate retention process with its own
  account is **not implemented**. Under Profile B, keep audit retention policies unset (no policy means keep forever).

These grants are documentation only. Migrations do not apply them, and they have not been tested against a live
MySQL privilege set. Apply them in staging first.

## 8. Known limitations

- Search and statistics have no database execution timeout. The bounds are the window and term limits above.
- Attribute validation is per key (allowlist and secret/PII-shape checks), not a typed schema per event.
- Session revocation is not re-checked inside every audit-center mutation; role and status are.
- Some modules still record certain denials (wrong current password, invalid links, rate limits) only in logs or not
  at all. They are tracked in `docs/security/REVIEW-audit-coverage.md`.
