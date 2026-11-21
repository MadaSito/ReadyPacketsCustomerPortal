# `client/src/features/mail` — Verification

Owner: `siem_engineer` (Increment 03, Package E).

## Automated Verification Run

- `scripts/dev/tc.sh 'client/src/features/mail'` — 0 TypeScript diagnostics.
- `scripts/dev/lint.sh client/src/features/mail` — 0 lint warnings/errors.
- `scripts/dev/test.sh client/src/features/mail/mail.test.tsx` — component + accessibility (`axe-core`) suite covering:
  - Route & console navigation registration (`/admin/email-delivery`, group `"Integrations"`, order `60`, capability `mail.manage`).
  - Rendering of shared sender identity, primary/secondary failover selection, SMTP relay tab, Microsoft Graph tab, audit copy verification workflow, and stored content retention with zero `axe` violations on both tabs.
  - Write-only credential discipline (neither SMTP password nor Microsoft Graph client secret is ever echoed into inputs).
  - Step-up MFA enforcement (`useStepUp().run(...)`) on every configuration save, transport test, and audit-copy verification action.
  - Client-side validation gates: SMTP port 25 rejection, secondary !== primary transport guard, Microsoft Graph multi-tenant alias (`common`) rejection, and retention window bounds (`0–90`).
  - Distinct `ErrorState` rendering when server queries fail (never disguised as unconfigured or empty state).

## Sandbox & Provider Limitations

- Tested against local Vitest tRPC / step-up mocks only. Never tested against a live SMTP relay or live Microsoft Entra / Exchange Online tenant in this sandbox (no external credentials or mailbox exist here). Operators verify live connectivity after installation using **Send SMTP test to me** and **Send Graph test to me**.
