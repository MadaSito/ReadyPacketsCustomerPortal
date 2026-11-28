import { and, count, eq, gte, inArray, isNotNull, max, not, or } from "drizzle-orm";
import { ULID_PATTERN } from "../../core/ids.js";
import type { DbOrTx, OutboundMail } from "../../core/types.js";
import type { ModuleDeps } from "../../container.js";
import { liveUserPredicate, isTrashedUserInTx } from "../identity/live.js";
import { normalizeEmail } from "../identity/normalize.js";
import { users } from "../identity/schema.js";
import { orderReferences, orders } from "../orders/schema.js";
import { liveOrderPredicate } from "../orders/trashGate.js";
import { parseAllowedTemplateUrl } from "../mailTemplates/sanitizer.js";
import type { TrashEntityRef, TrashParticipant } from "../trash/ports.js";
import { mailOutbox } from "./schema.js";

export interface MailTrashScope {
  to: OutboundMail["to"];
  vars: OutboundMail["vars"];
  template: string;
  orderId?: number | undefined;
  recipientAccountId?: number | undefined;
  legacyCreatedAt?: Date | undefined;
}

const ORDER_LINK_FIELDS = ["link", "portalPath", "orderLink", "order_link"] as const;
const ORDER_ID_FIELDS = ["orderPublicId", "order_public_id"] as const;

function legacyOrderPublicId(scope: MailTrashScope, origin: string): string | undefined {
  for (const field of ORDER_ID_FIELDS) {
    const value = scope.vars[field];
    if (typeof value === "string" && ULID_PATTERN.test(value)) return value;
  }
  const canonical = new URL(origin).origin;
  for (const field of ORDER_LINK_FIELDS) {
    const value = scope.vars[field];
    if (typeof value !== "string") continue;
    const url = parseAllowedTemplateUrl(value, { allowMailto: false, canonicalOrigin: canonical });
    if (!url?.startsWith(`${canonical}/orders/`)) continue;
    const publicId = new URL(url).pathname.split("/")[2] ?? "";
    if (ULID_PATTERN.test(publicId)) return publicId;
  }
}

export function createMailTrashGuard(deps: ModuleDeps) {
  const emailIndex = (address: string) => deps.crypto.blindIndex(normalizeEmail(address), "users.email");
  const literalAccount = async (db: DbOrTx, address: string) => {
    const [row] = await db.select({ id: users.id, createdAt: users.createdAt, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.emailIndex, emailIndex(address))).limit(1);
    return row;
  };
  async function legacyLiteral(db: DbOrTx, address: string, queuedAt: Date | undefined) {
    const current = await literalAccount(db, address);
    if (!queuedAt) return { current, unsafe: false };
    if (current && current.createdAt > queuedAt) return { unsafe: true, current: undefined };
    if (current && current.updatedAt < queuedAt) return { current, unsafe: false };
    // The digest is intentionally erased on tombstoning. If an address was unbound or could have
    // been changed after enqueue, a purge makes its old association unknowable. Do not send it.
    const [purge] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.role, "customer"), gte(users.purgedAt, queuedAt))).limit(1);
    return purge ? { unsafe: true, current: undefined } : { current, unsafe: false };
  }
  async function resolveOrder(scope: MailTrashScope, db: DbOrTx, hiddenOnly = false) {
    if (scope.template.startsWith("mail_templates.test_")) return undefined;
    const publicId = legacyOrderPublicId(scope, deps.config.canonicalOrigin);
    const ref = scope.vars.orderReference ?? scope.vars.order_reference
      ?? (scope.template.startsWith("orders.") ? scope.vars.reference : undefined);
    const reference = typeof ref === "string" && ref.trim().length > 0 && ref.trim().length <= 32 ? ref.trim() : undefined;
    if (!publicId && !reference) return undefined;
    // Reserved references survive renames and tombstoning. Prefer the public ID when supplied.
    const [row] = await db.select({ id: orders.id }).from(orders)
      .leftJoin(orderReferences, eq(orderReferences.orderId, orders.id)).where(and(
        hiddenOnly ? not(liveOrderPredicate()) : undefined,
        publicId ? eq(orders.publicId, publicId) : or(eq(orders.reference, reference!), eq(orderReferences.reference, reference!)),
      )).limit(1);
    return row?.id;
  }
  return {
    async bindLiteralRecipient(tx: DbOrTx, address: string) {
      return (await literalAccount(tx, address))?.id;
    },
    async recoverLegacyBinding(scope: MailTrashScope, db: DbOrTx) {
      const orderId = scope.orderId ?? await resolveOrder(scope, db);
      let recipientAccountId = scope.recipientAccountId;
      if ("userId" in scope.to) recipientAccountId = scope.to.userId;
      else if (recipientAccountId === undefined) {
        const { current, unsafe } = await legacyLiteral(db, scope.to.address, scope.legacyCreatedAt);
        if (unsafe) {
          return { suppressed: true, orderId, recipientAccountId };
        }
        recipientAccountId = current?.id;
      }
      return { suppressed: false, orderId, recipientAccountId };
    },
    async isSuppressed(scope: MailTrashScope, db: DbOrTx = deps.db): Promise<boolean> {
      if ("userId" in scope.to) {
        if (await isTrashedUserInTx(db, scope.to.userId)) return true;
      } else if (scope.recipientAccountId !== undefined) {
        // Bind a literal address to its account at enqueue so purge/re-registration cannot unbind old work.
        const [row] = await db.select({ id: users.id }).from(users).where(and(
          eq(users.id, scope.recipientAccountId), eq(users.emailIndex, emailIndex(scope.to.address)), liveUserPredicate(),
        )).limit(1);
        if (!row) return true;
      } else {
        if (scope.legacyCreatedAt) {
          if ((await legacyLiteral(db, scope.to.address, scope.legacyCreatedAt)).unsafe) return true;
        }
        const [hidden] = await db.select({ id: users.id }).from(users).where(and(
          eq(users.emailIndex, emailIndex(scope.to.address)), not(liveUserPredicate()),
        )).limit(1);
        if (hidden) return true;
      }
      if (scope.orderId !== undefined) {
        const [liveOrder] = await db.select({ id: orders.id }).from(orders)
          .where(and(eq(orders.id, scope.orderId), liveOrderPredicate())).limit(1);
        return !liveOrder;
      }
      return (await resolveOrder(scope, db, true)) !== undefined;
    },
  };
}

