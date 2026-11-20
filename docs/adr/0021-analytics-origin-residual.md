# 0021 — Analytics on the portal origin: quarantine and accepted residual

Status: Accepted (2026-11-20). Extends 0011.

## Context
Project instructions require the ability to configure Microsoft Clarity and PostHog. A vendor script loaded on
the portal's origin runs with that origin's authority. The session cookie is `HttpOnly`, so the script cannot
read it, but the browser attaches it to same-origin requests.

## Decision
- Both vendors are off by default. They can load only on `/privacy` and `/terms`, only for a visitor without a
  session, only after that visitor consents, and only when the URL has no query string or fragment. Consent is
  held in page memory and is never written to storage or cookies.
- The moment a vendor is about to load, the page marks its JavaScript realm as tainted
  (`client/src/lib/realmTaint.ts`). A tainted realm never renders anything other than the public Privacy and
  Terms pages: any other route, or any session change, replaces the document with a clean load.
- The content security policy admits vendor origins only on those two paths and only while a vendor is enabled.
- The administration screen states the residual risk and requires an explicit acknowledgement plus step-up
  before a vendor can be enabled.

## Accepted residual
If a visitor consents on a public page and then signs in from another tab of the same browser, the vendor
script in the first tab runs on the same origin as that session. It could issue same-origin requests that carry
the session cookie, and because the CSRF token is delivered in a script-readable cookie it could also attach a
valid CSRF token. CSRF protection therefore does not constrain same-origin vendor code. What still applies is
per-operation authorization and the step-up requirement on privileged actions; ordinary reads and ordinary
writes available to that account are exposed. Removing this residual requires serving the public pages from a
separate origin, which is what the marketing site already is.

## Consequences
The recommended configuration is analytics on `www.readypackets.com` and none on the portal. No real Clarity
or PostHog project was used in verification.
