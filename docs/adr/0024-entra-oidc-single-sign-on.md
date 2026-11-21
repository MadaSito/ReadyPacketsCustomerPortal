# 0024 — Microsoft Entra ID sign-in uses OpenID Connect with explicit account linking

Status: Accepted (2026-11-21). Supersedes the SAML part of ADR 0020.

## Context
The owner asked for Microsoft Entra ID single sign-on with real configuration fields and a clear button on
the sign-in page. The master prompt requires that enterprise sign-in never weakens local rules: no silent
linking by e-mail address, a local administrator must remain, and multi-factor assurance must be proven.

## Decision
- Protocol: OpenID Connect authorization code flow with PKCE, confidential client, against exactly one
  Entra tenant (a tenant GUID; `common`, `organizations` and `consumers` are refused). SAML is not offered.
- The external identity is the pair (tenant id, object id). E-mail addresses are never used to find or
  link an account. Linking is an explicit, audited act by the signed-in user after step-up or by an
  administrator. Just-in-time provisioning is off by default, bounded by an Entra app-role mapping, and can
  never create an administrator.
- An Entra sign-in is treated as multi-factor only when the validated ID token carries `amr` with `mfa`
  and the administrator enabled trust in Entra MFA; otherwise the portal's own second factor is required.
- At least one active local administrator with local MFA must always exist. Changes that would break this
  are refused.
- `state`, `nonce` and the PKCE verifier are kept on the server, are single-use and short-lived. Signing
  keys are fetched through the egress policy. No token appears in a URL after the callback or in any log.

## Consequences
Customers of other tenants cannot use SSO in this release. The feature is off until an administrator
configures it. It has been tested only against a local identity-provider fake.
