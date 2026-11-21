# Cookies and consent

Administrator guide for the cookie banner, preference centre and consent ledger (package J, increment 04).
Console: **Platform → Cookies and consent** (`/admin/privacy`). Required capability: `privacy.consent.read`
to view; `privacy.consent.manage` (administrators, fresh verification) to change anything.

## What it does

- Visitors see a banner at the top of every page until they choose. **Reject all** and **Accept all** look the
  same; **Manage choices** opens the preference centre. Nothing is pre-ticked.
- Categories: **Necessary** (always on: sign-in session, CSRF protection, the stored choice itself),
  **Preferences**, **Analytics** (PostHog) and **Session replay** (Microsoft Clarity).
- No optional script runs and nothing optional is stored before an explicit choice. PostHog runs cookieless
  until analytics is allowed; Clarity is loaded only after session replay is allowed and is told through its
  consent API. On withdrawal both are stopped and the cookies this site can reach are removed.
- Browsers that send **Global Privacy Control** or **Do Not Track** are treated as "reject all" without showing
  the banner. The visitor can still allow tools from the footer link "Manage cookie preferences".
- Every decision is written to the consent ledger: time, a random consent id, the person's public id if they
  were signed in, policy version, choices, action, source and whether a privacy signal was present. IP
  addresses are never stored in clear (only a keyed HMAC for abuse analysis). No user agent.

## Turning it on

1. Review the cookie list (below) so it matches the tools you actually use.
2. Configure PostHog / Clarity under **Settings → Integrations** if you use them.
3. Switch on **Cookie consent banner** on **Platform → Features**. The change needs verification and is
   audited (`platform.feature.changed`).

While the feature is off, the banner is hidden, the public record endpoint refuses decisions, and optional
tools follow the integrations module's own (more restrictive) behaviour.

## Settings

| Setting | Range | Default | Notes |
|---|---|---|---|
| Cookie policy version | 1–100000 | 1 | Raise it when the policy or the cookie list changes materially. Everyone is asked again. |
| Ask again after (months) | 6–13 | 12 | A choice older than this is no longer valid; the banner returns. |
| Keep consent records for (months) | 12–72 | 36 | Months after a record was replaced by a newer choice or expired. |
| Cookie list | ≤ 100 items | 7 items | Name, provider, category, storage, first/third party, purpose, duration. Plain text only. |

All changes use optimistic versioning (the edit fails if someone else changed the value first), need fresh
verification and are recorded in the audit log.

**Retention:** you, the owner of the installation, choose the retention period that your jurisdiction and
your record-keeping obligations require. The purge job `platform.consent.purge` runs every 6 hours, removes
up to 1000 records per run and records `privacy.consent.purged` in the audit log with counts only. When an
account is erased, its public id is removed from its records (`forgetUser`); the anonymous record is kept
until retention ends.

## Statistics, search and export

- **Last 30 days**: number of decisions, share allowing analytics and session replay, and the number of
  automatic rejections from browser privacy signals.
- **Consent ledger**: filter by date, action, source, consent id or person id; 25 per page.
- **Export CSV** (verification required, rate-limited) downloads up to 10 000 matching rows. Cells starting
  with `=`, `+`, `-`, `@`, tab or carriage return are prefixed so spreadsheets do not run them as formulas.
  The export is audited (`privacy.consent.exported`, row count only).

Consent ids group one browser's decisions. The server only accepts an id back inside a receipt it signed,
so a visitor cannot attach decisions to someone else's history. A consent id is not proof of identity.

## Content Security Policy

PostHog and Clarity origins are added to the CSP only when the integration is configured; no change is
needed for the banner itself (it is served from this site).

## Troubleshooting

| Symptom | Check |
|---|---|
| Banner never appears | Feature switched on? Visitor's browser sends GPC/DNT (expected: no banner)? |
| "The cookie policy has changed" for visitors | The policy version was raised while their page was open; they choose again. |
| Third-party cookies remain after withdrawal | Cookies set on a provider's own domain can only be removed from the browser; the help article says so. |
| Purge removed nothing | Records are kept for the retention period after they were replaced or expired. |

Logs: component `platform.consent` (`consent decision recorded`, `consent receipt rejected`,
`consent records purged`), all with correlation ids and without personal data.
