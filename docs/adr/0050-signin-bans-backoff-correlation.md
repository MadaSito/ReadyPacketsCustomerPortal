# 0050 — Sign-in bans, progressive back-off and security event correlation

Status: Accepted (2026-11-23; implemented in increment 06 and checked in the lead's QA browser run — see STATUS.md. Assumptions below remain open for owner confirmation)

## Context
The owner asked for three things:
- IP addresses that keep failing sign-in are banned;
- rate limiting backs off progressively;
- related security events are correlated.

Increment 04 added a firewall with detect/enforce modes, rate limits, manual IP blocks and a sign-in log ([ADR 0031](0031-application-protection-layer.md), [ADR 0032](0032-session-centre-and-customer-maintenance.md)). Automatic bans risk locking out the operator, a shared NAT or everyone behind a misconfigured proxy.

## Decision
- **Signals.** Identity publishes every failed and successful sign-in step to the protection port: password, MFA, recovery code, passkey, password reset and SSO callback failure. Each signal is `{ ip, accountRef? (hashed), kind, outcome, correlationId, at }` and carries no password and no clear-text e-mail.
- **Automatic bans.** The setting `protection.signin_bans` defaults to:

  ```
  {
    enabled: true,
    threshold: 10,
    windowMinutes: 10,
    banMinutes: 15,
    escalation: { factor: 4, maxMinutes: 1440, memoryHours: 24 },
    permanentAfter: null,
    countDistinctAccounts: true
  }
  ```

  Bans work independently of the firewall mode. A banned address gets the generic safe 429/403 error before any credential is examined.
- **Lock-out guards:**
  - loopback, the configured trusted proxies and allow-listed entries are never banned;
  - while the proxy trust check reports that client addresses cannot be determined, nothing is banned and the page shows a warning;
  - a successful sign-in does not clear the strikes of other accounts.
- **Ban list.** Each entry shows its reason, strikes, expiry and **Unban**.
  - **Manual bans.** "Ban this IP" (temporary or permanent, CIDR allowed) works from the list, from an incident and from an audit event.
  - **Flood protection.** The list is capped, and the oldest temporary bans go first.
  - **Break-glass.** An operator command, documented in `docs/operations`, lists and clears bans without the web UI.
- **Back-off.** Each rate-limit category gains progressive back-off.
  - Each consecutive exceeded window multiplies the wait by `factor` (default 2), up to `maxSeconds`. The wait is forgotten after `resetAfterMinutes` of good behaviour.
  - `Retry-After` is always sent, and the client shows a countdown.
  - Controls are on `/admin/protection/rate-limits`, with bounds and "restore defaults".
- **How the layers combine.** The three layers stack:
  1. the IP ban is checked first;
  2. then the category rate limit with back-off;
  3. then sign-in's per-account progressive delay, which is unchanged.
- **Correlation.** Correlation lives in the audit module, at `/admin/audit/incidents`, readable with `security.incidents.read`. Rules with editable thresholds turn recent events into incidents:
  - brute force on one account;
  - password spraying (one IP, many accounts);
  - a credential-stuffing burst;
  - distributed attempts on one account (many IPs);
  - a sign-in after many failures (possible compromise);
  - MFA fatigue;
  - repeated rate-limit hits;
  - ban evasion;
  - a privilege change followed by an export.
- **Incidents:**
  - each has a severity and a status (open, acknowledged or closed);
  - it lists the correlated events, matched by correlation id, IP, account and time window, with a timeline;
  - actions are ban IP, end sessions, and open an audit search with the filter.

  Incidents are audit events themselves and are forwarded to SIEM/syslog as `security.incident.*` and `security.ban.*`.
- **Abuse cases considered:**
  - client-IP header spoofing: only trusted proxies are believed;
  - shared NAT: the first ban is short and escalation is capped;
  - victim lock-out: bans are per IP, not per account;
  - enumeration: banned and unknown addresses get the same response;
  - ban-list flooding: the list is capped.

## Assumptions to confirm with the owner
- Automatic bans are on after upgrade with the defaults above, because the guards protect against lock-out.
- `permanentAfter` stays `null` (no automatic permanent bans) unless the owner sets it.

## As implemented

Packages J and G, as reported by the owners:

- **Pages.**
  - Bans are managed on `/admin/protection/bans`.
  - Back-off is set on `/admin/protection/rate-limits`.
  - Incidents are on `/admin/audit/incidents`.
- **Correlation.** Correlation runs every minute. Rules can be switched on or off and tuned (severity, threshold, window) with the firewall-manage permission and step-up, and severity rises one level at three times the threshold.
- **Manual bans.** Incident and audit-event bans last 15 minutes, 1 hour, 1 day, 7 days or are permanent, with a reason. The server takes the address from the events and never shows it.
- **Lead QA.** In lead QA the pages render. Ban and back-off behaviour is covered by automated tests only, because loopback is exempt in the QA set-up.

## Consequences
- Repeated failures from one address are slowed and then blocked without operator action.
- A wrongly configured proxy disables automatic bans rather than banning everyone. The page warns about it.
- Thresholds may need tuning for the owner's traffic; incidents are evidence for review, not proof of an attack.