export async function latestMailRelevantPurge(db: DbOrTx): Promise<Date | null> {
  const [customer] = await db.select({ at: max(users.purgedAt) }).from(users).where(eq(users.role, "customer"));
  const [order] = await db.select({ at: max(orders.purgedAt) }).from(orders);
  if (!customer?.at) return order?.at ?? null;
  return order?.at && order.at > customer.at ? order.at : customer.at;
}

export async function hasHiddenMailBinding(db: DbOrTx, binding: {
  orderId: number | null; recipientAccountId: number | null;
}): Promise<boolean> {
  if (binding.recipientAccountId !== null && await isTrashedUserInTx(db, binding.recipientAccountId)) return true;
  if (binding.orderId === null) return false;
  const [order] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.id, binding.orderId), liveOrderPredicate())).limit(1);
  return !order;
}

export function createMailTrashParticipant(deps: Pick<ModuleDeps, "db" | "clock">): TrashParticipant {
  const matchingEntity = ({ kind, id }: TrashEntityRef) =>
    eq(kind === "order" ? mailOutbox.orderId : mailOutbox.recipientAccountId, id);
  const hasContent = or(isNotNull(mailOutbox.payloadEnc), isNotNull(mailOutbox.captureEnc), isNotNull(mailOutbox.contentEnc));
  const eraseContent = { payloadEnc: null, captureEnc: null, contentEnc: null, contentExpiresAt: null };
  return {
    module: "jobs",
    async onTrashedInTx(tx, entity) {
      // The durable queue job can still wake; it only handles queued mail and becomes a no-op.
      // Do not overwrite an in-progress transport attempt; it has its own pre-dispatch fence.
      await tx.update(mailOutbox).set({
        state: "failed", reasonCode: "MAIL_SCOPE_UNAVAILABLE", ...eraseContent, updatedAt: deps.clock.now(),
      }).where(and(matchingEntity(entity), inArray(mailOutbox.state, ["queued", "held"])));
    },
    async summarize(entity) {
      const [row] = await deps.db.select({ total: count() }).from(mailOutbox).where(and(matchingEntity(entity), hasContent));
      return { retainedMailCopies: row?.total ?? 0 };
    },
    async purge(entity, run) {
      return deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        const [result] = await tx.update(mailOutbox).set({ ...eraseContent, updatedAt: deps.clock.now() })
          .where(and(matchingEntity(entity), hasContent));
        return { deleted: { retainedMailCopies: result.affectedRows } };
      });
    },
  };
}
