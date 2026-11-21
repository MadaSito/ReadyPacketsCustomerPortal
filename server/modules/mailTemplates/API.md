# Mail Templates Module API (`server/modules/mailTemplates`)

Package D — E-mail template centre, server-side HTML sanitiser, `MailTemplateStore` resolver for `jobs`, and `email.send_template` automation action.

## Capabilities & Step-Up

- Admin authoring, preview, test delivery, version history, restore, and reset require `mail.manage` (included in `STEP_UP_CAPABILITIES`).
- Automation rule builders read published automation-safe template options through `mailTemplates.listForAutomations` gated by `automations.read`.
- Every privileged service method re-validates the actor inside the database transaction (`assertMailManageActorTx`) and records `authz.mail_templates.denied` on capability, role, status, session, or step-up denial.

## tRPC Procedures (`trpc.mailTemplates.*`)

- `list({ kind?, category?, search? })` — lists system and custom templates with status flags (`hasPublishedOverride`, `hasUnpublishedChanges`, `publishedVersionNumber`).
- `listForAutomations()` — lists published custom templates (`custom.*`) and system templates without single-use authentication secrets (`sensitiveVars.length === 0`).
- `get({ templateKey })` — returns template metadata, declared variables, active published version, working draft, built-in fallback preview, and version history.
- `createCustom({ templateKey, name, description?, category?, declaredVars, format, subject, bodyHtml?, bodyText?, deriveTextFromHtml?, changeNote? })` — creates a `custom.<slug>` template with an initial draft version.
- `saveDraft({ templateKey, expectedVersion, name?, description?, declaredVars?, format, subject, bodyHtml?, bodyText?, deriveTextFromHtml?, changeNote? })` — sanitises HTML on save, ensures plain-text alternative, and updates/creates the working draft with optimistic locking (`expectedVersion`).
- `publish({ templateKey, expectedVersion, changeNote? })` — enforces all required variables (including `sensitiveVars` on system templates) in both HTML and plain-text bodies, re-sanitises HTML, promotes the draft to published, and updates `activePublishedVersionId`.
- `resetToDefault({ templateKey, expectedVersion })` — clears `activePublishedVersionId` on a system template so delivery reverts to the built-in template while preserving version history.
- `restoreVersion({ templateKey, expectedVersion, versionNumber })` — copies a historical version into the working draft for review prior to publishing.
- `preview({ format, subject, bodyHtml?, bodyText?, declaredVars?, sampleVars? })` — renders logic-less `{{variable}}` substitutions with HTML/attribute escaping and projects the sanitised HTML through `projectInertMailPreviewHtml` (stripping external URLs, images, and active attributes) for `<InertMailPreview />`.
- `sendTestToMe({ templateKey, source?, sampleVars? })` — rate-limited (`5` per `10` minutes per actor); queues a `[TEST] `-prefixed message addressed strictly to `{ userId: actor.userId }` via `deps.mailer.enqueue`.

## Cross-Module Ports

- **`MailTemplateStore.resolve(key, tx?)`**: Registered with `deps.services.jobAdmin.registerMailTemplateStore(store)` during `init()`. Never overrides `jobs.mail.verify_audit_copy`. Re-sanitises HTML on render, escapes substituted `{{variable}}` tokens in HTML text and URL attribute contexts, enforces safe URL schemes (`https://`, `mailto:`, and `http://` only when matching `canonicalOrigin` in local development), and preserves `sensitiveVars` metadata so `jobs` can render both live messages and `[REDACTED]` audit/retained copies.
- **`email.send_template` Automation Action**: Registered via `registerAutomationAction(..., { replaceBuiltIn: true })` with `forbidOnStaffOnlyTrigger: true` and runtime `ctx.staffOnlyTrigger` default-deny (`AUTOMATION_STAFF_ONLY_TRIGGER_ACTION_FORBIDDEN`, `J-A01`). Supports both Template Centre templates (`custom.*` and non-sensitive system templates) and starter-recipe `automations.generic_notice`, refuses unpublished templates and templates with `sensitiveVars`, and propagates `automation:<runPublicId>` correlation IDs into `deps.mailer.enqueue`.
