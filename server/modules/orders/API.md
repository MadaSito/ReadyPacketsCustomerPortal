# Orders, catalog, workflow, locks, sharing — API

Owner: orders_engineer. Status: v2. Server implementation committed; see VERIFICATION.md for what is tested.

Import types from `server/modules/orders/index.ts`; reach the instance as `deps.services.orders` **at call time**.

## 1. Access policy (the resource-authorization authority)

```ts
type OrderAccessRole = "owner" | "contributor" | "viewer" | "staff" | "admin";
type OrderWriteKind =
  | "order"      // edit order fields / notes
  | "sharing"    // manage grants (owner, or staff with orders.manage)
  | "file"       // upload / replace / delete / visibility
  | "message"    // post a message on the order thread
  | "intake"     // submit / edit intake forms
  | "invoice"    // staff-only invoice writes
  | "status";    // workflow transition
type OrderLockState = "none" | "review" | "finalized" | "legal_hold" | "imported_read_only";

interface OrderAccessView {
  id: number;                 // internal numeric id — server-side only, never send to clients
  publicId: string;           // ULID
  reference: string;          // current human-facing order reference (e.g. RP-2026-000123)
  ownerUserId: number;
  ownerPublicId: string;
  statusKey: string;
  lockState: OrderLockState;
  locked: boolean;            // lockState !== "none"
  readOnlyImported: boolean;  // lockState === "imported_read_only"
  accessRole: OrderAccessRole;
  /** Whether *this principal* may write kind=order right now (cosmetic hint for UIs). */
  canWrite: boolean;
  origin: "portal" | "import";
}

interface AccessOptions { tx?: Tx; forUpdate?: boolean }
// forUpdate (inside tx) => the order row is SELECT … FOR UPDATE and the grant re-check is a locking read
// (FOR SHARE), so a grant revoked after the caller's REPEATABLE READ snapshot is still seen. Lock order is
// always order row first, then grant rows; revocation (sharing.revoke, reassign) follows the same order.

assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string, options?: AccessOptions): Promise<OrderAccessView>
assertCanWriteOrder(principal: SessionPrincipal, orderPublicId: string, options: AccessOptions & { kind: OrderWriteKind }): Promise<OrderAccessView>
/** Same checks by internal id (for modules that stored orderId). */
assertCanReadOrderById(principal, orderId: number, options?): Promise<OrderAccessView>
assertCanWriteOrderById(principal, orderId: number, options: AccessOptions & { kind }): Promise<OrderAccessView>
/** Bounded (max 500). Customers: owned + currently accepted, unrevoked grants. Staff/admin with orders.read_all: `{ all: true }`. */
listAccessibleOrderIds(principal, options?: { limit?: number; tx?: Tx }): Promise<{ all: true } | { all: false; orderIds: number[]; truncated: boolean }>
/** Read-checked summary for cards, notifications, invoices, search hits. */
getOrderSummary(principal, orderPublicId): Promise<OrderSummary>
/** Trusted server-side lookup (no principal) — ONLY for jobs/collectors that already authorised. */
getOrderRefById(orderId: number, tx?: Tx, options?: { forUpdate?: boolean /* requires tx, else VALIDATION TX_REQUIRED */ }):
  Promise<{ id; publicId; reference; ownerUserId; lockState; statusKey } | null>
```

Rules (all re-evaluated on every call, no caching):

- Principal must be a **full** session (`state === "full"`, no pending steps), else `NOT_FOUND` (defence in depth; guards already refuse).
- Unknown id, malformed id, other customer's order, revoked/declined/pending grant ⇒ `NOT_FOUND` (`ORDER_NOT_FOUND`) — no existence oracle. Cross-tenant denials are audited `authz.order.denied` (security, denied).
- Customer read: owner, or holder of an **accepted, unrevoked** grant (viewer or contributor).
- Customer write: owner, or contributor grant, for kinds `order*`, `file`, `message`, `intake`. Viewers ⇒ `FORBIDDEN` (`GRANT_READ_ONLY`) — they can already see the order, so FORBIDDEN leaks nothing. `invoice` is never a customer write. Sharing management (kind `sharing`) and customer transitions (kind `status`) are owner-only (`FORBIDDEN OWNER_ONLY`).
- Staff: read needs `orders.read_all`. Writes need a capability per kind: order/sharing/message/intake → `orders.manage`, file → `files.manage`, invoice → `invoices.manage`, status → `orders.transition`. No read capability ⇒ `NOT_FOUND`; read but no write capability ⇒ `FORBIDDEN`.
- `ownerPublicId` comes from a join on the team-contract `users.publicId` column (read-only, no identity internals).
- Denials raised while the caller holds a transaction are queued as durable audit writes, not awaited (no second-connection wait inside a caller transaction).
- **Locks** (writes only; reads/downloads are never blocked by a lock):

  | lockState | customer writes | staff/admin writes |
  | --- | --- | --- |
  | `none` | allowed | allowed |
  | `review` | `LOCKED` (`ORDER_LOCKED`) | allowed |
  | `finalized` | `LOCKED` | allowed only for kind `status` and `invoice` |
  | `legal_hold` | `LOCKED` | `LOCKED` (all kinds; only an admin unlock changes it) |
  | `imported_read_only` | `LOCKED` | `LOCKED` (admin must explicitly convert to editable) |

  `LOCKED` errors carry `details.lockState`.

## 2. Hooks other modules call

