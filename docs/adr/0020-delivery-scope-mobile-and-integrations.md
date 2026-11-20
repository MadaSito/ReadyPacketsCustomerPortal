# 0020 — Release scope: installable web app first; optional integrations ship disabled

Status: Accepted (2026-11-20)

## Context
The master prompt places native iOS and Android applications after the secure web rebuild. The project
instructions ask for mobile support and for accessibility on web and mobile.

## Decision
- This release delivers a responsive, installable progressive web application. The service worker caches the
  application shell only; API responses and private documents are never cached.
- Native applications are a later phase and will reuse the same API, session and step-up rules.
- SAML single sign-on, SharePoint storage and Stripe payments are present only as disabled scaffolds and are
  labelled as not available. Local accounts with mandatory TOTP remain the only sign-in method until another
  method is configured and verified.
- One supported installation path exists: `deploy/install.sh` on a single Ubuntu host with nginx, systemd and
  MySQL 8. Container files are not supported.

## Consequences
Accessibility targets WCAG 2.2 AA and is checked automatically in tests; no conformance or legal compliance
claim is made (`docs/accessibility/ACCESSIBILITY.md`).
