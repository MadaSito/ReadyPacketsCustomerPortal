# SAML 2.0 single sign-on with Microsoft Entra ID

For administrators. Settings are under **Administration → Single sign-on** (`/admin/sso`). Changing them needs a
recent step-up verification. Local sign-in with MFA always keeps working, so a local administrator can always get in.

## Before you start

- In Entra ID, create an **Enterprise application** (non-gallery) and choose **SAML** as the single sign-on method.
- In the portal, select **SAML 2.0** as the protocol and enter your directory (tenant) ID. Multi-tenant values such as
  `common` are refused.

## Values to copy into Entra

The SSO page shows these with copy buttons. `<origin>` is the portal's public address.

| Entra field | Portal value |
| --- | --- |
| Identifier (Entity ID) | `<origin>/api/identity/saml/metadata` (or the Identifier override you set) |
| Reply URL (Assertion Consumer Service URL) | `<origin>/api/identity/saml/acs` |
| Sign on URL | `<origin>/api/identity/saml/start` |

Leave **Relay State** and **Logout URL** empty; v1 supports neither. The portal's own SP metadata can be downloaded
from the Identifier URL.

## Required claims

Keep these claims in **Attributes & Claims** (Entra sends them by default):

- `http://schemas.microsoft.com/identity/claims/objectidentifier` — how accounts are linked. E-mail is never used for linking.
- `http://schemas.microsoft.com/identity/claims/tenantid` — must match the configured tenant.
- `http://schemas.microsoft.com/claims/authnmethodsreferences` — used by the MFA mode "claim".

Optional: `emailaddress`, `displayname` (used only for just-in-time provisioning), and `role` (app roles, used by
role mappings).

The response must be signed with SHA-256 (the Entra default). Leave **token encryption** off; encrypted assertions are
refused in v1.

## Signing certificate and metadata

- Paste the **App Federation Metadata URL** into **Import metadata**, or download **Certificate (Base64)** and add it.
- SAML cannot be enabled until at least one trusted certificate exists.
- Rollover: add the new certificate in Entra as inactive, add it in the portal (two trusted certificates may exist),
  make it active in Entra, then retire the old one in the portal.
- A daily job checks the metadata and certificate dates and raises operations alerts at 30 days (warning), 7 days
  (error), 1 day and on expiry (critical). The metadata host must be allowed by the `entra_oidc` egress preset
  (Integrations → Egress).

## MFA modes

| Mode | Behaviour |
| --- | --- |
| claim (default) | Entra MFA is accepted only when the response shows it (`multipleauthn`, or an accepted AuthnContext you list). Otherwise the portal asks for its own MFA. |
| entra | The portal never asks for its own MFA after an Entra sign-in. To select it, type `ENTRA MANAGES MFA`; the change is audited as a warning. |
| portal | The portal always asks for its own MFA after an Entra sign-in. |

Recommendation: whatever mode you use, add an Entra **Conditional Access** policy that requires MFA for this
application. It is required in practice for the "entra" mode. Changing to a stricter mode signs out current Entra
sessions.

## Allowed roles and role mappings

- **Allowed roles** chooses which portal roles may sign in with SSO. New configurations allow administrators and staff;
  add customers explicitly. Removing a role signs out that role's Entra sessions.
- **Just-in-time provisioning** can create staff or customer accounts from Entra **app role** values through role
  mappings. It never creates administrators; administrators must be created locally and then linked.

## Step-up and session notes

- Step-up verification with SSO forces a fresh Entra sign-in; an older Entra session is not accepted.
- Changing the protocol cancels sign-ins in progress but keeps existing sessions. Changing the tenant signs out all
  Entra sessions.

## Troubleshooting

Refused sign-ins appear in the Audit centre as `identity.sso.callback_refused` with a reason code (for example
`TENANT_MISMATCH`, `AUDIENCE_MISMATCH`, `SIGNATURE_OR_ASSERTION_INVALID`). No SAML response, assertion or e-mail address is written
to logs or audit.