```ts
// Portable (portable_ops_engineer)
portableOrders(tx: DbOrTx, sel: { after?: number; limit: number /* ≤ 200 */; customerIds?: number[]; orderIds?: number[] }):
  Promise<{ items: PortableOrder[]; nextAfter: number | null }>
// PortableOrder = { id, publicId, reference, retiredReferences: string[], ownerUserId, projectName, statusKey,
//   workflowKey, lockState, totalMinor, currency, createdAt, updatedAt, submittedAt,
//   lineItems: { publicId, productPublicId, productVersion, name, description, features: string[], unitPriceMinor, currency, quantity, lineTotalMinor }[],
//   statusHistory: { publicId, fromStatus, toStatus, actorRole, reasonCode, customerVisibleNote: boolean, occurredAt }[],
//   customerNotes: { publicId, body, createdAt }[] }      // internal notes and grants are NOT portable (grants are authority)
importOrder(input: ImportOrderInput, tx: Tx): Promise<{ id; publicId; reference; created: boolean;
  receipts: { lineItems: {sourcePublicId|null, publicId}[]; statusHistory: …; customerNotes: … } }>   // fresh target ids; receipts map optional child sourcePublicId
// ImportOrderInput = { importId: string; sourceInstallationId: string; sourceOrderPublicId: string; sourceReference?: string;
//   targetOwnerUserId: number /* resolved by portable mapping, re-validated here: must be an existing customer */;
//   projectName (1..160); statusKey /* must exist in the target default workflow, else VALIDATION IMPORT_STATUS_UNSUPPORTED (never guessed) */;
//   totalMinor; currency; createdAt; submittedAt?; lineItems: ImportLineItem[]; statusHistory?: …; customerNotes?: …;
//   editable?: false /* default; true only with explicit approved operation, still audited */ }
// Limits: name ≤160, description ≤2000, features ≤50×≤200, quantity 1..10000, safe-int money, ISO currency (single currency),
//   ≤200 line items, ≤500 history entries, ≤200 notes, note ≤5000. Existing link + same owner ⇒ created:false; different owner ⇒ CONFLICT IMPORT_LINK_CONFLICT.
// Behaviour: idempotent on (sourceInstallationId, sourceOrderPublicId) via order_import_provenance; dates + money preserved;
// NO workflow replay, NO notifications, NO mail; lockState = imported_read_only unless editable; reference collision ⇒
// a fresh target reference is generated and the source reference stored as provenance only; audit `order.imported` in tx.
findImportedOrder(sourceInstallationId, sourceOrderPublicId, tx?): Promise<{ id; publicId; reference; ownerUserId; lockState; createdAt; submittedAt; totalMinor; currency; importId } | null>
isPortableStatusSupported(statusKey: string, tx?): Promise<boolean>   // write-free; current default workflow or built-in default
preflightImportOrder(raw: unknown): { ok: true; input } | { ok: false; reasonCode: "IMPORT_ORDER_INVALID" | "IMPORT_CURRENCY_UNSUPPORTED" |
  "IMPORT_MIXED_CURRENCY" | "IMPORT_LINE_TOTAL_MISMATCH" | "IMPORT_TOTAL_MISMATCH"; paths: string[] }   // pure; importOrder re-runs it
checkCatalogViability(items: { productPublicId?: string; name: string; currency: string }[]): Promise<{ matched: number; unmatched: number }>
// Imported line items are snapshots — they never need a live catalog product; this is informational for dry-run plans.

// Increment 02 (packets). PortableOrder also carries subtotalMinor, discountMinor, discountLabel (string|null);
//   line items carry packetNumber (number|null), tier ("Basic"|"Standard"|"Premium"|null), outcome, timeline, deliverables {title, detail}[].
//   ImportOrderInput accepts the same fields as OPTIONAL (absent ⇒ subtotal = total + discount, discount 0, label null, no packet).
//   Preflight: subtotal − discount = total, 0 ≤ discount ≤ subtotal, Σ lines = subtotal, packetNumber/tier both set or both null.

// Production webhooks (integrations_engineer): trusted — the caller authorises first. Runs in the caller's tx, no locks.
getProductionScope(orderId: number, opts?: { tx?: DbOrTx }): Promise<{ orderId; orderPublicId; reference; ownerUserId; statusKey;
  lockState; origin; packets: { packetNumber: number; tier: "Basic" | "Standard" | "Premium" }[] /* ascending */; otherItemCount: number } | null>

// Offerings import (scripts/ops/catalog-import.ts, portable_contract_engineer)
catalog.upsertFromOfferings(actor: SessionPrincipal | { system: "ops.catalog_import" }, doc: OfferingsImportInput, opts?: { dryRun?: boolean }):
  Promise<{ dryRun; groups: { created; updated; unchanged }; products: { created; versioned; unchanged }; bundleRule: "created" | "updated" | "unchanged" | "skipped" }>
// One transaction. A session actor is re-validated in-tx (catalog.manage); the system actor is in-process only (never routed) and is
// audited as role "system". Matches groupKey/productKey; new version only when terms differ; never deletes; never changes `active`;
// writes orders.bundle_rule (enabled) when the doc has a bundle. dryRun runs every check, skips the bundle write, and rolls back.
// Errors: OFFERINGS_INVALID, OFFERINGS_DUPLICATE_KEY, GROUP_KEY_TAKEN, PACKET_NUMBER_TAKEN, PACKET_TIER_TAKEN, PRODUCT_KEY_TAKEN.

// Engagement search provider (bounded)
searchOrders(principal, query: string /* 2..64 chars */, limit ≤ 20): Promise<{ publicId; reference; projectName; statusLabel; updatedAt }[]>
```

On reassignment orders calls (inside its transaction): `services.files.reassignOrderFiles(orderId, newOwnerUserId, tx)` (which also revokes outstanding download tickets). If files is missing the method the reassignment is refused (fail closed).

Orders consumes: `services.identity.getUser(userId, { tx?, forUpdate? })` and `getUserByPublicId(publicId, { tx?, forUpdate? })`; `services.engagement.notify({ userId, kind, title, body, link, idempotencyKey, skipEmail: true })` after commit; optionally `services.compliance.assertRequiredPoliciesAccepted(userId, { audience: "customer" })` before a customer creates an order (skipped if compliance is absent). All missing required hooks fail closed (`UNAVAILABLE`).

Every mutation (create, update, addNote, transition, setLock, changeReference, reassign, sharing invite/revoke/respond, catalog and workflow writes) re-validates the ACTOR inside its transaction through `identity.sessions.assertCurrent(principal, tx)` (`actor.ts`). Revoked, expired or rotated sessions, inactive users and role changes are refused with `UNAUTHENTICATED SESSION_NOT_CURRENT`. Authority comes from the PERSISTED result: pending steps give `REMEDIATION_REQUIRED ACCOUNT_STEP_PENDING`, a persisted role lacking the capability gives `FORBIDDEN ACTOR_NOT_AUTHORIZED`, and a stale persisted step-up for step-up capabilities gives `STEP_UP_REQUIRED`. A missing identity session API fails closed with `FORBIDDEN ACTOR_UNVERIFIABLE`.
Canonical lock order (shared with files): order row only (the owner users row is NOT locked with it) → policy grant re-check FOR SHARE → users rows (ascending id; reassign locks actor and target together) → actor session → grant rows FOR UPDATE → files. The order row serializes all writers of one order. Mutations on an existing order lock the order row first. Create, catalog and workflow writes lock no order row and run the actor check as their first statement. `sharing.respond` locks order → actor (users, session) → grant, and re-reads the verified e-mail with a locking read.
Reads (O-02): `orders.get`, `getOrderSummary` and `sharing.list` authorize and project inside one `REPEATABLE READ WITH CONSISTENT SNAPSHOT` transaction (no locks; not `READ ONLY`, because Drizzle renders that combination as invalid MySQL). `searchOrders` applies the access predicate in the same statement as the match.

## 3. tRPC (`trpc.orders.*`)

| Procedure | Guard | Notes |
| --- | --- | --- |
| `catalog.list` | protected | active products of active groups, current version; groups carry `groupKey`, `packetNumber`; products carry `packetNumber`, `tier`, `outcome`, `timeline`, `deliverables` |
| `quote` | protected | `{ items }` (same shape as create) ⇒ `OrderQuote { currency, subtotalMinor, discountMinor, discountLabel, totalMinor, bundle \| null }`; same validation and pricing as create; writes nothing |
| `list` | protected | accessible orders, cursor pagination, `status?` filter |
| `get` | protected | read-checked detail: items, customer-visible history + notes, my accessRole, lock, allowed transitions for me |
| `summary` | protected | read-checked `OrderSummary` |
| `create` | protected + `orders.create` | `{ projectName, items: [{ productPublicId, quantity }], note? , idempotencyKey }`. Packet items: quantity exactly 1 (`PACKET_QUANTITY_ONE`), one tier per packet (`PACKET_TIER_CONFLICT`). Subtotal, discount and total are computed on the server and stored on the order; the client never sends amounts |
| `update` | protected | `{ orderId, expectedVersion, projectName }` write kind=order |
| `addNote` | protected | customer-visible note (staff may pass `visibility: "internal"`) |
| `transition` | protected | `{ orderId, expectedVersion, toStatus, note? }` — workflow decides who may trigger |
| `sharing.list/invite/revoke` | protected | owner (or staff with orders.manage) |
| `sharing.myInvitations`, `sharing.respond({ grantId, accept })` | protected | grantee side; verified matching e-mail required |
| `admin.list` | staff + `orders.read_all` | filters: status, customerPublicId, from/to, referencePrefix; cursor |
| `admin.get` | staff + `orders.read_all` | includes internal notes, full history, grants |
| `admin.referenceHistory` | staff + `orders.read_all` | active + retired references |
| `admin.createForCustomer` | staff + `orders.manage` | create on behalf of an active customer |
| `admin.setLock` | staff + `orders.manage` (legal_hold / unlock imported: admin) | |
| `admin.changeReference` | admin + `orders.identifiers.change` (step-up) | retired reference reserved forever |
| `admin.reassign` | admin + `orders.reassign` (step-up) | `{ orderId, targetCustomerPublicId, expectedVersion, operationId, reasonCode }` |
| `admin.catalog.*` | admin + `catalog.manage` | groups/products CRUD; price/name/description/features/outcome/timeline/deliverables change ⇒ new immutable product version. Packet placement: `packetNumber` + `tier` both set or both null and equal to the group's packet number (`PACKET_PLACEMENT_INCOMPLETE`, `PACKET_GROUP_MISMATCH`, `PACKET_TIER_TAKEN`). `bundleRule` (query) / `updateBundleRule({ rule })` (`BUNDLE_RULE_INVALID`) |
| `admin.workflows.*` | admin + `workflows.manage` | versioned definitions; orders keep their bound version |

