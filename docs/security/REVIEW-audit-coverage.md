# Cross-module audit and logging coverage review

Reviewer: audit engineer. Date: 2026-11-20. Scope: every state-changing tRPC mutation and HTTP route in
identity, assurance, orders, files, engagement, compliance, siem, platform, jobs, portable, backup,
integrations, http/trpc, plus the audit module itself.

Method (read-only outside `server/modules/audit/**` and `server/observability/**`):

1. Enumerated every `.mutation(` in `server/modules/*/router.ts` and mapped each one to its service method (163 mutations).
2. Resolved each method's `audit.record` / `audit.note` calls, following module-local helpers (for example
   `factors.ts record()`, `files event()`, `jobs mailAudit()/jobAudit()`, `identity admin setStatus()`), and read
   the transaction around each write.
3. Read the denial and failure paths (throws inside transactions, rate limits, capability checks).
4. Grepped every logger call for raw error, body, header and credential fields, and checked `serialiseError`.
5. Traced the correlation id from request context to job row, mail row, audit envelope and SIEM projection.

Legend:
- **D** = durable `audit.record` in the same transaction as the change.
- **D\*** = durable but outside the change transaction. This is intentional for denials, because the change transaction rolls back.
- **N** = best-effort `note()`.
- **—** = not audited.
- "Verified" means checked by reading source at the commit below. It does **not** mean tested, unless a module
  test is cited by its owner.

Working-tree caveat: engagement, compliance (partially), siem and integrations had uncommitted edits at review
time. The findings for those modules apply to the working tree as read on 2026-11-20 and need one re-check after
their owners report done.

## Envelope changes made during this review (audit module)

| Change | Why | Commit |
|---|---|---|
| Attribute keys normalised lower-camelCase → snake_case (`fromStatus` → `from_status`) | Orders, engagement and compliance used camelCase keys, which `ATTRIBUTE_KEY_RE` **silently dropped** (e.g. `order.status.changed` lost `fromStatus/toStatus/workflowVersion`) | 511287f |
| Secret/PII-shaped keys keep **boolean** values only | Flags such as `password_updated`, `secret_key_updated`, `webhook_secret_updated`, `secrets_included`, `must_change_password`, `allow_private_network` were dropped by the denylist | 511287f |
| External projection allowlist (`EXTERNAL_ATTRIBUTE_KEYS`) | IDs, references (`previous_reference`/`new_reference`), owner public ids, amounts and slugs no longer leave the host. Booleans and fixed-vocabulary keys still do. Withheld values are counted in `dropped_attributes` | 511287f |
| Every checkpoint (manual, scheduled, retention) emits `audit.checkpoint.created` with `checkpoint_seq` + `head_link_hmac_sha256` in the same transaction, both externally forwarded | Scheduled and retention checkpoints previously had no event, so nothing carried the head link off-host | 2cd591a |
| Forwarder read (`readEventsAfter`) separates authenticated `pruned` from `missing` (no or invalid tombstone, chain gap, head overrun) and reads through retention-only windows | SIEM consumer stalled on retention-only pages and could not tell pruning from loss | 511287f, 0abbc41 |

## Per-module coverage

Rows list mutation → event(s) → durability. "Denials" lists how refusals are recorded.

### identity (owner: identity_engineer)

| Mutation | Event(s) | Dur. | Verified |
|---|---|---|---|
| auth.register | `auth.register.requested` (both branches, enumeration-safe) | D | auth.ts:232,255 |
| auth.signIn | `auth.login.failed` (denied, reason UNKNOWN_ACCOUNT/BAD_PASSWORD/ACCOUNT_INACTIVE/WRONG_AUTH_SOURCE) / `auth.login.succeeded` | D\* / D | auth.ts:283,307 |
| auth.verifyEmail | `auth.email.verified` | D | auth.ts:334 |
| auth.resendVerification | `auth.email.verification_sent` | D | auth.ts:363 |
| auth.requestPasswordReset | `auth.password.reset_requested`, `auth.password.reset_dispatch` | D | auth.ts:384,410,431 |
| auth.resetPassword | `auth.password.reset_completed` | D | auth.ts:463 |
| auth.activateAccount | `auth.account.activated` | D | auth.ts:506 |
| auth.changePassword | `auth.password.changed` (+ sessions_revoked) | D | auth.ts:549 |
| auth.signOut | `auth.logout` (record, falls back to note) | D/N | auth.ts:576–585 |
| me.update / sessions.revoke / revokeOthers | `identity.profile.updated`, `auth.session.revoked`, `auth.session.revoked_all` | D | admin.ts:411,421,431 |
| customers.create / resendInvitation / setStatus / changeReference / revokeSessions | `admin.customer.created`, `admin.user.invitation_sent`, `admin.customer.{status event}` (from/to status), `admin.customer.reference_changed`, `auth.session.revoked_all` | D | admin.ts:203–346 |
| staff.create / resendInvitation / changeRole / setStatus | `admin.staff.created`, `admin.user.invitation_sent`, `admin.staff.role_changed`, status event | D | admin.ts:360–391 |
| admin customer search / view (reads) | `admin.customer.searched`, `admin.customer.viewed` | **N** | admin.ts:236,256 |
| Denials | `authz.access.denied` (admin.ts:60), tRPC middleware denials | D\* | |

