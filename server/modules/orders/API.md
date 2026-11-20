# Orders, catalog, workflow, locks, sharing — API

Owner: orders_engineer. Status: v1 signatures (implementation in progress; see VERIFICATION.md for what is tested).

Import types from `server/modules/orders/index.ts`; reach the instance as `deps.services.orders` **at call time**.

## 1. Access policy (the resource-authorization authority)

```ts
type OrderAccessRole = "owner" | "contributor" | "viewer" | "staff" | "admin";
type OrderWriteKind =
  | "order"      // edit order fields / notes / sharing (sharing: owner + staff only)
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

interface AccessOptions { tx?: Tx; forUpdate?: boolean }   // forUpdate => SELECT … FOR UPDATE inside tx

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
getOrderRefById(orderId: number, tx?: Tx): Promise<{ id; publicId; reference; ownerUserId; lockState; statusKey } | null>
```

Rules (all re-evaluated on every call, no caching):

- Principal must be a **full** session (`state === "full"`, no pending steps), else `NOT_FOUND` (defence in depth; guards already refuse).
- Unknown id, malformed id, other customer's order, revoked/declined/pending grant ⇒ `NOT_FOUND` (`ORDER_NOT_FOUND`) — no existence oracle. Cross-tenant denials are audited `authz.order.denied` (security, denied).
- Customer read: owner, or holder of an **accepted, unrevoked** grant (viewer or contributor).
- Customer write: owner, or contributor grant, for kinds `order*`, `file`, `message`, `intake`. Viewers ⇒ `FORBIDDEN` (`GRANT_READ_ONLY`) — they can already see the order, so FORBIDDEN leaks nothing. `invoice` is never a customer write. Sharing management (`order` kind used by sharing endpoints) is owner-only.
- Staff: read needs `orders.read_all`; write needs `orders.manage` (kind `status` needs `orders.transition`). Without the capability ⇒ `NOT_FOUND`.
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
importOrder(input: ImportOrderInput, tx: Tx): Promise<{ id: number; publicId: string; reference: string; created: boolean }>
// ImportOrderInput = { importId: string; sourceInstallationId: string; sourceOrderPublicId: string; sourceReference?: string;
//   targetOwnerUserId: number /* resolved by portable mapping, re-validated here: must be an existing customer */;
//   projectName; statusKey /* mapped to the target default workflow; unknown ⇒ initial state, recorded */;
//   totalMinor; currency; createdAt; submittedAt?; lineItems: ImportLineItem[]; statusHistory?: …; customerNotes?: …;
//   editable?: false /* default; true only with explicit approved operation, still audited */ }
// Behaviour: idempotent on (sourceInstallationId, sourceOrderPublicId) via order_import_provenance; dates + money preserved;
// NO workflow replay, NO notifications, NO mail; lockState = imported_read_only unless editable; reference collision ⇒
// a fresh target reference is generated and the source reference stored as provenance only; audit `order.imported` in tx.
checkCatalogViability(items: { productPublicId?: string; name: string; currency: string }[]): Promise<{ matched: number; unmatched: number }>
// Imported line items are snapshots — they never need a live catalog product; this is informational for dry-run plans.

// Engagement search provider (bounded)
searchOrders(principal, query: string /* 2..64 chars */, limit ≤ 20): Promise<{ publicId; reference; projectName; statusLabel; updatedAt }[]>
```

On reassignment orders calls (inside its transaction): `services.files.reassignOrderFiles(orderId, newOwnerUserId, tx)` (which also revokes outstanding download tickets). If files is missing the method the reassignment is refused (fail closed).

Orders consumes: `services.identity.getUser(userId)` → `{ id, publicId, role, status, email, name } | null`; `services.identity.getUserByPublicId(publicId)`; `services.engagement.notify({ userId, kind, title, body, link })`.

## 3. tRPC (`trpc.orders.*`)

| Procedure | Guard | Notes |
| --- | --- | --- |
| `catalog.list` | protected | active products of active groups, current version |
| `list` | protected | accessible orders, cursor pagination, `status?` filter |
| `get` | protected | read-checked detail: items, customer-visible history + notes, my accessRole, lock, allowed transitions for me |
| `create` | protected + `orders.create` | `{ projectName, items: [{ productPublicId, quantity }], note? , idempotencyKey }` |
| `update` | protected | `{ orderId, expectedVersion, projectName }` write kind=order |
| `addNote` | protected | customer-visible note (staff may pass `visibility: "internal"`) |
| `transition` | protected | `{ orderId, expectedVersion, toStatus, note? }` — workflow decides who may trigger |
| `sharing.list/invite/revoke` | protected | owner (or staff with orders.manage) |
| `sharing.myInvitations/accept/decline` | protected | grantee side |
| `admin.list` | staff + `orders.read_all` | filters: status, customerPublicId, from/to, referencePrefix; cursor |
| `admin.get` | staff + `orders.read_all` | includes internal notes, full history, grants, reference history |
| `admin.setLock` | staff + `orders.manage` (legal_hold / unlock imported: admin) | |
| `admin.changeReference` | admin + `orders.identifiers.change` (step-up) | retired reference reserved forever |
| `admin.reassign` | admin + `orders.reassign` (step-up) | `{ orderId, targetCustomerPublicId, expectedVersion, operationId, reasonCode }` |
| `admin.catalog.*` | admin + `catalog.manage` | groups/products CRUD; price/name change ⇒ new immutable product version |
| `admin.workflows.*` | admin + `workflows.manage` | versioned definitions; orders keep their bound version |

## 4. Audit events (fixed names)

`order.created`, `order.updated`, `order.note.added`, `order.status.changed`, `order.transition.denied`, `order.lock.changed`,
`order.reference.changed`, `order.reassigned`, `order.reassign.refused`, `order.share.invited`, `order.share.accepted`,
`order.share.declined`, `order.share.revoked`, `order.imported`, `authz.order.denied`, `catalog.group.changed`,
`catalog.product.changed`, `workflow.changed`.

## 5. Mail templates, settings, health

- Mail: `orders.status_changed` (vars: `reference`, `statusLabel`, `link`), `orders.share_invited` (vars: `reference`, `link`).
- Settings: `orders.reference.prefix` (default `RP`), `orders.notify.mail` (default false — in-app notifications always).
- Health: `orders.catalog` (`not_configured` while the catalog is empty), `orders.workflow` (`failing` if no default workflow).
- Demo seed: `seedOrdersDemo(db)` exported from `server/modules/orders/demoSeed.ts` — clearly synthetic, never run automatically.