## 4. Audit events (fixed names)

`order.created`, `order.updated`, `order.note.added`, `order.status.changed`, `order.transition.denied`, `order.lock.changed`,
`order.reference.changed`, `order.reassigned`, `order.reassign.refused`, `order.share.invited`, `order.share.accepted`,
`order.share.declined`, `order.share.revoked`, `order.imported`, `authz.order.denied`, `catalog.group.changed`,
`catalog.product.changed`, `catalog.bundle_rule.changed`, `workflow.changed`. Catalog events carry `packet_number`, `tier` and, for the import, `source: "offerings_import"`; `order.created` carries `discount_minor`.

## 5. Mail templates, settings, health

- Mail: `orders.status_changed` (vars: `reference`, `statusLabel`, `link`), `orders.share_invited` (vars: `reference`, `link`).
- Settings: `orders.reference.prefix` (default `RP`), `orders.notify.mail` (default false — in-app notifications always), `orders.sharing.invite_ttl_days` (default 14), `orders.bundle_rule` `{ enabled, requiredPacketNumbers, discountPercent, label }` (default disabled). Discount = round-half-up(subtotal × percent / 100) in minor units on the whole order subtotal, applied only when every required packet is present; capped at the subtotal.
- Health: `orders.catalog` (`not_configured` while the catalog is empty), `orders.workflow` (`failing` if no default workflow).
- Demo seed: `seedOrdersDemo(ordersModule, adminPrincipal, { currency? })` exported from `server/modules/orders/demoSeed.ts` — clearly synthetic, never run automatically, and only when the catalog is empty. For a packet demo, import the offerings file through `catalog.upsertFromOfferings` and create orders with `orders.create` using `{ productPublicId, quantity: 1 }` per packet.

## Increment 03 — workflow designer

All procedures are under `orders.admin.workflows.*`, need an admin session with the `workflows.manage` capability (re-validated in-transaction by `assertDesigner`), and are audited inside the transaction. Ids are ULID `publicId`s. Every write takes `expectedVersion` (optimistic concurrency).

| Procedure | Kind | Input | Output | Step-up |
| --- | --- | --- | --- | --- |
| `list` | query | — | `{ publicId, workflowKey, name, isDefault, rowVersion, versionNumber, currentVersionPublicId, draftPublicId, definition }[]` | no |
| `installStandard` | mutation | — | `{ installed, workflowPublicId, versionNumber }` (idempotent; audit reason `STANDARD_INSTALLED`) | yes |
| `versions` | query | `{ workflowId }` | `{ workflow, versions: { publicId, versionNumber, isCurrent, createdAt, changeNote, stateCount, transitionCount, orderCount }[] }` | no |
| `version` | query | `{ versionId }` | `{ publicId, workflowPublicId, workflowName, versionNumber, isCurrent, createdAt, definition, layout, changeNote }` (read-only) | no |
| `drafts.list` | query | — | `{ publicId, workflowPublicId, workflowKey, name, source, rowVersion, updatedAt, errorCount, warningCount }[]` | no |
| `drafts.get` | query | `{ draftId }` | `{ …draft, definition, layout, rowVersion, issues, publishable, baseVersionNumber }` | no |
| `drafts.create` | mutation | `{ from: "standard" \| "blank" \| "copy", copyVersionId?, workflowId?, workflowKey?, name? }` | `{ publicId, rowVersion }` | no |
| `drafts.save` | mutation | `{ draftId, expectedVersion, name, definition, layout? }` | `{ rowVersion, issues, publishable }` | no |
| `drafts.validate` | mutation (POST, no write, no audit) | `{ definition }` | `{ issues, publishable }` | no |
| `drafts.discard` | mutation | `{ draftId, expectedVersion }` | `{ discarded: true }` | no |
| `drafts.publish` | mutation | `{ draftId, expectedVersion, makeDefault, changeNote? (≤500) }` | `{ workflowPublicId, versionNumber, isDefault }` | yes (fresh, persisted) |