Gaps: I-1 to I-5 below.

### assurance (owner: assurance_engineer)

All 15 mutations are covered through `factors.ts record()` (security category, same transaction):
- TOTP: `auth.totp.enrollment_started|enrolled|replaced|disabled|replay_denied`
- Recovery codes: `auth.recovery_codes.acknowledged|reissued|regenerated` and `auth.recovery_code.redeemed`
- MFA and step-up: `auth.mfa.verified|challenge_denied` and `auth.step_up.verified|denied`
- Passkeys: `auth.passkey.registered|renamed|removed|manage_denied|counter_regression`
- Admin (admin.ts:15–106): `admin.credentials.set_link_queued|temporary_generated|temporary_set|mfa_reset|denied`

`beginTotpEnrollment`, `beginPasskeyAuthentication` and `beginPasskeyRegistration` issue challenges only. They write
no account state except enrollment start, which is audited, so this is acceptable. No secrets appear in attributes;
the temporary password is returned, never audited.

Gap: A-1 (throttle refusals are not recorded).

### orders (owner: orders_engineer)

| Mutation | Event(s) | Dur. | Verified |
|---|---|---|---|
| catalog.createGroup/updateGroup/createProduct/updateProduct | `catalog.group.changed`, `catalog.product.changed` | D | catalog.ts:180,255 |
| workflows.create/publish | `workflow.changed` | D | workflows.ts:96 |
| sharing.invite/revoke/respond | `order.share.invited|revoked|accepted|declined` | D | sharing.ts:145,183,266 |
| orders.create | `order.created` | D | orderService.ts:322 |
| orders.update/addNote/transition/setLock/changeReference/reassign | `order.updated`, `order.note.added`, `order.status.changed` / `order.transition.denied`, `order.lock.changed`, `order.reference.changed`, `order.reassigned` / `order.reassign.refused` | D | orderService.ts:544–860 |
| Denials | `authz.order.denied`, queued off-transaction so the pool cannot self-deadlock | D\* (async when in-tx) | policy.ts:110–130 |

Gap: O-1 (camelCase keys; now normalised, but should be fixed at the source).

### files (owner: files_engineer)

| Mutation / route | Event(s) | Dur. | Verified |
|---|---|---|---|
| upload (HTTP) | `file.uploaded` / `file.imported`, `file.upload.denied` | D | index.ts:358,169 |
| issueDownloadTicket | `file.download.ticket_issued` | D | index.ts:574 |
| download (HTTP) | `file.download` attempted/denied, `file.download.result`, plus file_access_log row | D | index.ts:176–183 |
| setVisibility/remove/restore | `file.visibility.changed`, `file.removed`, `file.restored` | D | index.ts:386 |
| setTypeRules | `file.rules.changed` | D | index.ts:648 |
| retention purge (job) | `file.retention.purged` attempted (pre-tx) then completed (in-tx, before unlink) | D | index.ts:413–426 |
| export open | `file.export.open` | D | index.ts:551 |

Gaps: F-1, F-2.

### jobs (owner: jobs_engineer)

The admin actions cancel/retry/acknowledgeUnknown/resend/capture/setMaintenance record `job.*` through
`jobAudit`, `job.mail.resend.queued`, `job.mail.capture.viewed`, `job.maintenance.changed` and `job.admin.denied`
(D, admin.ts:65,117; mail.ts:160,169).

The queue lifecycle records `job.enqueued|claimed|completed|failed…` through `jobAudit` with the job's
`correlationId` (queue.ts:75–80,171). The mail lifecycle records `job.mail.enqueued|sending|captured|expired`
(mail.ts:133–246).

J-1 fixed in b0b80be.

### platform (owner: platform_engineer)

