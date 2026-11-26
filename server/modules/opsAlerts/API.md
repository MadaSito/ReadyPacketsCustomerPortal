# Operational alerts

Mount `createOpsAlertsModule` / `OpsAlertsModule` from `index.ts` as `services.opsAlerts`, `opsAlertsRouter` from `router.ts` as `opsAlerts`, and `opsAlertsFeature` from `client/src/features/opsAlerts/routes.tsx`.

## Internal producer port

```ts
type OpsAlertSeverity = "warning" | "error" | "critical";
type OpsAlertState = "open" | "acknowledged" | "resolved";
type OpsAlertSource = "stage_bundle" | "completion_job" | "automation" | "webhook" | "graph" | "file_sync" | "payment" | "certificate" | "attention";
type OpsAlertIdentity = { source: OpsAlertSource; dedupKey: string; correlationId?: string };
type EmitOpsAlert = OpsAlertIdentity & {
  severity: OpsAlertSeverity; code: string; title: string; text?: string;
  orderPublicId?: string; runPublicId?: string;
};
emit(input: EmitOpsAlert, tx?: Tx): Promise<{publicId: string; state: OpsAlertState}>;
resolve(input: OpsAlertIdentity, tx?: Tx): Promise<boolean>;
```

`dedupKey` is a stable opaque source-local identifier (1–200 ASCII letters, digits, `.`, `:`, `-`, `_`). Do not use URLs, addresses, names, secrets or raw provider IDs. Persist only its hash, unique with `source`. `code` matches `^[A-Z][A-Z0-9_]{1,63}$`. Use safe, short plain text (title max 120; optional text max 500); never include personal data, provider errors, signing or connection material. Public order/run refs are ULIDs; never pass internal numeric IDs. Audit/SIEM get only codes, IDs and correlation, not title, text, or dedup key. Use the same transaction as the terminal failure when possible; emit only on terminal failure or an intentional operational signal, not every retry.

An identical repeat returns the existing alert, preserving its state. An escalation reopens an acknowledged alert. A resolved key stays resolved; use a new incident/attempt identifier for a genuinely new failure. `resolve` returns true only on a transition, false for missing/already resolved.

For Stripe missing-webhook detection, `stripeWebhookDeliveryMissingAlert("test" | "live")` builds a payment-source warning deduplicated per environment. Payments owns the verified-webhook evidence and grace window. The alert contains no customer, charge, or endpoint identifiers.

## Console

`opsAlerts.{summary,list}` require `ops.alerts.read`. `list` accepts optional severity/source/state and a bounded keyset cursor. `opsAlerts.{acknowledge,resolve}` require `ops.alerts.manage` and transaction-time actor validation; writes are idempotent. No customer routes. `/admin/alerts` shows filters and state controls, and the `/admin` widget shows open counts by severity.

`opsAlerts.reminderConfig` is admin-only; `updateReminderConfig` additionally requires fresh MFA step-up and validates that context again inside its audited write. On `/admin/alerts`, settings `orders.attention_alerts_enabled` (false by default) and `orders.attention_alert_hours` (48 by default, allowed 1–8760) control a daily fenced queue sweep. Enabled sweeps create one warning per waiting episode for either attention type, with no customer email. Acknowledging or dismissing a warning does not reissue it within the same waiting episode. Disabling reminders stops new warnings but does not clear existing ones; resolve them in the console after review.

## Phase mail and scheduler

`mailTemplates.listForPhaseActions` (admin / `workflows.manage`) returns `{ templateKey, name, vars }[]`, projecting only compatible published custom templates and allowed neutral system templates, including `orders.phase_update`. Supported variables: `reference`, `phaseLabel`, `statusLabel`, `link`. `services.mailTemplates.resolveForPhaseAction(templateKey, tx?)` returns a compatible published/built-in render contract or null. F should pass only the resolver's declared vars and a current order-owner user ID to the outbox.

`registerSamlMetadataCheck(jobs, handler)` from `server/modules/jobs/samlMetadata.ts` registers the daily `identity.saml.metadata_check` slot; Identity owns the handler and its configured/safe no-op behavior.