- Draft `definition`: `{ states: { key, label, customerLabel, kind: initial|active|terminal, tone }[] (≤30), transitions: { from, to, allowedBy: (customer|staff|admin)[], notifyCustomer, requiresNote, actionLabel? }[] (≤200) }`. Drafts may be incomplete; `issues` are `{ severity: "error"|"warning", code, path (e.g. "states.2.key"), message }`.
- `layout` (canvas positions): `{ nodes: { key, x, y }[] }`, integer coordinates within ±10000, pruned to existing state keys; stored per draft and copied to the published version.
- Publish: lock order users row → draft → workflow; creates a NEW immutable version (existing orders keep their bound version); the first workflow becomes default only if none exists; deletes the draft. Audit: `workflow.changed` (action `publish`, attributes `version_number`, `make_default`, `source`, `draft_id`, `warnings`) and `workflow.draft.changed` (create/update/delete).
- Error codes: `WORKFLOW_DRAFT_EXISTS` (details.draftId), `WORKFLOW_KEY_TAKEN`, `WORKFLOW_NAME_REQUIRED`, `COPY_VERSION_REQUIRED`, `STALE_VERSION`, `WORKFLOW_CHANGED_SINCE_DRAFT`, `WORKFLOW_DRAFT_INVALID` (details `issues`, `issuePaths`, `issueCodes`), `INVALID_WORKFLOW_DRAFT`, `INVALID_WORKFLOW_LAYOUT`, `WORKFLOW_DRAFT_NOT_FOUND`, `WORKFLOW_VERSION_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `STEP_UP_REQUIRED`, `ACTOR_NOT_AUTHORIZED`.
- The former direct `admin.workflows.create` / `admin.workflows.publish` procedures are no longer mounted (bc092eb). The internal service methods remain with the same gates as `drafts.publish` (admin, fresh step-up, designer validation).
- Internal ports (no principal, system callers only): `registerChangeListener(listener)` (runs in-tx after audit on create/update/setLock/changeReference/transition/reassign; a throw aborts the write), `getOrderSyncView(orderPublicId, tx?)`, `getOrderRefByPublicId(id, tx?, { forUpdate? })`, `listOrderPublicIdsForSync({ afterPublicId?, limit ≤500 }, tx?)` (ascending publicId keyset, ids only). Automation triggers `order.created`, `order.status_changed`, `order.assigned` (context `order_reference`, `order_status_label`, `order_link`).

## Increment 04 — workflow rules, phase locks, console order actions (package A, published day one; may gain fields, never lose them)

### Definition extension (published versions and drafts; all optional, so every existing version parses unchanged)

```ts
phases?: { key: Key; label: string /* ≤60 */ }[]                 // ≤12, ordered
states[n].phase?: Key                                             // must name a phase; statuses of one phase should be contiguous
states[n].requirements?: {
  uploads: { key: Key; label: string; hint?: string /* ≤200 */; kind: "document" | "audio";
             minCount: number /* 0–20 */; maxCount: number /* 1–20, ≥ minCount */;
             allowedTypes: string[] /* canonical extensions without dot, lowercase, ≤20; [] = any Files-approved format of the kind */;
             uploadedBy: ("customer" | "staff" | "admin" | "api")[] /* ≥1 */ }[];            // ≤10 per status
  acknowledgements: { key: Key; title: string /* ≤120 */; body: string /* plain text, ≤8000, no markup */;
                      acceptedBy: "customer" | "staff"; requireTypedName: boolean }[]; // ≤5 per status
}
// Key = /^[a-z][a-z0-9_]{1,47}$/ (a subset of the Files slot-key format)
```
Setting `orders.workflow_rules.enabled` (default **false**, audited by the settings registry): while off, publishing a definition that contains phases or requirements is refused (`WORKFLOW_RULES_DISABLED`); already published rules are always enforced.

### Semantics
- **Requirements** of the order's current status must be met before ANY transition out of it (`VALIDATION:REQUIREMENTS_UNMET`, details `{ uploads: string[], acknowledgements: string[] }`). Upload count = `files.countFilesInSlot(orderId, slotKey, tx, { statusKey })` ≥ `minCount`. An acknowledgement is met when a record exists for (order, version, status, key) by the required side (customer = owner or contributor; staff = staff/admin).
- **Phase lock:** a transition whose target status is in a different phase locks the phase being left (row in `order_phase_locks`). A locked phase's uploads, acknowledgements and customer-editable data are read-only. Re-entering a phase through a permitted transition reopens it (audited). Order-level `lockState` always wins.
- **Acknowledgement record** (`order_acknowledgements`, insert-only, no update/withdraw): SHA-256 of the exact `title + "\n\n" + body` shown, workflow version, status, key, user, role, session id, time, optional typed name (encrypted). IP is captured in the audit event `order.acknowledgement.recorded` under the existing audit rules (not in the table).

### tRPC
| Procedure | Who | Input | Output / notes |
| --- | --- | --- | --- |
| `orders.requirements.forOrder` (query) | anyone with read access to the order | `{ orderId }` | `{ phases: { key, label, position: "done"\|"current"\|"upcoming", locked, lockedAt }[], status: { key, label, phaseKey }, uploads: { key, label, hint, kind, minCount, maxCount, allowedTypes, count, met, canUpload }[], acknowledgements: { key, title, body, textSha256, acceptedBy, requireTypedName, met, acceptedAt, canAccept }[], unmet: number, readOnly, readOnlyReason: "order_locked"\|"phase_locked"\|null, canUnlock }` |
| `orders.requirements.acknowledge` (mutation) | required side with write access | `{ orderId, statusKey, ackKey, textSha256, typedName? (≤120) }` | `{ acknowledgementId, acceptedAt }`; `ACK_TEXT_CHANGED` if the hash differs, `ACK_ALREADY_RECORDED`, `PHASE_LOCKED`, `ORDER_LOCKED` |
| `orders.phases.unlock` (mutation) | staff/admin + `orders.phase.unlock` | `{ orderId, phaseKey, reason (10–500), notifyCustomer }` | `{ unlocked: true }`; reason stored as a staff-only encrypted note; audit `order.phase.unlocked` |
| `orders.admin.customerLookup` (query) | staff + `customers.read_all` | `{ query (2–120) }` | `{ publicId, name, customerRef, emailMasked }[]` (≤20, active customers only; the full e-mail is never returned, only a masked form such as `s***@example.com`) |
| `orders.admin.createForCustomer` (mutation) | staff + `orders.manage` | `{ customerPublicId, projectName, items, note?, idempotencyKey }` | same as `orders.create`; owner = the customer; audit `order.created` with `created_for_customer: true` |
| `orders.admin.access.list` (query) | staff + `orders.read_all` | `{ orderId } \| { customerPublicId }` | `{ items: { grantId, scope: "order"\|"customer", role, status, granteeName, granteeEmailMasked, grantedAt }[] }` |
| `orders.admin.access.grant` (mutation, step-up) | admin + `orders.access.grant` | `{ scope: { orderId } \| { customerPublicId }, email, role: "viewer"\|"contributor" }` | grantee must be an existing active customer account other than the owner (`GRANTEE_NOT_FOUND` is the same answer for unknown and ineligible); a customer-scope grant covers all current and future orders of that customer; both parties notified; audit `order.access.granted` |
| `orders.admin.access.revoke` (mutation, step-up) | admin + `orders.access.grant` | `{ grantId }` | revokes the grant (customer scope: and every order grant derived from it); audit `order.access.revoked` |
Setting `orders.console_access.enabled` (default **false**) gates `access.grant`; `createForCustomer` and reassign follow their capabilities.

### Ports for other modules
- `getFileUploadSlots(principal, orderPublicId, tx?) → { statusKey, slots: { key, label, kind, maxCount, allowedTypes }[] }` — current status of the order's pinned version; only slots whose `uploadedBy` includes the actor's side; empty when the order is locked, the phase is locked or the actor lacks write access.
- `assertFileStatusWritable(principal, orderPublicId, statusKey, tx?) → void` — throws `FORBIDDEN:PHASE_LOCKED` when `statusKey` belongs to a locked phase, `FORBIDDEN:ORDER_LOCKED` for an order lock; otherwise resolves (Files still applies its own rules).
- Both re-read the order under the caller's tx; call them after locking the order row for final mutations.
- `getFileSlotForCustody(orderPublicId, statusKey, slotKey, tx) → FileUploadSlot | null` — slot definition from the order's pinned version regardless of the caller (custody/retention checks); `null` for unknown order, status or slot.
- `isStatusPhaseLocked(orderId, workflowVersionId, statusKey, tx) → boolean` — internal ids; true when the status's phase has a `locked` row.
- `OrderRef.workflowVersionId` — the pinned version id (internal), for the call above.
- `createOrderFromCheckoutInTx(principal, { projectName, items, note?, idempotencyKey }, tx)` — checkout (cart) creates the order inside ITS transaction; customer + `orders.create`; same pricing, policy gate, requirements and audit as `orders.create`; no second connection.

### Workflow actor `api` and the public API provider
- `WORKFLOW_ACTORS = ["customer", "staff", "admin", "api"]`. `api` may appear in `allowedBy` and `uploadedBy`; the designer labels it "API integration". Only the public API (`/api/v1`, API-key callers) acts as `api`; no session ever does.
- `OrdersModule.init()` registers the `orders` provider with the public API module (`publicApiProvider.ts`): `list` (keyset, newest first, ≤100, filters `customerId`, `status`, `updatedSince`), `get`, `create` (`createAsSystem`, owner = the given customer, item `tierKey` = the product tier in lowercase or `default`, mismatch refused) and `transition` (`transitionAsSystem`, allowed only where the pinned workflow lists `api`; requirements and phase locks apply). Writes audit as `system` with the API request id as correlation id; scopes are checked by the public API module before the provider runs.


## Increment 04 part B (S1) — console order workspace

### tRPC
| Procedure | Who | Input | Output / notes |
| --- | --- | --- | --- |
| `orders.console.rename` (mutation) | staff/admin + `orders.rename` | `{ orderId, expectedVersion, name }` | `{ version, changed }`. Name is NFC and trimmed, 1–120 characters, no control characters (`VALIDATION:ORDER_NAME_INVALID`). Stale → `CONFLICT:STALE_VERSION`. The reference does not change. It bumps `updatedAt`, emits change kind `updated`, writes `order_name_history`, and records the audit event `order.renamed` `{ order_public_id, renamed, old_length, new_length }`, which never carries names. |
| `orders.admin.get` | staff | (unchanged) | adds `console: { customer: { publicId, name, customerRef } \| null, payment: { state, totalMinor, currency } \| null }` (payment comes from the registered payment-summary provider; null when none is registered). |

### Workflow definition (pinned per version)
- `acceptanceGates?: { key, policyPublicId, point: "order_start" \| { stepKey }, signatureMode: "checkbox" \| "typed_name", askAgainOnNewVersion }[]` (at most 10). Key format `^[a-z][a-z0-9_]{1,47}$`, unique; step must exist and must not be final. Designer codes: `GATE_KEY_FORMAT`, `GATE_KEY_DUPLICATE`, `GATE_POLICY_REQUIRED`, `GATE_STEP_REQUIRED`, `GATE_STEP_UNKNOWN`, `GATE_STEP_TERMINAL`. Gates count as workflow rules, so publishing needs `orders.workflow_rules.enabled` (`WORKFLOW_RULES_DISABLED`).
- `storageFolder?` on the workflow and on each upload slot: validated with `isOrderFileFolderTemplate` (shared/orderFileFolder.ts). Codes: `WORKFLOW_FOLDER_INVALID`, `UPLOAD_FOLDER_INVALID`. Precedence at copy time: slot, then workflow, then assignment default.

### Ports
- `gates` (`services.orders.gates`): `registerProvider("acceptance", { assertMet({ tx, orderId, workflowVersionId, gates, actor: { userId, role }, point }) })`. Other members:
  - `context(orderPublicId, actor, tx?)` returns `{ orderId, orderPublicId, reference, name, customerUserId, workflowVersionId, currentStatusKey, gates, actorAccess }`, or null when the actor cannot read the order.
  - `assertCustomerMayWork({ tx, orderId, actor, action, statusKey })` and `assertSystemMayWork({ tx, orderId, action, statusKey })`. The system variant checks the owner.
  - `gatesOf(definition)`.
  - Rules: staff pass. `order_start` gates always apply. A step gate applies when `statusKey ?? order.statusKey` equals its step; phase_submit passes the FROM status. Gates with no provider registered → `UNAVAILABLE:ORDER_GATES_UNAVAILABLE`. Cancellation is never gated. Orders calls the port in `transition` (customer side) and in `transitionAsSystem`.
- `getOrderFileFolderRouting({ orderPublicId, statusKey, slotKey }, tx)` returns `{ slotTemplate, workflowTemplate, phaseLabel }`, or null for an unknown order. It is trusted and reads the pinned version.
- `listStatusTransitions(orderId, { cursor, limit, customerView, tx })` returns `{ items: { at, from, fromLabel, to, toLabel, note, actorUserId, actorRole }[], nextCursor }`. It is trusted (the caller authorizes). customerView uses customer labels and only customer-visible notes.
- `listNameHistory(orderId, { cursor, limit, customerView, tx })` returns `{ items: { at, oldName, newName, actorUserId, actorRole }[], nextCursor }`. It is ordered by (created_at, id) DESC with a keyset cursor on that pair. customerView returns null names and a null actor, which shows as a generic "Order renamed".
- `registerPaymentSummaryProvider(fn: (orderIds, tx) => Promise<Map<orderId, { state, totalMinor, currency }>>)` supplies the console header payment badge.
- `OrderRef.name`: the order name, used for folder tokens.

### Client
- `FeatureRoutes.orderBanners?: OrderBanner[]` (`{ key, order, area: "customer" | "console" | "both", component({ orderId, area }) }`) renders full width between the order header and the tabs. Each banner is in Suspense with no fallback.
- `DetailTab.labelComponent?`: a live tab label, with `label` as the fallback and as the narrow-screen select text.
- Tab order: Overview 0, Phases 10 (console), Intake 20, Files 30, Messages 40, Automation 50, Sync 60, Invoices 70, Refund 80, Order history 90, Acceptances 100, Notes 105, Sharing 110. `/activity` opens Notes.

## Increment 05 — C3 discount codes on orders, A1 workflow export / import

### C3: tRPC

| Procedure | Guard | Notes |
| --- | --- | --- |
| `quote` | protected (GET) | unchanged; **does not accept** `promoCode` (a code must never travel in a URL) |
| `quoteWithPromo` | protected, rate limit `form_submission` (POST mutation) | `{ items, promoCode, forCustomerPublicId? }` ⇒ `OrderQuote & { promo: { label, promoDiscountMinor } \| null }`. `discountMinor` / `discountLabel` / `totalMinor` already include the code. Preview only: nothing is redeemed |
| `create` | as before | optional `promoCode`; redeemed by the promotions port **inside** the create transaction **before** the order row is inserted; failure ⇒ nothing written |
| `admin.createForCustomer` | as before | optional `promoCode`; eligibility is judged for the customer, never for the staff member |

- Uniform refusal: `VALIDATION PROMO_NOT_APPLICABLE` "This code cannot be applied." for every reason a code cannot be used, **including** `feature.promotions` off and the promotions module absent. Without a code nothing changes.
- An inconsistent outcome from the promotions port (negative total, wrong currency, more than the subtotal) is refused (fail closed).
- API v1 (system) order creation does not accept codes in this increment.
- `createOrderFromCheckoutInTx(tx, principal, { …, promoCode? })` (cart) returns `promoDiscountMinor` and `promoLabel`.

### C3: stored figures and views

- `orders.promo_discount_minor` (int, default 0) and `orders.promo_label` (nullable, ≤ 120 characters) are written once at create.
- Order detail and summary views expose `promoDiscountMinor` and `promoLabel`.
- `OrderAccessView` (ports) gains these optional fields: `discountMinor`, `discountLabel` (the combined label), `promoDiscountMinor`, `promoLabel` and `bundleDiscountMinor`. They are used for compliance invoices; no bundle label is stored separately.
- `catalog.listActive(tx?, { forShare? })`: pass the caller's `tx` so the read uses that connection. `forShare` adds `FOR SHARE` to the group and product reads, so a concurrent deactivation or repricing waits for the cart's transaction.
- With a code, `quote`, `create` and `admin.createForCustomer` run under the optional `promotions.guardAttempt(actorUserId, fn)` **outside** the orders transaction. That function applies the rate limits and the lockout check, and records a refusal after rollback. Checkout (a tx the caller holds) is not wrapped.
- A code that contributes nothing (the bundle wins, or the cap leaves 0) is returned as `promo: null`. The order stores no promo figures or label for it, and promotions writes no redemption.
- Portable order records carry `promoDiscountMinor` / `promoLabel` (optional on import, default 0 / null).

### C3: release on cancel (decision G-C3-02)

On cancellation the orders transaction asks `services.compliance.orderPaymentExposureInTx(tx, orderPublicId)`. It calls `promotions.releaseForOrderInTx(tx, { orderPublicId, reason: "order_cancelled" })` only when the answer is **exactly** `{ grossPaidMinor: 0, payableInvoiceOpen: false, providerCapturePending: false, providerAttemptEver: false }`. Under /root's conservative scope decision, a provider payment attempt row that has **ever** existed for the order, in any status (failed, cancelled, expired or ambiguous), keeps the code used. A missing field counts as exposure.

Any exposure, a missing port or an error keeps the redemption used, and the cancel still succeeds. A refund never releases a redemption. A manual release is `promotions.admin.releaseRedemption`, which the promotions module owns.

### C3: ports

`PromotionsPort { preview, redeemInTx, releaseForOrderInTx, isEnabled? }` and `OrderPaymentExposure` / `releaseIsSafe` are defined in `ports.ts`, matching contract §3.

### A1: tRPC `orders.admin.workflows.transfer.*`

All procedures are admin only. Customers and staff get `FORBIDDEN`, the existing `adminProcedure` behaviour. When the setting `orders.workflow_transfer.enabled` (env `ORDER_WORKFLOW_TRANSFER_ENABLED`, default **false**) is off, every step except `status` fails with `FORBIDDEN WORKFLOW_TRANSFER_DISABLED`.

| Procedure | Capability | Input ⇒ output |
| --- | --- | --- |
| `status` (query) | `workflows.manage` | ⇒ `{ enabled, canExport, canImport, maxBytes: 2097152, maxWorkflows: 50 }` |
| `export` (mutation) | `workflows.export` | `{ selection: { all: true } \| { workflowKeys: string[1..50] } }` ⇒ `{ fileName, packageText }` (the digest is inside the package); unknown key ⇒ `NOT_FOUND` |
| `preview` (mutation, `form_submission`) | `workflows.import` + step-up | `{ packageText ≤ 2 MiB }` ⇒ `TransferPreview` |
| `applyImport` (mutation, `form_submission`) | `workflows.import` + step-up (re-checked in the tx) | `TransferApplyInput` ⇒ `TransferApplyResult`. Named `applyImport` because `apply` is reserved by tRPC |

`TransferPreview`:

```
{ digest, formatVersion, exportedAt, source: { release, label },
  blocking: { code, message }[],
  workflows: { key, name, unpublished, valid, findings: { severity, code, path, message }[],
               existing: { workflowPublicId, name, hasDraft } | null, suggestedKey }[],
  references: { policies: { ref, slug, title, audience, usedBy: string[],
                            resolution: { status: "matched", localPolicyPublicId, title } | { status: "not_found" } }[] } }