| Mutation | Event(s) | Dur. | Verified |
|---|---|---|---|
| settings.update / features.set | `platform.setting.changed` / `platform.feature.changed` (old/new only when safe scalar, otherwise `value_changed`) | D | settingsStore.ts:185–200 |
| settings.setSecret | `platform.secret.changed` (`configured` flag, version; never the value) | D | settingsStore.ts:298 |
| presentation image upload/delete | `platform.presentation.image.uploaded|deleted|refused` | D | presentation.ts:134–242 |
| config export / importPreview / importApply | `platform.config.exported`, `platform.config.import.previewed|refused`, `platform.config.imported` (`secrets_included` flag now kept) | D | configTransfer.ts:204–403 |
| re-encrypt (job) | `platform.crypto.reencrypt.batch|reset` | D | reencrypt.ts:120,172 |
| schema contract refusal (boot) | `platform.schema.contract.refused` | N (no DB yet: acceptable) | module.ts:359 |

No gaps. Note: `old_value`/`new_value` of settings stay local. They are not on the external allowlist; `setting_key` is.

### siem (owner: siem_engineer)

The destination lifecycle create/update/setEnabled/delete/test records `siem.destination.created|updated|enabled|disabled|deleted|test`.
Dead-letter replay/purge records `siem.dead_letter.replayed|purged`. These are D (index.ts:598,790,882,943,978,1239,1282).
Delivery records `siem.delivery.dead_lettered|circuit_opened` (D), and `siem.spool.saturated` is N.
Denials go to `authz.access.denied` (index.ts:284).

Gap: S-1 (consume the new `pruned`/`missing` counts).

### portable (owners: portable_contract_engineer / portable_ops_engineer)

- startExport records `portable.export.requested|prepared` (D).
- download, publish and expiry record `portable.export.download|published|expired` (D).
- verifyAndPlan records `portable.import.verification_refused` (D).
- approve, cancel and accept go through the ledger `portable.import.transition` (D, importLedger.ts:52).
- Per-record import events: `portable.import.record` (importWorker.ts:94).
- Denials: `portable.authorization.denied` (transferPolicy.ts:47).

No gaps found.

### backup (owner: recovery_ops_engineer)

- trigger records `backup.archive.requested|refused`. The job records `backup.archive.completed|failed`.
- verify records `backup.verify.completed|failed` from the direct path with actorUserId.
- restoreIsolated records `backup.restore.requested|refused|failed`, plus the continuity marker.
- Retention policy changes record `backup.retention.policy_changed`; runs record `backup.retention.executed`.
- Holds record `backup.legal_hold.created|released`.
- Archive download records `backup.archive.downloaded`.

All are D (index.ts:517–2164). Gap: B-1 (needs owner confirmation).

### integrations (owner: integrations_engineer)

- smtp update/test records `integration.smtp.updated|tested`. The test outcome maps accepted → completed, rejected → failed, else unknown, with reasonCode (smtp.ts:518–526).
- analytics/stripe update records `integration.analytics.updated` and `integration.stripe.updated`.
- SAML records `integration.saml.scaffold_updated|enable_refused`.
- Egress rules record `integration.egress.rule_created|updated|deleted|checked`.

All are D. The `secret_key_updated` and `password_updated` flags are now kept. Egress refusals at runtime record
`integration.egress.denied` (N, egress.ts:546). This is acceptable as a high-volume runtime signal; the configured
rule changes themselves are D.

### engagement (owner: engagement_engineer, working tree)

Messages:
- send records `engagement.message.sent` (D).
- markRead and markAllRead are not audited. This is acceptable: they are informational, per-user read markers.

Tickets:
- create, reply, close, reopen and adminSetStatus record `engagement.ticket.created|replied|status.changed` (D).
- adminAssign records `engagement.ticket.assigned`; adminSetPriority records `engagement.ticket.priority.changed`.
- Denials record `authz.engagement.denied`.

Notifications:
- Preference changes record `engagement.notification.preferences.updated`.
- Retention records `engagement.notifications.retention.purged`.

Search records `engagement.search.executed`. Imports record `engagement.{message,ticket}.imported`.

Gap: E-1.

### compliance (owner: compliance_engineer, working tree)

- Policies record `policy.accepted` and `policy.document.created|updated`.
- Policy versions record `policy.version.draft_saved|draft_deleted|published`.
- Intake records saveDraft/submit (`input.mode`), `intake.submission.reviewed`, `intake.questionnaire.created|updated` and `intake.version.draft_saved|published`.
- Invoices record `invoice.created|draft_updated|issued|voided`, `invoice.payment.recorded`, `invoice.refund.recorded|provider_recorded` and `invoice.downloaded`.
- Evidence imports record `compliance.evidence.imported`.

