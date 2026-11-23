# Application Protection

Application Protection supplements the network firewall or CDN WAF. It starts in detect mode without custom, IP, or country blocks. Existing rate limits remain active.

## Configure and monitor

- **Rules**: Review detections before choosing individual rule groups to enforce. Custom rules use bounded literal comparisons, not regular expressions. On the narrow local administrator sign-in and MFA recovery paths, content rules only detect; IP and country policies still apply.
- **IP lists and Countries**: Use canonical IPv4 or IPv6 CIDRs, document the reason for each entry, and prefer expirations for temporary exceptions. Configure an offline country MMDB before relying on geographic enforcement. If enabling `PROTECTION_COUNTRY_HEADER=x-readypackets-country`, only a configured, trusted direct proxy can supply it. The bundled proxies strip it; a custom trusted proxy must overwrite it rather than pass through a client value. Unknown country is reported separately and is not evidence of location.
- **Rate limits**: Limits can be tuned within the shown bounds. They cannot be disabled in the console. Releasing a temporary block does not change manual IP or country policy.
- **Events**: Filter sampled detections and blocks by time, action, or rule, and match a customer’s reference to the HTTP correlation identifiers. Events are retained for 14 days and do not contain raw request bodies, query strings, or credential headers. Exports require permission and are audited.

## Sign-in bans and retry waits

Open `/admin/protection/bans` to review the address or CIDR, reason, number of strikes, and expiry. Use **Unban** to release an entry, or **Ban an IP address or range** to add a temporary or permanent entry with a reason. The app refuses ranges covering loopback, trusted proxies, an active allow-list entry, or your current address. If the page reports that the client address cannot be verified, check the trusted proxy configuration rather than overriding the warning.

Automatic bans are independent of firewall mode and default to 10 failures in 10 minutes across accounts, with a first ban of 15 minutes. With distinct-account counting enabled, traffic attributed to just one account needs twice the threshold; events with no account reference count toward the ordinary threshold. Successes do not erase other accounts’ strikes. Repeat bans multiply by four within the default 24-hour memory, up to one day. Automatic permanent bans are off by default. Consider shared network addresses before increasing durations or enabling permanent bans.

Three controls apply to sign-in. The HTTP budget governs request rate and can extend the wait across repeated exhausted windows; on `/admin/protection/rate-limits`, each category has its own multiplier, cap, and reset time. An address ban prevents credential endpoints from running while active. After a request gets through both controls, Identity can still apply its separate per-account progressive delay. None replaces MFA, and releasing one block does not remove the others. The browser surfaces the generic retry time but does not resubmit automatically.

## Recover access

Policy changes require a current administrator session and recent verification. The application refuses a proposed policy that would block the acting administrator’s address, country, or simulated management and MFA recovery requests. Before enforcing rules, ensure an operator can change the deployment configuration without relying on the portal.

If application protection is blocking recovery, set `PROTECTION_DISABLED=1` and restart the application using your normal deployment procedure. This temporarily bypasses protection rules and restores baseline rate-limit budgets; it does not bypass local authentication, MFA, or the network firewall. Correct the policy, remove the override, restart, and verify that the administrator recovery path and expected customer traffic both work.

If you know a sign-in ban is the cause, use the authorized host-side protection-bans command to list or clear it without the portal, following the deployment runbook. Clearing is audited and does not reset denied firewall rules or unrelated rate buckets. Keep the operator route available before testing restrictive settings.