```

`TransferApplyInput`:

```
{ packageText, idempotencyKey /^[A-Za-z0-9_-]{16,80}$/,
  decisions: { key, action: "create" | "draft" | "skip" }[],        // one per workflow in the package
  policyMappings: { ref, localPolicyPublicId } | { ref, removeGates: true } [] }
```

The result is `{ importPublicId, replayed, results: { key, action, workflowKey, draftPublicId }[] }`.

**Package format** `readypackets.workflows` v1:

```
{ format, formatVersion: 1, exportedAt, source: { release, label },
  workflows: [{ key, name, description: null, unpublished, definition, layout }],
  references: { policies: [{ ref: "policy_N", slug, title, audience }] },
  integrity: { algorithm: "sha256", digest } }
```

- The digest is sha256 over the canonical JSON (keys sorted at every level) of `{ references, workflows }`.
- Gates carry `policyRef` instead of a local id. No local ids, customers, orders or users are exported.
- An unpublished policy is exported with slug `""` and must be mapped on import.
- `description` is always null, because there is no column for it.

**Errors**

- Structural (thrown, `VALIDATION`): `PACKAGE_TOO_LARGE` (UTF-8 bytes), `PACKAGE_TOO_DEEP` (> 24), `PACKAGE_NOT_JSON`, `PACKAGE_FORBIDDEN_KEY` (`__proto__`, `constructor`, `prototype`), `PACKAGE_FORMAT_UNSUPPORTED`, `PACKAGE_INVALID` (strict schemas, unknown keys refused).
- Blocking (returned in the preview; `applyImport` ⇒ `PACKAGE_BLOCKED`): `DIGEST_MISMATCH` (there is no "import anyway"), `NO_WORKFLOWS`, `TOO_MANY_WORKFLOWS`, `WORKFLOW_KEY_INVALID`, `DUPLICATE_WORKFLOW_KEY`, `DUPLICATE_REFERENCE`.
- Per-workflow findings: `TEXT_MARKUP`, `NAME_INVALID`, `GATE_REFERENCE_UNKNOWN`, the designer's `validateDraft` codes, `DEFINITION_INVALID`, and `RULES_DISABLED` (warning). An invalid workflow can only be skipped (`WORKFLOW_INVALID`).
- `applyImport`:
  - `DECISION_DUPLICATE`, `DECISIONS_INCOMPLETE`;
  - `POLICY_MAPPING_DUPLICATE`, `POLICY_MAPPING_UNKNOWN_REF`, `POLICY_MAPPING_REQUIRED`;
  - `POLICY_MAPPING_INVALID` (the target must be a published `all` or `customer` policy);
  - `IMPORT_NO_EXISTING_WORKFLOW` ("draft" needs an existing workflow);
  - `CONFLICT WORKFLOW_DRAFT_EXISTS`;
  - `CONFLICT IDEMPOTENCY_KEY_REUSED` (same actor and key, different request).

**Semantics**

- An import only creates **drafts**; nothing is published.
  - `create` makes a new workflow under a unique key (`key_2`, …).
  - `draft` attaches a draft to the existing workflow with that key.
- The draft's source is stored as `"blank"`, because the schema is frozen and has no `import` value. Provenance lives in `order_workflow_imports`: actor, key, requestHash, digest and source label.
- The same actor, key and request is replayed with `replayed: true`. A concurrent duplicate falls back to the replay.

**Audit** (in the tx, snake_case, safe values):

- `workflow.exported` (digest, keys, selection; counts);
- `workflow.import_previewed` (outcome `denied` plus reason_code when blocked);
- `workflow.imported` (digest, source_label, outcome, gates_removed; counts created / drafted / skipped; import id).

**Body size:** `packageText` is capped at 2 MiB by zod. The per-path HTTP body cap (about 6 MiB for preview and applyImport) is owned by http_security_engineer.

## Increment 06 — D8 customer tasks, D10 transfer default, D14 order agreement gate

Additive. Existing workflow definitions stay valid; every new field is optional and old stored values parse with defaults.

### D8: definition fields (per status `requirements`)

| Field | Values | Notes |
| --- | --- | --- |
| `uploads[].kind` | `document` \| `audio` | `audio` with `capture` is a **record** task |
| `uploads[].capture` | `either` \| `record` \| `upload` | audio only; default `either` |
| `uploads[].maxMinutes` | 1–120 | audio only; `RECORD_MINUTES_RANGE` outside the range |
| `uploads[].allowedTypes` | server extension list | the designer offers presets: Word (docx), PDF, Images (png, jpg), Audio (mp3, m4a, wav, ogg, webm, mp4, aac) |
| `acknowledgements[].source` | `definition` \| `order_note` | `order_note`: staff write a per-order note the customer acknowledges with the definition text |
| `documents[]` | `{ key, label, hint?, required, responseModes[], allowedTypes[] }`, ≤ 5 per status | `responseModes` ⊆ `edit_in_portal`, `upload_reply`, `acknowledge`; `edit_in_portal` needs `docx` |

Workflow transfer packages are `formatVersion: 2`; import accepts 1 and 2.

### D8: `orders.requirements.*`

| Procedure | Guard | Notes |
| --- | --- | --- |
| `forOrder` (query) | order access | adds `uploads[].{taskKind, capture, maxMinutes, waived}`, `acknowledgements[].{source, orderNote, canEditNote, waived}` (`canAccept` false until the note exists), `documents[]` (`replySlotKey` = `<key>_reply`, `sourceCount`, `replyCount`, `acknowledged`, `textSha256` of `label\n\nhint`, `met`, `waived`, `canStaffUpload`, `canReply` false until a source exists, `canEdit`, `canAcknowledge`), top-level `canWaive`, `agreementPending: { policyPublicId, signatureMode } \| null` |
| `setTaskNote` | staff, `orders.manage` | `{ orderId, statusKey, ackKey, body ≤ 4000 plain text, expectedVersion? }`. Errors `TASK_NOTE_MARKUP`, `TASK_NOTE_LENGTH`, `TASK_NOT_FOUND`, `TASK_NOTE_ACKNOWLEDGED`, `STALE_VERSION`. Audit `order.task_note.saved` |
| `waive` | staff, `orders.phase.unlock` | `{ orderId, statusKey, taskKey, reason 10–500 }`; the reason is kept as an internal note. Errors `TASK_NOT_FOUND`, `TASK_ALREADY_WAIVED`. Audit `order.task.waived` |
| `acknowledge` | as before | new errors `ACK_NOTE_MISSING`, `DOCUMENT_NOT_READY` |

Files port: `FileUploadSlot` gains `task { kind: upload \| record \| document_source \| document_reply, taskKey }`, `capture`, `maxMinutes`, `acceptsUpload`, `acceptsEdit`, `sourceSlotKey`. Source slot `K` is staff-only; `K_reply` is customer-only. The client links to `/orders/:id/files?slot=K[&mode=record]` (console `/admin/orders/:id/files?…`); the Files tab owns the recorder and focus.

### D10: workflow transfer default

`orders.workflow_transfer.enabled` now defaults to **true** (an old stored `false` stays false). `transfer.status` adds `canToggle`. `transfer.setEnabled({ enabled })` (admin + `workflows.manage`; no step-up, as export needs none) ⇒ `{ enabled, changed }`; audit `workflow.transfer_setting_changed` with `setting_key`, `from_value`, `to_value`, `via=workflows_page`. The switch is on the Workflows page.

### D14: order agreement gate (setting `orders.agreement_gate`)

- Shape `{ enabled (default false), policyPublicId, applyTo: { placeOrder, workOnOrder }, signatureMode: checkbox \| typed_name, askAgainOnNewVersion }`. A damaged stored value parses to "off" for display, but enforcement fails closed with `UNAVAILABLE ORDER_GATES_UNAVAILABLE`.
- `orders.admin.agreementGate.get` / `update({ setting, expectedEnabled? })` (admin + `policies.manage`, which needs a fresh step-up, re-checked from the database; otherwise `STEP_UP_REQUIRED`). Errors `AGREEMENT_SETTING_INVALID`, `AGREEMENT_POLICY_INVALID`, `AGREEMENT_SETTING_CHANGED`. Audit `order.agreement_gate.updated` in the tx with `setting_key`, `enabled_from`, `enabled_to`, `policy_from`, `policy_public_id`, `apply_place_order`, `apply_work_on_order`, `signature_mode`, `ask_again_on_new_version`. The admin card (`/admin/policies#order-agreement`) belongs to compliance.
- `orders.agreement.status({ scope: placeOrder \| workOnOrder })` ⇒ `{ required, met, policyPublicId, signatureMode }`.
- Enforcement is an implicit gate (`gate.key = "order_agreement"`) on the ADR 0039 gateway. Ports for other modules: `assertCustomerMayPlaceOrder` (cart; also enforced inside `createOrderFromCheckoutInTx`) and `assertCustomerMayWork` (files). Staff and API v1 (`assertSystemMayWork`) are exempt.
- Refusal: `CONFLICT AGREEMENT_REQUIRED` with `details { policyPublicId, signatureMode }`. The order wizard, the order page status change and the customer task panel open the shared `AgreementDialog` (`@/lib/agreementGate`) and retry once after acceptance (the wizard reuses its idempotency key; a status change resends the identical request with the same `expectedVersion`).

