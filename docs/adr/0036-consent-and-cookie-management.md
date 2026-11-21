# 0036 — Consent before any non-essential storage, with a server-side ledger (extends 0011)

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for cookie management that supports GDPR and similar frameworks and works with Microsoft Clarity and PostHog.

## Decision
- Categories: necessary, preferences, analytics (PostHog), session replay (Clarity). Nothing non-essential loads or stores before a choice; rejecting is as easy as accepting; Global Privacy Control is honoured as a rejection.
- Decisions are recorded in a ledger with the policy version and re-asked when the policy changes or after a configurable period. Withdrawal stops the tools and removes their cookies where the browser allows.
- The administrator maintains the cookie inventory shown to users.

## Consequences
This is a technical control that supports compliance; it is not legal advice or a certification. The owner remains responsible for the policy text and for the regions they serve.
