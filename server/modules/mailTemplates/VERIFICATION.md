# Mail Templates Verification (`server/modules/mailTemplates`)

## Automated Tests Executed

1. **`server/modules/mailTemplates/sanitizer.test.ts`** (13 tests):
   - Verifies strict allow-list HTML tokeniser/AST builder, dangerous container fail-closed rejection (`<script>`, `<style>`, `<iframe>`, `<svg>`, `<math>`, `<form>`, `<object>`, `<head>`), event-handler and javascript/data URI rejection, logic-less `{{variable}}` escaping in text and URL attribute contexts, plain-text derivation, and inert preview projection.
2. **`server/modules/mailTemplates/sanitizer.fuzz.test.ts`** (6 suites, including 150 deterministic PRNG seeds):
   - Closes review gates `D-S01..D-S04` from `docs/security/INCREMENT_03_REVIEW.md`: prototype-key tag/attribute payloads (`constructor`, `__proto__`, `toString`), `>2,500` node cap and `>32` depth cap (both save/render and projected preview AST), nested `<table>` rejection, split-brace placeholder injection across stripped comments/tags (`{<!-- -->{var}}`), CR entity normalization (`&#13;`), exact idempotence (`sanitize(sanitize(x)) === sanitize(x)`), and standards-HTML5 `JSDOM` parser verification that zero executable elements, `on*` handlers, or unsafe URL schemes survive.
3. **`server/modules/mailTemplates/mailTemplates.test.ts`** (5 integration suites against isolated MySQL `createTestDb`):
   - Built-in system template sync across `identity`, `orders`, `compliance`, and `engagement` while excluding `jobs.mail.verify_audit_copy`.
   - Required/sensitive variable enforcement on publish (`auth.password_reset` `{{link}}`), live + `[REDACTED]` renders via `MailTemplateStore.resolve`, and `resetToDefault`.
   - Custom template creation, draft save, publish, optimistic concurrency (`STALE_TEMPLATE_VERSION`), version history, `restoreVersion`, inert `preview`, and rate-limited `sendTestToMe` restricted to `{ userId: actor.userId }`.
   - Capability (`mail.manage`) and fresh step-up enforcement with `authz.mail_templates.denied` audit events.
   - `email.send_template` automation action execution, `automation:<runPublicId>` correlation propagation, sensitive-template refusal, and `forbidOnStaffOnlyTrigger: true` + runtime default-deny on `staffOnlyTrigger` (`AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN`, `J-A01`).

4. **`client/src/features/mailTemplates/mailTemplates.test.tsx`** (4 UI + `axe-core` suites):
   - Verifies `/admin/email-templates` catalogue filtering, custom template creation modal, editor (`RichTextEditor` + plain-text tab + variable chips + save/publish/test-send/reset/version restore), and `InertMailPreview` sandboxed rendering with zero `axe-core` violations.
5. **`client/src/features/auth/legal.test.tsx`** (10 UI + `axe-core` suites):
   - Verifies `/privacy` discloses Microsoft Graph, cloud storage copy providers (S3, Wasabi, Backblaze B2, Azure Blob, Dropbox, Google Drive, OneDrive, SharePoint), Entra ID SSO, automation webhooks, and remote copy retention with zero `axe-core` violations.

## Fakes vs Live External Services

- Database persistence, transactions, optimistic locking, blind-indexed/AEAD-encrypted user lookup, and Drizzle schema generation were verified against a real isolated MySQL instance (`createTestDb`).
- Outbound SMTP / Microsoft Graph mail transport was verified through local `deps.mailer.enqueue` outbox capture; no live SMTP server or Microsoft Graph tenant was contacted.