All are D. The categories that would have been invalid (`portable`, `webhook`) are now corrected to `portable_transfer` and `integration`.

Gaps: C-1, C-2.

### http / trpc (owner: http_security_engineer)

| Path | Event | Dur. | Verified |
|---|---|---|---|
| tRPC session/role/capability denial | `authz.access.denied` (attribute `procedure`) | D\* | trpc.ts:181–193 |
| step-up required | `authz.step_up.required` | N | trpc.ts:267 |
| origin / CSRF refusal | `http.origin.denied` / `http.csrf.denied` (sampled per address) | N | app.ts:129 |
| access log | `http request` log with method, route **template**, status, duration, request/trace/span ids | log | app.ts:169 |

Gap: H-1.

### audit (own module)

All 14 audit mutations are D in the same transaction:
- Search, view, pivot and stats: `audit.search.executed`, `audit.event.viewed`, `audit.stats.viewed`.
- Address reveal: `audit.source_address.revealed`.
- Saved queries: `audit.saved_query.*`.
- Cases: `audit.case.*`.
- Exports: `audit.export.*`, including download attempts and failures.
- Integrity: `audit.integrity.*` and `audit.checkpoint.created`.
- Retention: `audit.retention.*` and `audit.legal_hold.*`.

Retention writes `audit.retention.batch_removed` and the tombstones in the same transaction as the delete, before
the delete statement (retention.ts:201–226).

## Verified gaps and fixes (sent to owners)

| ID | Location | Gap | Concrete fix |
|---|---|---|---|
| I-1 (**fixed: 41dbec0, auth.ts:621**) | identity/auth.ts:536–538 | `CURRENT_PASSWORD_INCORRECT` is thrown inside the tx, so nothing is recorded (online guessing of the current password is invisible) | Wrap the `changePassword` transaction. On a `DomainError` with that reason, record `auth.password.change_denied` (security, denied, WARN, reasonCode) **after** rollback, outside the tx |
| I-2 (**fixed: 41dbec0, auth.ts:101 `auth.token.rejected` {purpose}**) | identity/auth.ts:326 (verifyEmail), :454 (resetPassword), activateAccount | Invalid, expired or reused link is thrown inside the tx and not recorded | Same pattern: record `auth.token.rejected` with attribute `purpose` ∈ {verify_email, password_reset, activation} and reason `LINK_INVALID` outside the tx. Never include the token |
| I-3 (**fixed: 41dbec0, sampled note**) | identity/auth.ts:58–61 | Login and high-risk throttle refusals are not recorded | Use `note()` on `auth.rate_limited` (security, denied, reasonCode `RATE_LIMITED`, attribute `category`), sampled like `http.origin.denied` |
| I-4 (**fixed: 41dbec0, admin.ts:239,259 awaited record()**) | identity/admin.ts:236,256 | Admin reads of customer PII (`admin.customer.searched/viewed`) are `note()` only | Make both durable `record()` (outside a tx is fine), awaited before returning data, so the read fails closed when audit is unavailable |
| I-5 (**fixed: 41dbec0, auth.ts:371**) | identity/auth.ts:297 | In-tx race (`locked.passwordHash !== user.passwordHash`) throws badCredentials unrecorded | Low: record `auth.login.failed` reason `CREDENTIAL_CHANGED_CONCURRENTLY` after rollback |
| A-1 (**fixed: 73083d1, policy.ts sampled note**) | assurance/policy.ts:40–45 | MFA/step-up throttle refusals are not recorded | `note()` on `auth.rate_limited` (attribute `category: "auth_high_risk"`), sampled |
| H-1 (**fixed: 6182f08, http/app.ts:320 sampled note**) | trpc/trpc.ts:171–180 | Generic tRPC rate-limit refusal leaves no trace | Sampled `note()` on `http.rate_limited` with attribute `procedure` (a path template, not input) |
| F-1 (**fixed: 25f4ead, files/index.ts:370**) | files/index.ts:367–388 | Object-level write denials (`enforceVisibility`, order write check) throw inside `currentTx` and are not recorded | Catch outside the tx and record `file.access.denied` (security, denied) like orders `policy.deny()` |
| F-2 (**fixed: 25f4ead, index.ts:402–406**) | files/index.ts:386 | `file.visibility.changed` has no from/to; a no-op delete still records `completed` | Add `from_visibility`/`to_visibility` (snake_case). Skip or record `outcome: "refused"`, reason `ALREADY_REMOVED`, for the no-op |
| J-1 (**fixed b0b80be**, verified by reading mail.ts:169) | jobs/mail.ts:62–70 | `mailAudit` hard-codes `action: "transition"`, including `job.mail.capture.viewed` (a read of mail content) | Take `action` as a parameter; use `read` for capture view |
| O-1 (**fixed: fc45501, snake_case at source**) | orders/orderService.ts:628,749 and others | camelCase attribute keys | Now normalised by the envelope; switch to snake_case at the source. `previous_reference`/`new_reference` are local-only by design |
| C-1 (**fixed: b7a524a, actorAuth.ts:20,56 outside tx**) | compliance/invoicesService.ts:148, intakeService.ts:99, policiesService.ts:120, actorAuth.ts:55 | Service-level capability and remediation denials throw `forbidden()` with no audit; only tRPC-level denials are recorded | Add a `deny(actor, reasonCode, resource)` helper recording `authz.compliance.denied` (security, denied) outside any tx |
| C-2 (**fixed: b7a524a, invoicesService.ts:1211,1428 after rollback**) | compliance/invoicesService.ts:1066–1080, 1279–1289 | Financial refusals (payment on a voided/unissued invoice, currency mismatch, over-refund) are not recorded | Record `invoice.payment.refused` / `invoice.refund.refused` (business, refused, reasonCode) after rollback |
| E-1 | engagement (working tree) | Re-check after the owner reports done | Check denial coverage on ticket reply/close by non-owners, and snake_case keys |
| S-1 (**fixed: 727a0cf, siem/index.ts:1774 durable `siem.audit.loss_detected`**) | siem consumer of `readEventsAfter` | Must use the new `pruned`/`missing` counts | Advance the cursor on empty batches when `nextCursor` changed. On `missing > 0`, record a durable `siem.audit.loss_detected` (WARN, reasonCode `AUDIT_EVENTS_MISSING`) |
| B-1 (**closed: confirmed by reading index.ts:1419–1452 — record in tx before archive update; storage delete after commit**) | backup/index.ts:2030 | Retention run request: the owner should confirm `backup.retention.executed` is written in the same tx as each deletion, before the object delete. Not verified by me | Confirm, or move the record before the delete |

