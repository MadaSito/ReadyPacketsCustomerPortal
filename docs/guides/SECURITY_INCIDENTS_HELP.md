# Help: Security incidents (administrators)

**Audit center → Incidents** (`/admin/audit/incidents`) lists security incidents. The portal opens an incident when related security events cross a rule threshold, for example many failed sign-ins for one account or a successful sign-in right after many failures. You need the *security incidents* permission (administrators).

## Working an incident

1. Open an incident to see its severity, status, the accounts and addresses involved (as counts), the correlated events and a timeline.
2. **Acknowledge** it to show that someone is looking at it. New evidence still joins it.
3. Act if needed:
   - **Ban IP address** — refuses sign-ins from the address seen in the incident's events, for 15 minutes, 1 hour, 1 day, 7 days or permanently. You give a reason. The address is never shown; the server takes it from the recorded events. Release bans from the firewall page.
   - **End sessions** — signs the affected person out on every device.
   Both ask you to confirm your identity again and are recorded in the audit log.
4. **Open in audit search** shows every event of the incident's time window with the usual filters.
5. **Close** it with a reason: resolved, false positive, duplicate or accepted risk. Activity after closing opens a new incident.

If the portal cannot determine client addresses behind your proxy, a warning appears, address-based rules may miss activity and banning is paused until the trusted proxy settings are fixed.

## Rules

The **Correlation rules** card lists every rule with its severity, threshold and time window. Administrators who can manage the firewall can switch rules on or off and change the values; saving asks you to confirm your identity. An incident is raised one severity level when the activity reaches three times the threshold. Turning correlation off stops new incidents; existing ones stay.

Incidents are also sent as audit events (`security.incident.*`), so a connected SIEM or syslog receiver gets them.
