# 0032 — Session centre, restrictions, forced ends and a customer maintenance mode

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for session logs, session viewing, restrictions, forced session ends and a maintenance mode that keeps customers out.

## Decision
- Administrators can list live sessions of all users, search a sign-in / session log, end one session, a user's sessions or all customer sessions, and set concurrent-session limits, lifetimes per role, a console IP allow-list and country rules.
- Customer maintenance mode is separate from the background-work drain: the sign-in page shows the administrator's message, customer sign-in, registration and customer SSO are refused, staff and administrators still sign in.
- The public status endpoint exposes only whether maintenance is active, the message and the expected end.

## Consequences
A local administrator can always sign in; restrictions that would exclude the acting administrator are refused.