## Logging checks

- Logger calls never pass request bodies or headers. The only raw `error` objects are passed in audit's own
  files (emitter.ts:106,158; exports.ts:310; retention.ts:288). They go through `serialiseError`
  (observability/redact.ts:113), which emits name and safe codes only, with message/stack only under the
  non-production debug option. Drizzle "Failed query … params" messages therefore never reach production logs.
- Other modules log `errorName` only (platform/module.ts:206, identity/sessions.ts:401, orders/orderService.ts:170).
- The HTTP access log uses the route **template**, not the raw path or query (app.ts:169). Unhandled errors log a fixed message only.

## Correlation propagation (verified by reading)

1. HTTP request → `newRequestContext` assigns `request_id`. `trace_id/span_id` come from `traceparent` only when the peer is a trusted proxy (app.ts:150–160).
2. Log lines carry `request_id`, `trace_id`, `span_id`, `correlation_id`, `parent_correlation_id` and `origin` (logger.ts:97–103).
3. Job enqueue sets `correlationId` = explicit, else request correlation, else request id (jobs/queue.ts:49,158). The worker restores it in `workerContext` (queue.ts:86–88).
4. Mail rows persist `correlationId` (mail.ts:120–123). Each delivery attempt is a job with the same correlation (mail.ts:175). Mail audit events carry it (mail.ts:68).
5. The audit envelope stores `correlation_id`/`parent_correlation_id`/`job_id`. SIEM projection keeps `correlation_id` in `ExternalAuditEvent`, and the SIEM test event sets it from the request (siem/index.ts:1015).

Not verified: end-to-end correlation through a live SMTP or SIEM receiver (no network in tests).

## Re-check status (2026-11-20)

Fixes above were verified by reading the cited lines at the listed commit; the owners report their module tests pass (I did not re-run them). Still open: E-1 (engagement re-check pending owner's done report). Web-initiated restore was removed from the backup tRPC surface by integrator decision; restore audit coverage now belongs to the operator CLI (scripts/ops/restore/**) and is not re-reviewed here.

## Not verified / limitations

- No runtime test proves any of the gaps above. Each is a source-reading finding.
- Working-tree modules (engagement, compliance, siem, integrations) were read before their final commits.
- The mutation → method mapping was generated mechanically, then read. Helper indirection deeper than four calls was read manually only for the modules listed.
- Attribute validation is per key (namespace allowlist), not per event type. A typed per-event field registry remains an ADR item.