## Increment 07 — phases-first workflows (D1), progress (D3), attention and payment state (package B)

Status: **landed** (77cdfc3 service and ports, 6bc604b module wiring, 927c1eb router, 4e1db2a target checks and transfer v3). Shapes may gain fields, never lose them. Words: the UI says "Phase"; code says `stage`.

### Format 3 definition (`shared/workflowStages.ts`)

- `workflowStageSchema`, `workflowStagesSchema`, types `WorkflowStage` / `WorkflowStageInput`, constants (`MAX_STAGES` 20, `STAGE_ACTION_KEYS`, `STAGE_ACK_POLICIES`, `STAGE_PROGRESSIONS`, `STAGE_ADMIN_TASKS`, `STAGE_COMPLETES_ON`, `STAGE_ALERT_SEVERITIES`, `STAGE_UPLOAD_INTENTS`, `STAGE_WEBHOOK_TARGET`), `validateStages(stages, statusKeys)` → `StageIssue[]` (`path` like `stages.2.statusKeys.0`, codes `STAGE_*`), `deriveStages(definition)` for formats 1/2, `computeProgress(...)` (pure D3 formula).
- `workflowDefinitionSchema.stages` (optional, 1–20). A definition with `stages` is format 3 and must not also use `phases` / `state.phase`. Each status belongs to at most one stage; `stageActions.setStatusKey` must be a status of the workflow. At most one stage `completesOn: "payment"`.
- Stage fields: `key`, `customerLabel`, `staffLabel`, `statusKeys[1..10]`, `actions {uploadDocuments, answerQuestions, recordAudio, uploadAudio, teamFileReview}`, `governance?` (D8, nullable ints: `documentCount`, `documentMaxBytes`, `audioCount`, `audioMaxBytes`, `recordingMaxSeconds`, `totalAudioMaxSeconds`), `folders? {documents?, audio?}`, `fileSync? {originals, conversionStaging, intakeDelivery}` (storage target public id or null = do not transfer; validated by portable_ops' port at save), `acknowledgement {policy, message?}`, `content? {markdown ≤ 4000}`, `progression`, `adminTasks[]`, `stageActions? {emailTemplateKey?, setStatusKey?, completion?, webhookTargetKey?, dashboardAlert?}`, `completesOn`, `weight`.
- Transfer packages become `formatVersion: 3` when any exported definition has stages; import accepts 1–3. On import, installation-local phase targets are cleared with a warning: `fileSync` targets (`STAGE_FILE_SYNC_CLEARED`) and managed webhook subscriptions (`STAGE_WEBHOOK_CLEARED`); canonical `production:P*01` targets are kept.
- Draft save (phases that parse) and publish (all phases) call `integrations.workflowWebhooks.validateTargetKey` for each `stageActions.webhookTargetKey` and `storageConnections.validateStageFileSyncTargets(stages, tx)` when any `fileSync` target is set (`stageTargets.ts`). A missing port fails closed (`STAGE_WEBHOOK_TARGET_UNAVAILABLE`, `STAGE_FILE_SYNC_UNAVAILABLE`, or `STAGE_TARGETS_UNCHECKED` on publish).
- Start-up job `orders.increment07.startup` (every 10 min, idempotent): a fresh install with no workflow and no order gets the format-3 "ReadyPackets standard workflow" (`readypackets_standard`) as default. Otherwise, when no published version or draft has phases, the default workflow gets one draft with phases derived from its statuses, ready to review and publish. Nothing is published automatically and no order is re-pinned.

### `orders.stages.*` (tRPC)

| Procedure | Guard | Input ⇒ output |
| --- | --- | --- |
| `workspace` (query) | order access (customer: readable order; staff: `orders.read_all` or grant) | `{ orderId }` ⇒ `StageWorkspace` |
| `next` | order owner only (`STAGE_OWNER_ONLY` otherwise) | `{ orderId, stageKey, expectedVersion }` ⇒ `{ version, currentStageKey, progressPercent }` |
| `submit` | order owner only | `{ orderId, stageKey, ack?: { accepted: true, textSha256 }, expectedVersion }` ⇒ same |
| `review` | staff, `orders.stage.review` | `{ orderId, stageKey, outcome: "accepted" \| "changes_requested", note?: ≤ 2000 (required for `changes_requested`: `NOTE_REQUIRED`), expectedVersion }` ⇒ `{ version }` |
| `reopen` | admin, `orders.stage.reopen` (step-up) | `{ orderId, stageKey, reason: 10–500, confirm: true, expectedVersion }` ⇒ `{ version, progressPercent }` |

`expectedVersion` is `StageWorkspace.version` (the order's row version). Errors: `STAGE_NOT_OPEN` (working ahead or a closed stage), `STAGE_LOCKED`, `STAGE_NOT_FOUND`, `ACK_REQUIRED`, `ACK_TEXT_CHANGED`, `QUESTIONS_UNANSWERED` (assurance's `assertStageQuestionsAnswered`), `REQUIREMENTS_UNMET`, `STAGE_NOT_SUBMITTED` (review), `STAGE_NOT_REOPENABLE`, `STALE_VERSION`, `AGREEMENT_REQUIRED` / `POLICY_ACCEPTANCE_REQUIRED` (gates are never bypassed).

```ts
type StageWorkspace = {
  orderId: string; version: number; workflowFormat: 1 | 2 | 3; derived: boolean;
  progress: { percent: number; canceled: boolean; currentIndex: number; total: number; currentLabel: string | null };
  currentStageKey: string | null; orderLocked: boolean;
  stages: Array<{
    key: string; customerLabel: string; staffLabel?: string /* staff only */; index: number;
    state: "future" | "open" | "submitted" | "in_review" | "accepted" | "reopened";
    completed: boolean; locked: boolean; viewable: boolean; futureReason?: "PREVIOUS_PHASE_OPEN" | "NOT_REACHED";
    progression: "next" | "submit_lock";
    acknowledgement: { policy: "required" | "optional" | "none"; message: string | null; textSha256: string | null };
    contentMarkdown: string | null; actions: Record<StageActionKey, boolean>;
    governance: StageGovernance | null; adminTasks?: StageAdminTask[] /* staff only */;
    submittedAt: string | null; review: { outcome: "accepted" | "changes_requested"; note: string | null; at: string } | null;
    canNext: boolean; canSubmit: boolean; canReview: boolean; canReopen: boolean;
  }>;
};
```

Rules: only the current stage is writable for the customer; earlier stages are viewable read-only; later stages are `future`. "Next" completes the stage without a lock; "Submit and lock" records the submission (acknowledgement evidence: policy, text hash, time, actor) and creates the `order_phase_locks` row keyed by the stage key (administrator unlock only, via `reopen`). When the next stage's first status is reachable by an allowed transition for the actor in the pinned version, the order moves there in the same transaction; otherwise the status waits for staff. `changes_requested` records the outcome and note and sets the stage state to `in_review` (the lock stays); an administrator reopens to let the customer edit. Derived (format 1/2) workflows refuse `next` / `submit` / `review` / `reopen` with `STAGE_ACTION_OFF`. The legacy `orders.phases.unlock` refuses format-3 orders with `USE_STAGE_REOPEN`. Ack text hash = SHA-256 of the message shown (the standard warning when empty).

List rows (`orders.list`, `orders.admin.list`, dashboard recent orders) gain `progressPercent`, `progressCanceled`, `phaseLabel` (customer label for customers, staff label for staff), `phaseIndex` (0-based, null when the status is in no phase), `phaseTotal`, `paymentState`, `attention`. Rows with a null progress cache are filled on read. `orders.admin.list` accepts `attention?: "staff_review" | "customer_response"`.

### Ports (`services.orders.*`, all in the caller's transaction, order row locked `FOR UPDATE`)

```ts
stages.resolveStageForUpload(input: { orderPublicId: string; stageKey?: string | null; intent: StageUploadIntent; actor: SessionPrincipal | null /* null = system */; slotKey?: string }, tx)
  : Promise<{ stageKey: string; statusKey: string; governance: StageGovernance | null } | null>
  // null = format 1/2 (legacy behaviour). Format 3: customer writes need the current open/reopened stage with the matching action on
  // (document → uploadDocuments, recording → recordAudio, prerecorded_audio → uploadAudio, document_edit → uploadDocuments or a D8 document task);
  // staff may write to any reached stage. Errors STAGE_REQUIRED (v3 general upload without stageKey), STAGE_NOT_OPEN, STAGE_LOCKED, STAGE_ACTION_OFF.
stages.listForOrder(input: { orderPublicId: string; actor: SessionPrincipal | null; stageKey?: string }, tx?)
  : Promise<{ format: 1 | 2 | 3; stages: Array<{ key; customerLabel; staffLabel; index; statusKeys: string[]; viewable: boolean; governance; folders; fileSync }>; statusToStage: Record<string, string> }>
stages.assertStageAccess(input: { orderPublicId: string; actor: SessionPrincipal; stageKey: string; mode: "customer_write" | "staff_manage" | "read" }, tx)
  : Promise<{ orderId: number; orderPublicId: string; workflowVersionId: number; stage: WorkflowStage; state: StageRunState | "future"; locked: boolean }>
stages.refreshAttentionInTx(orderId: number, tx): Promise<void>   // after a question is asked / answered / withdrawn
stages.contextForRun(orderPublicId: string, tx): Promise<{ orderId; workflowVersionId; statusKey; currentStageKey: string | null; stages: WorkflowStage[]; completionRevision: number; progressPercent: number }>
stages.applyStageStatus(input: { orderPublicId: string; toStatus: string; actor: SessionPrincipal; runPublicId: string; override?: { reason: string } }, tx)
  : Promise<{ fromStatus: string; toStatus: string; version: number }>   // allowed transition of the pinned version, or audited admin override; gates enforced
stages.applyCompletionPercent(input: { orderPublicId: string; percent: number; expectedRevision: number; source: "stage_run" | "rule" | "job"; sourceRef: string }, tx)
  : Promise<{ applied: boolean; revision: number; progressPercent: number }>   // stale revision ⇒ applied: false (superseded), never throws for that
payments.onInvoicePaidInTx(input: { orderPublicId: string; invoicePublicId: string; paidAt: Date; method: "stripe" | "manual"; amountMinor: number; currency: string }, tx)
  : Promise<{ paymentState: OrderPaymentState; stageCompleted: string | null; advancedTo: string | null }>   // history reason INVOICE_PAID
stages.resolveQuestionStage(order: OrderAccessView, stageKey: string, db): Promise<ResolvedQuestionStage | null>   // assurance's D4 resolver (wired into phaseWork)
stages.getOrderStageFileSync(input: { orderPublicId: string; stageKey: string }, tx): Promise<StageFileSyncPlan | null>   // portable_ops' D6 plan; null = unknown order/stage
phaseWork.questions / phaseWork.adminTasks   // assurance's D4/D5 services, created with resolveQuestionStage + refreshAttentionInTx
payments.onPaymentEventInTx(input: { orderPublicId: string; kind: "pending_async" | "failed" | "refunded" | "partially_refunded"; eventRef: string }, tx)
  : Promise<{ paymentState: OrderPaymentState }>
```

`OrderPaymentState = "not_required" | "unpaid" | "pending_async" | "paid" | "partially_refunded" | "refunded"`.

### Columns on `orders` (declared by orders, all additive)

`progress_percent` tinyint null (cache; null = fill on first read), `completion_percent` tinyint null, `completion_revision` int default 0, `attention` enum(`none`, `staff_review`, `customer_response`) default `none`, `attention_since` datetime null, `payment_state` enum(as above) default `not_required`, `paid_at` datetime null. Index `orders_attention_idx (attention, attention_since, id)`.

Attention = stage state first (`submitted` / `in_review` ⇒ `staff_review`; open required question ⇒ `customer_response`), else the status's catalogue attention; written in the same transaction as every status or stage change; `attention_since` changes only when the value changes.

### Audit events (names agreed with audit_engineer)

`order.stage.advanced`, `order.stage.submitted`, `order.stage.reviewed`, `order.stage.reopened`, `order.stage.status_overridden`, `order.progress.lowered`, `order.progress.completion_applied`, `order.payment_state.changed`; system events `workflow.changed` (reason `STANDARD_V3_INSTALLED`) and `workflow.draft.changed` (reason `PHASES_UPGRADE_DRAFT`) from the start-up job.

### Phase questions and checklist

See [D4 phase work API](./questions/API.md) for the `orders.questions` and `orders.adminTasks` procedures, version and ownership rules, customer wizard and console slots, and encrypted storage.
