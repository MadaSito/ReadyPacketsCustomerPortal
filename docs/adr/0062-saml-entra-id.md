# 0062 — SAML 2.0 single sign-on for Microsoft Entra ID, with MFA modes

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

## Context
The owner asked for "Enterprise SAML 2.0 SSO for Microsoft Entra ID login so admins can login", without portal MFA for SSO users whose MFA is managed by Entra ID. OIDC sign-in with Entra ID exists ([ADR 0024](0024-entra-oidc-single-sign-on.md)), and local sign-in with MFA is the base ([ADR 0003](0003-local-auth-mfa.md)). SAML XML signature handling has a history of serious vulnerabilities.

## Decision
- **One protocol per tenant.** One tenant has one active protocol, `oidc` or `saml`. Both resolve to the same identity (tenant id and object id), so account links survive a switch.
- **Library.** `@node-saml/node-saml` 5.2.0 is used behind our own wrapper (`sso/saml.ts`), which enforces every check itself. `xml-crypto` 6.4.0 and `@xmldom/xmldom` 0.8.15 or later (GHSA-x4fp-j954-r2f4) are pinned.
- **Routes:**
  - `GET /api/identity/saml/metadata`;
  - `GET /api/identity/saml/start`;
  - `POST /api/identity/saml/acs`. This is the only CSRF / Origin exemption: exact path and method, a form body of at most 256 KiB, and rate limited. It sets no session; it redirects to the existing same-origin completion step.
- **Mandatory checks:**
  - a signed assertion, with RSA-SHA256 or stronger;
  - pinned certificates, two for rollover. The metadata URL is refreshed from `login.microsoftonline.com` only;
  - issuer and tenant, audience, and destination / recipient;
  - `InResponseTo` consumed once;
  - time bounds with 2 minutes of skew;
  - the object id is required.

  Sign-on is SP-initiated only, with no single logout. Any failure gives a generic message, an audit event and a sign-in signal ([ADR 0050](0050-signin-bans-backoff-correlation.md)).
- **Who may use it.** Administrators and staff by default; customers opt in. Just-in-time accounts never become administrators, and app roles map to staff or customer only.
- **MFA modes** (`entra_mfa_mode`):
  - `claim` (recommended for new setups): no portal MFA when the assertion proves MFA at Entra (`authnmethodsreferences` contains `…/claims/multipleauthn`, or an accepted `AuthnContextClassRef`). Otherwise the portal factor is asked.
  - `entra`: Entra manages MFA, and the portal never asks SSO users. This is what the owner asked for. It can be selected for every SSO role behind a typed confirmation and is audited as a warning. The page recommends a Conditional Access policy "require MFA" for the application.
  - `portal`: always the portal factor.
- **Local sign-in and step-up.**
  - Local sign-in keeps MFA, and at least one local administrator with MFA must remain as break-glass.
  - Step-up for SSO users without a portal factor is re-authentication at Entra with `ForceAuthn`.
- **Settings page** (`/admin/sso`):
  - the protocol switch;
  - copy buttons for the Identifier, Reply URL and Sign-on URL;
  - the required claims;
  - the metadata URL or an XML upload;
  - the certificates with their expiry;
  - the MFA mode, allowed roles and mappings;
  - **Test sign-in**, which shows claim names and yes / no facts, never values.

  Certificate expiry raises alerts ([ADR 0058](0058-outbound-webhooks-and-operational-alerts.md)).
- **Proxy.** Nginx and Caddy serve the ACS and metadata paths exactly, with no redirects on HTTP or alias hosts, no body or header logging, and no caching of the ACS.
- **Not built.** IdP-initiated SAML, single logout, encrypted assertions, group-claim mapping and several tenants.

## Assumptions to confirm with the owner
- SAML is off until configured. An upgraded existing SSO configuration starts in `portal` MFA mode.
- `claim` is recommended for new setups. Choosing `entra` is the owner's explicit, audited decision, and MFA then depends entirely on the Entra tenant's policies.

## As implemented

Package N, from the owner's [identity API](../../server/modules/identity/API.md) and the lead's QA rulings:

- **Wrapper checks.** It refuses DTDs, encrypted assertions, a non-Success status and SHA-1. It requires exactly one signed assertion whose signature reference is the assertion id, which blocks signature wrapping. It also checks the issuer `https://sts.windows.net/<tenant>/`, the tenant claim, the audience, recipient and destination, the object id and a 2-minute skew.
- **Replay.** `InResponseTo` is stored as a hash in `sso_auth_requests` and consumed once. The assertion-id replay key is a hash of tenant and assertion id. A response with no stored request (IdP-initiated) is refused.
- **Not in v1.** RelayState, single logout, encrypted assertions and signed AuthnRequests.
- **MFA modes.** An upgraded existing SSO configuration starts in `portal` mode, and `claim` is recommended for new setups. `entra` needs the typed confirmation `ENTRA MANAGES MFA` and is audited as a warning. A stricter mode ends live Entra sessions.
- **Step-up.** Step-up uses `ForceAuthn`, and `AuthnInstant` must be no earlier than the start minus 2 minutes.
- **Browser binding.** The ACS is a cross-site POST that carries no cookies, so the browser binding is checked at `/sso/complete`.
- **Protocol switch.** Switching protocol disables SSO until an administrator enables it again.
- **Roles.** New configurations allow administrators and staff. Older rows with no value allow every role. Just-in-time accounts come from app-role mappings and never become administrators.
- **Certificates.** Several trusted certificates are supported, for rollover. A daily metadata check (`identity.saml.metadata_check`) raises certificate-expiry alerts at 30, 7 and 1 days.
- **Lead QA.** In a browser, the lead ran SAML round trips against a local fake IdP in all three MFA modes. No real Entra tenant was used.

## Consequences
- Administrators can sign in with their Microsoft account. Local break-glass administrators with portal MFA remain.
- With `entra` mode, a weak Conditional Access configuration in Entra weakens portal sign-in; the page says so.
