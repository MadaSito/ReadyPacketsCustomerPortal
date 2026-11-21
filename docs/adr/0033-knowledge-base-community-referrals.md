# 0033 — Knowledge base, optional community forum and referral programme

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for a knowledge base publishable to customers, a community forum that can be switched off, and referral management.

## Decision
- Knowledge and community content is sanitised rich text stored as data. Knowledge articles have drafts, versions and an audience; customers search published articles.
- The community is off by default, uses chosen display names, is rate-limited, reportable and moderated, and is not indexed.
- Referrals: one non-guessable code per customer, attribution at registration, qualification on the referred customer's first fully paid invoice, reward recorded as account credit in a ledger, manual approval by default. A discount for the referred customer is not included.

## Consequences
Community moderation is an operational duty the owner takes on when enabling it.
