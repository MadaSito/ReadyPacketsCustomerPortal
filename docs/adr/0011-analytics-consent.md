# 0011 — Consent-gated analytics (Microsoft Clarity, PostHog)

Status: Accepted (2026-11-20)

## Decision
- Microsoft Clarity and PostHog are optional integrations configured by an administrator (Clarity project
  identifier, PostHog key and host). Both are off until configured and enabled.
- Neither script loads until the visitor consents. The content security policy admits the vendors' origins only
  while the integration is enabled.
- Analytics never run on authentication, security, payment or document screens, and inputs are masked. No
  personal data or record identifiers are sent as properties.
- The application works fully with both disabled; there is no build-time dependency on either vendor.
