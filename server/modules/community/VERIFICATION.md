# Community forum verification

Owner: audit_engineer (package M, increment 04). Evidence is tagged `automated-test`, `fake-only` or `not-verified`. Nothing here is a browser, screen-reader or penetration test.

## What ran

| Suite | Result (2026-11-21) | Real components | Substitutes |
| --- | --- | --- | --- |
| `server/modules/community/community.test.ts` | 21/21 pass | Isolated MySQL via `createTestDb`, the real settings store (flag and `community.config`), the real service, text sanitiser and audit writes | Identity peer (session check, account age, role) and `engagement.notify` are fakes; the clock is `FakeClock` |
| `server/modules/audit/tap.test.ts`, `emitter.test.ts`, `module.test.ts` | 22/22, 9/9, 19/19 at commit a893529 (not re-run after later commits) | Audit tap fan-out, savepoint isolation, trigger catalogue entries | — |
| `client/src/features/community/console/console.test.tsx` | 16/16 pass | Real UI kit, React Query, step-up provider, axe in light and dark themes | All tRPC procedures are mocked; pages are rendered directly with the route title set, not through `AppRoutes` |

## Requirement and evidence

| Requirement | Evidence | Status |
| --- | --- | --- |
| Feature ships off; every member procedure refuses with `NOT_FOUND COMMUNITY_DISABLED` while off; admin procedures still work | `community.test.ts` disabled-state cases | `automated-test` |
| Stored content is sanitised on write (control characters, length, bidi overrides) and escaped on render | `community.test.ts` sanitiser cases; `console.test.tsx` shows `<img onerror>` rendered as text, no `innerHTML` | `automated-test` |
| Only `https:` links become anchors, with `rel="noopener noreferrer nofollow ugc"` | `console.test.tsx` text cases (`javascript:`, `data:`, `http:` stay text) | `automated-test` |
| Forum-spam abuse case: hourly and new-member daily limits, duplicate body within 10 minutes, link threshold for new members, held words, first-posts review, auto-hide at the report threshold | `community.test.ts` spam cases, including the edit re-moderation regression (an edit that adds links above the threshold is held) | `automated-test` |
| Archived categories are read-only (listed with `archived`, create/reply/edit refused) | `community.test.ts` archive case | `automated-test` |
| Moderator and admin capability checks (`community.moderate`, `community.manage`); customers cannot reach queue, log or settings | `community.test.ts` permission cases | `automated-test` |
| Optimistic concurrency (`expectedVersion`) and idempotency keys on create/reply | `community.test.ts` | `automated-test` |
| Moderation and admin changes are audited and logged in the same transaction | `community.test.ts` asserts the audit event for switching on, and the moderation-log rows for suspensions; the remaining actions use the same code path but are not asserted individually | `automated-test` (partial) |
| Reply notifications to subscribers (capped at 100) | `community.test.ts` against the fake `engagement.notify` | `fake-only` |
| Console pages: one `h1`, ordered headings, labelled controls, confirm before remove, Move up/down as the non-drag reorder alternative, step-up for settings | `console.test.tsx` including `pageA11y` cases in both themes (queue, remove dialog open, settings) | `automated-test` in jsdom only |
| Customer pages (`/community/**`) | Owned by ui_foundation_engineer; see their `customer.test.tsx` | not covered here |

## Not verified

- No real browser: 320 px reflow, 400 % zoom, target sizes, colour contrast, focus visibility and screen-reader output are `not-verified`. axe in jsdom does not check contrast or layout.
- Real notification delivery (in-app, e-mail) and the identity module wired end to end.
- Search uses bounded `LIKE` queries. No MySQL `FULLTEXT` index exists, and search relevance and performance on large data sets were not measured.
- Load or concurrency behaviour beyond the single-process tests; rate limits are database-count based and were not run against multiple app nodes.
