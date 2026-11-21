# `client/src/features/mail` — Public Contract & Routes

Owner: `siem_engineer` (Increment 03, Package E).

## Exported Feature Surface (`client/src/features/mail/routes.tsx`)

- `mailFeature: FeatureRoutes`
  - **Route**: `/admin/email-delivery` (`title: "E-mail delivery"`, `access: "admin"`, `capability: "mail.manage"`)
  - **Console navigation**: `{ label: "E-mail delivery", href: "/admin/email-delivery", group: "Integrations", order: 60, area: "console", access: "admin", capability: "mail.manage" }`

## Consumed Server Procedures

- **Platform settings (`trpc.platform.admin.settings.{list,update}`, `writeCapability: "mail.manage"` + step-up)**:
  - `jobs.mail.sender`: `{ fromAddress: string; fromName: string; replyToAddress: string }`
  - `jobs.mail.routing`: `{ primary: "smtp" | "graph"; secondary: "none" | "smtp" | "graph" }`
  - `jobs.mail.audit_copy`: `{ enabled: boolean; address: string }`
  - `jobs.mail.retain_content`: `boolean` (default `false`)
  - `jobs.mail.retention_days`: `number` (`0–90`, default `30`)
- **Audit mailbox verification (`trpc.jobs.mail.auditCopy.*`, `mail.manage` + step-up on mutations)**:
  - `status` (query) -> `{ verified: boolean }`
  - `requestVerification` (mutation) -> `{ queued: boolean }`
  - `confirmVerification` (mutation, `{ code: string }`) -> `{ verified: boolean }`
- **SMTP relay (`trpc.integrations.admin.smtp.{get,update,sendTest}`)**:
  - `sendTest({})` sends to the signed-in administrator's verified address only.
  - Password is write-only (`passwordConfigured` boolean readback; `undefined` retain, `null` clear, string replace).
- **Microsoft Graph mail (`trpc.integrations.admin.graph.{get,update,sendTest}`)**:
  - Single-tenant Entra `tenantId` and `clientId` GUIDs (`common`, `organizations`, and `consumers` refused), `senderMailbox`, `egressPresetEnabled` / `egressReady`, and write-only `clientSecret` (`clientSecretConfigured` + `clientSecretLast4`).
  - `sendTest({})` sends to the signed-in administrator's verified address only.
