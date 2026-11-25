# Increment 07 Package H verification

## Automated checks

- `scripts/dev/test.sh server/modules/opsAlerts/opsAlerts.test.ts`: concurrent deduplication, severity escalation, terminal resolution, caller rollback, safe audit payload, cursor pagination, live actor validation, content guard, default-off and enabled/fenced reminders, daily SAML slot.
- `scripts/dev/test.sh server/modules/mailTemplates/mailTemplates.test.ts`: built-in and published phase template eligibility, exclusion of unrelated, sensitive and unpublished templates, and non-admin rejection.
- `scripts/dev/test.sh server/modules/jobs/jobs.test.ts`: durable Jobs and mail regression suite.
- `scripts/dev/tc.sh`: full repository typecheck, plus scoped ESLint with `--max-warnings 0`.

## Integrated console checks

UI Foundation owns integrated browser QA. On `/admin`, follow a severity count and confirm the matching open filter on `/admin/alerts`. Check the list on mobile and desktop, use only the keyboard to change filters and acknowledge or resolve an alert, and confirm the dashboard count updates. Verify both default-off and a step-up protected settings save as admin, and confirm the reminder settings are hidden for staff. Use synthetic alerts, not vendor payloads or personal data.
