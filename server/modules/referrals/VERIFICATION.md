# Package G — Server Referrals Module Verification (`server/modules/referrals`)

## Scope
Customer referral programme service, HTTP hold cookie endpoint (`/api/referrals/hold`), tRPC router (`referrals.*`), settings schema, reward computation, anti-abuse guards, and append-only reward ledger in MySQL.

## Automated Verification Run
- **Typecheck**: `scripts/dev/tc.sh` — 0 diagnostics in `server/modules/referrals` and `client/src/features/referrals`.
- **Lint**: `scripts/dev/lint.sh server/modules/referrals client/src/features/referrals` — 0 warnings / 0 errors.
- **Integration suite (real MySQL)**: `scripts/dev/test.sh server/modules/referrals/referrals.test.ts` — **8 / 8 passed**.
- **Client UI & WCAG 2.2 AA suite**: `scripts/dev/test.sh client/src/features/referrals/referrals.test.tsx` — **13 / 13 passed** (including 10 light/dark `pageA11y` scans).

## Requirement & Abuse-Case Matrix
| Check | Test / Evidence | Result |
| --- | --- | --- |
| Ships disabled (`feature.referrals = false`) | Test 1: customer procedures refuse with `NOT_FOUND` (`REFERRALS_DISABLED`); `moduleStatus` reports `state: "disabled", healthy: true` | Passed |
| Capabilities, step-up, remediation, live actor re-validation in `tx`, fail-closed audit | Test 2: `staff` read-only (`referrals.read_all`), `admin` + fresh step-up required for `referrals.manage`, mid-session revocation/demotion inside `tx` refused via `SELECT ... FOR UPDATE` on `users` + `user_sessions`, audit throw rolls back settings/referral mutations | Passed |
| Self-referral & duplicate attribution prevention | Test 3: blocks same `userId`, `+tag` / Gmail dot canonical e-mail identity, shared `customer_ref`, non-customer referrers, and second attribution (`uk_referrals_referred_user`) | Passed |
| E-mail-my-link spam-relay defence | Test 4: fixed server template (`referral.invite`), zero customer-supplied subject/body fields, self-send block, silent existing-user suppression without enumeration oracle, per-sender burst + 24h cap, cross-customer recipient cooldown via blind index | Passed |
| Code enumeration & brute-force defence | Test 5: `publicStatus` validates format only (no DB oracle); `validateCode` throttled via `auth_high_risk` | Passed |
| Qualification, manual/auto approval, CAS version check, append-only ledger, CSV/JSON export | Test 6: `onInvoicePaid` inside payment `tx` computes fixed & capped-percentage minor-unit rewards, flags cross-currency mismatch for manual review, enforces `expectedVersion` CAS, appends `referral_reward_ledger` entries (`uk_referral_reward_ledger_ref_type`), neutralizes CSV formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`), omits customer e-mail/name PII from exports | Passed |
| First-party 30-day hold cookie (`/api/referrals/hold`) | Test 7: `POST` sets `HttpOnly; SameSite=Lax; Max-Age=2592000` (`__Host-rp_ref` on HTTPS / `rp_ref` on HTTP dev) after format validation only; `GET` returns held code; `DELETE` clears cookie | Passed |
| Qualifying first-invoice full refund -> manual review (`onInvoiceRefunded`, Part B B5 port) | Test 8: partial refunds ignored (`not_fully_refunded`), full refund moves pending or auto-approved referral into `qualified_pending_approval` with `QUALIFYING_INVOICE_REFUNDED` inside the caller's `tx`, clears uncredited `reward_approved` ledger entry, records `referral.moved_to_manual_review` audit, is idempotent on replay, flags already-credited referrals (`credited_manual_review_flagged`), and allows subsequent admin re-approval or rejection | Passed |
