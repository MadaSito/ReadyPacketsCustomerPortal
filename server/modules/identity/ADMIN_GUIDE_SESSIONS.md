# Sessions, sign-in log and access restrictions

Administrators only. Find these pages under **Console → Security**.

## Active sessions
**Console → Security → Sessions** lists every live session: person, role, sign-in method, country, device and last activity. Filter by role, method, country or person.

- **End session** ends one session. You cannot end your own current session here.
- **End all for this person** ends every session of one account except your current one.
- **End all customer sessions** signs out every customer (staff and administrators are not affected). Use it after a security incident or before maintenance.

Every forced end asks for a reason, needs a recent second-factor check, and is recorded in the audit log and the sign-in log with your name.

## Sign-in log
**Console → Security → Sign-in log** shows successful and failed sign-ins, lock-outs, sign-outs, expiries, forced ends and refused attempts. Filter by kind, person, role, method, country, exact IP address and date range. **Export CSV** (up to 5 000 rows) needs a recent second-factor check and is audited. Entries are kept for 180 days.

## Access restrictions
**Console → Security → Session restrictions**. Restrictions are off when the product is installed. When you turn them on you can set:

- maximum concurrent sessions per person (the oldest session ends first);
- idle and absolute session lifetimes per role;
- a console IP allow-list (CIDR ranges) for staff and administrators;
- a country rule (allow list or deny list) for everyone, customers only or the console only, and what to do when the country is unknown.

Saving needs a recent second-factor check. The page refuses a change that would lock out your own current address or country. Changes apply within about five seconds; sessions that break a rule end at their next request.

## Recovering from a lock-out
If an administrator is locked out by a restriction, the host operator's local administrator recovery also clears the restrictions. Setting `PROTECTION_DISABLED=1` on the server turns enforcement off until it is removed.

## Customer maintenance
While customer maintenance is active (set by the jobs console), customers cannot sign in, register or use single sign-on; they see the maintenance message instead. Staff and administrators are not affected.
