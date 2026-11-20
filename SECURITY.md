# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**. Do not open a public issue, pull request or
discussion that contains vulnerability details.

- Preferred: GitHub **Security → Report a vulnerability** on this repository (private security advisory).
- Include: affected version or commit, deployment profile, a description of the impact, and minimal
  reproduction steps. Use synthetic data only; never send real customer data, credentials or session tokens.

What to expect:

- An acknowledgement of receipt, then an initial assessment, as soon as maintainers can triage it. We do not
  publish a guaranteed response time.
- We will keep you informed while a fix is prepared, coordinate a disclosure date with you, and credit you in
  the advisory if you wish.

Please act in good faith: avoid privacy violations, data destruction and service degradation; test only
against your own installation or a deployment you are authorised to test; and stop and report as soon as you
reach data that is not yours.

There is **no bug bounty programme**, and no reward is promised for reports.

## Supported versions

The portal is pre-1.0 and self-hosted. Security fixes are made on the `main` branch and shipped in the next
release.

| Version | Supported |
| --- | --- |
| Latest release on `main` (0.x) | Yes |
| Older 0.x releases | No — upgrade to the latest release |

Operators are responsible for applying releases to their own installations. Release notes in
`CHANGELOG.md` mark security fixes.

## Scope notes

- The `preview` deployment profile is a sandboxed demonstration with synthetic data only. It intentionally
  relaxes host, framing and CORS controls (see `docs/adr/0002-sessions-and-preview-transport.md`) and must not
  hold real data; reports that rely solely on those documented relaxations in `preview` are out of scope.
- Optional integrations (SAML, SMTP, Stripe, PostHog, Clarity, SIEM destinations, …) are off by default.
  Their security also depends on the operator's configuration of the external service.

This policy describes how we handle reports. It is not a certification or a guarantee of security.
