# Policy acceptance gateway (Increment 04 Part B, package V / B6)

Owner: identity_engineer. Server: `acceptance.ts`, `acceptanceRouter.ts`, `acceptanceSchema.ts`. Client: `client/src/features/compliance/acceptance/`.

## Model
- Gates come from the order's pinned workflow version (`acceptanceGates`, ≤10): `{key, policyPublicId, point: "order_start" | {stepKey}, signatureMode: "checkbox" | "typed_name", askAgainOnNewVersion}`. No feature flag: a workflow version without gates is ungated.
- Evidence table `order_policy_acceptances` is append-only and holds one row per (order, user, policy version, gate key, workflow version). Each row stores the policy public id + version number, the SHA-256 of the exact text shown, the signature mode, the typed name (encrypted), the accepted time from `deps.clock`, the source address (encrypted), the user agent (≤512) and the request id.
- Acceptance is per acting user. The owner and each grantee accept separately. Staff and admins are never gated and can't record acceptances (`FORBIDDEN STAFF_NOT_GATED`).
- Only active documents whose audience is `customer`/`all` and that have a published portal version effective now can satisfy a gate. If there is none, the gate fails closed (`CONFLICT POLICY_UNAVAILABLE`, and work stays blocked).

## Enforcement
- Orders calls `registerProvider("acceptance").assertMet` from `assertCustomerMayWork` for non-staff actors. An unmet gate gives `CONFLICT ORDER_ACCEPTANCE_REQUIRED` (409). With no provider registered, orders fails closed with `UNAVAILABLE`. System/API v1 transitions are checked against the owner's acceptance. Cancellations are never gated.
- A gate is met only by a row with the same gate key, policy document, workflow version and signature mode. With `askAgainOnNewVersion` the row must also have the current version id and text hash. Evidence can't be replayed onto another order.
- `accept` re-reads the current version under `FOR SHARE`. A stale version id or hash gives `CONFLICT POLICY_TEXT_CHANGED`. A typed-name gate with no valid name gives `VALIDATION TYPED_NAME_REQUIRED`.

## API (`compliance.acceptance.*`)
| Procedure | Who | Notes |
|---|---|---|
| `forOrder {orderId}` | owner/grantee/staff with order access | gates + current policy text/hash; `blocking` |
| `accept {orderId, gateKey, policyVersionId, textSha256, typedName?}` | owner/grantee | idempotent (`duplicate`) |
| `receipt {receiptId}` | the signer, or staff with order access | never contains the source address. Customers get the generic title "Policy" once the document is inactive or no longer customer-visible |
| `console.count {orderId}` | staff/admin | tab label count |
| `console.list {orderId, cursor?, limit?}` | staff/admin | `sourceAddress` only with `sessions.read_all` (audited `order.acceptance.addresses_viewed`) |

## Audit
- `order.acceptance.recorded` (business, resource order, customer-visible in order history). Attributes: acceptance_public_id, gate_key, policy_public_id, policy_version, text_sha256, signature_mode, access. Names, addresses and typed names are never included.
- `order.acceptance.addresses_viewed` (security, staff-only).

## UI
- Customer order page banner (`orderBanners`, area customer). It shows the policy text in a keyboard-scrollable region, then the typed name, then the checkbox, then submit. After a local signing, focus moves to the next policy's text, or to the confirmation with receipt links. After a local version conflict, the message and focus carry over to the new text. Background refetches never move focus.
- Console order tab "Acceptances (n)" (key `acceptances`, order 100, staff).
- Printable receipts at `/acceptance-receipts/:receiptId` and `/admin/acceptance-receipts/:receiptId`, printed with the browser's print dialog.

## Verification
- `server/modules/compliance/acceptance.test.ts`: 13 tests. Covers cross-customer probes, replay on another order, stale hash/version, a grantee accepting separately, staff bypass, ask-again on a new version, unpublished policies, staff-only and reclassified documents (including the receipt title), and a re-pinned workflow version. Uses a fake orders gate port.
- `client/src/features/compliance/acceptance/acceptance.test.tsx`: 18 tests, including axe in light and dark for the gate, the tab and both receipt pages.
- The assembled path is covered by assurance in `tests/integration/orderAcceptance.test.ts`.
- Not verified here: real-browser print layout and 320 px rendering in a live browser.
