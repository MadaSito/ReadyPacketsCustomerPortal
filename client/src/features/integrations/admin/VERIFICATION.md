# Integrations Console Verification (`client/src/features/integrations/admin`)

All views in `client/src/features/integrations/admin/**` are designed and tested against WCAG 2.2 AA (`client/src/test/a11y.tsx` `pageA11y` light and dark document scans and `expectNoAxeViolations`).

## Automated Verification

| Check | Evidence |
| --- | --- |
| Route & nav registration | `integrationsAdmin.test.tsx` verifies five `integrations.manage` admin routes (`/admin/integrations`, `/admin/integrations/smtp`, `/admin/integrations/graph`, `/admin/integrations/analytics`, `/admin/integrations/egress`) and one Platform nav entry. |
| Integrations overview (`/admin/integrations`) | `integrationsAdmin.test.tsx` (`pageA11y` light & dark + route-table check) verifies truthful live status badges, direct configuration links (`Configure Graph & SharePoint`, `Payment setup`, `Configure storage`, `File sync`, `Configure single sign-on`, `Configure e-mail`, `Manage production pipeline`, `Manage webhooks`, `Review allowlist`), and that every link `href` on the hub resolves to a registered route in `ALL_ROUTES`. |
| Microsoft Graph & SharePoint (`/admin/integrations/graph`) | `integrationsAdmin.test.tsx` (`pageA11y` light & dark + interactive tests) verifies write-only `clientSecret` handling, outbound preset readiness (`microsoft_graph` and `microsoft_upload` HTTPS:443), Graph connection & test mail probes, scoped `Sites.Selected` write & cleanup check (`verifySitesSelectedWrite`), and the Entra least-privilege runbook (`entraRunbook`). |
| Outbound allowlist & presets (`/admin/integrations/egress`) | `integrationsAdmin.test.tsx` verifies one-click provider preset switches, manual allowlist rules, validation, and dry-run check. |
| SMTP & Analytics (`/admin/integrations/smtp`, `/admin/integrations/analytics`) | `integrationsAdmin.test.tsx` verifies write-only SMTP password, port 25 client refusal, unknown test-mail outcome honesty, analytics public-ID validation, risk acknowledgement, and consent banner preview. |

Tests run in jsdom via `scripts/dev/test.sh client/src/features/integrations/admin/integrationsAdmin.test.tsx` and do not substitute for real-browser visual layout, contrast, or screen-reader walkthroughs.
