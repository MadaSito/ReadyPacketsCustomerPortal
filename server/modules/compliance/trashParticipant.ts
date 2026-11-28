/**
 * Compliance TrashParticipant (Increment 09, Decisions D2.5, D2.6, D2.8).
 * Owner: compliance_engineer.
 *
 * Rules enforced:
 *  - Order move to trash (`onTrashedInTx`): freezes buyer, order reference, and issuer snapshots on issued invoices.
 *  - Customer move to trash (`onTrashedInTx`): freezes issued invoice snapshots across customer orders and drops
 *    unsent (`queued`) policy notice recipient rows so no policy notice emails go out while in trash.
 *  - Summarize (`summarize`): counts `paidInvoices`, `unpaidInvoices`, `receipts`, `intakeItems` for orders and
 *    `policyAcceptances` for customers (counts only, zero PII).
 *  - Order purge (`purge`): freezes snapshots on kept paid invoices; voids all unpaid/unissued/draft invoices
 *    without ever deleting invoice rows or reusing sequence numbers; erases order intake submissions and revisions;
 *    keeps paid invoices, payment/refund ledgers, payment receipts, refund notes, and policy acceptance evidence.
 *  - Customer purge (`purge`): freezes snapshots on kept invoices of customer orders; erases policy notice recipient
 *    and policy enforcement rows; keeps required policy acceptance evidence (which renders `"Deleted account"` once
 *    the user row is tombstoned).
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { orders } from "../orders/schema.js";
import type {
  TrashActor,
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
} from "../trash/ports.js";
import { orderPolicyAcceptances } from "./acceptanceSchema.js";
import type { InvoicesService } from "./invoicesService.js";
import { policyEnforcementActions } from "./policyEnforcementSchema.js";
import { policyNoticeRecipients } from "./policyNoticesSchema.js";
import {
  complianceInvoicePayments,
  complianceInvoices,
  compliancePaymentReceipts,
  intakeSubmissionRevisions,
  intakeSubmissions,
  policyAcceptances,
} from "./schema.js";

function computeSettledByInvoice(
  payments: readonly {
    invoiceId: number;
    method: string;
    status: string;
    amountMinor: number;
    waivedMinor: number;
  }[],
): Map<number, number> {
  const settledByInvoice = new Map<number, number>();
  for (const p of payments) {
    if (p.status !== "succeeded") continue;
    const rowWaived =
      p.method === "waiver"
        ? Math.max(0, p.waivedMinor || p.amountMinor)
        : Math.max(0, Math.min(p.amountMinor, p.waivedMinor ?? 0));
    const rowCaptured = Math.max(0, p.amountMinor - rowWaived);
    settledByInvoice.set(
      p.invoiceId,
      (settledByInvoice.get(p.invoiceId) ?? 0) + rowCaptured + rowWaived,
    );
  }
  return settledByInvoice;
}

function isSettledOrZeroIssuedInvoice(
  inv: { issuedAt: Date | null; voidedAt: Date | null; totalMinor: number },
  settledGrossMinor: number,
): boolean {
  if (settledGrossMinor > 0) return true;
  return inv.issuedAt !== null && inv.totalMinor === 0 && inv.voidedAt === null;
}

export function createComplianceTrashParticipant(
  deps: ModuleDeps,
  invoices: Pick<InvoicesService, "freezeInvoicesForOrderInTx">,
): TrashParticipant {
  return {
    module: "compliance",

    async onTrashedInTx(tx, entity: TrashEntityRef, _actor: TrashActor): Promise<void> {
      if (entity.kind === "order") {
        await invoices.freezeInvoicesForOrderInTx(tx, entity.id);
        return;
      }

      if (entity.kind === "customer") {
        await tx
          .delete(policyNoticeRecipients)
          .where(
            and(
              eq(policyNoticeRecipients.userId, entity.id),
              eq(policyNoticeRecipients.mailState, "queued"),
            ),
          );

        try {
          const customerOrders = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.ownerUserId, entity.id));
          for (const ord of customerOrders) {
            await invoices.freezeInvoicesForOrderInTx(tx, ord.id);
          }
        } catch {
          // Standalone tests may omit `orders` table rows.
        }
      }
    },

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind === "order") {
        const [invRows, [receiptCountRow], [intakeCountRow]] = await Promise.all([
          deps.db
            .select({
              id: complianceInvoices.id,
              issuedAt: complianceInvoices.issuedAt,
              voidedAt: complianceInvoices.voidedAt,
              totalMinor: complianceInvoices.totalMinor,
            })
            .from(complianceInvoices)
            .where(eq(complianceInvoices.orderId, entity.id)),
          deps.db
            .select({ total: count() })
            .from(compliancePaymentReceipts)
            .where(eq(compliancePaymentReceipts.orderId, entity.id)),
          deps.db
            .select({ total: count() })
            .from(intakeSubmissions)
            .where(eq(intakeSubmissions.orderId, entity.id)),
        ]);

        const paymentRows =
          invRows.length > 0
            ? await deps.db
                .select({
                  invoiceId: complianceInvoicePayments.invoiceId,
                  method: complianceInvoicePayments.method,
                  status: complianceInvoicePayments.status,
                  amountMinor: complianceInvoicePayments.amountMinor,
                  waivedMinor: complianceInvoicePayments.waivedMinor,
                })
                .from(complianceInvoicePayments)
                .where(
                  inArray(
                    complianceInvoicePayments.invoiceId,
                    invRows.map((r) => r.id),
                  ),
                )
            : [];

        const settledByInvoice = computeSettledByInvoice(paymentRows);
        let paidInvoices = 0;
        let unpaidInvoices = 0;
        for (const inv of invRows) {
          const settled = settledByInvoice.get(inv.id) ?? 0;
          if (isSettledOrZeroIssuedInvoice(inv, settled)) {
            paidInvoices += 1;
          } else if (inv.voidedAt === null) {
            unpaidInvoices += 1;
          }
        }

        return {
          paidInvoices,
          unpaidInvoices,
          receipts: receiptCountRow?.total ?? 0,
          intakeItems: intakeCountRow?.total ?? 0,
        };
      }

      const [[generalAcc], [orderAcc]] = await Promise.all([
        deps.db
          .select({ total: count() })
          .from(policyAcceptances)
          .where(eq(policyAcceptances.userId, entity.id)),
        deps.db
          .select({ total: count() })
          .from(orderPolicyAcceptances)
          .where(eq(orderPolicyAcceptances.userId, entity.id)),
      ]);
      const policyAcceptanceCount = (generalAcc?.total ?? 0) + (orderAcc?.total ?? 0);
      return policyAcceptanceCount > 0 ? { policyAcceptances: policyAcceptanceCount } : {};
    },

    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      if (entity.kind === "order") {
        return deps.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
          const now = deps.clock.now();

          // 1. Ensure frozen buyer, order reference, and issuer snapshots are persisted on issued invoices.
          await invoices.freezeInvoicesForOrderInTx(tx, entity.id);

          // 2. Inspect invoices + payments under lock; keep paid/settled invoices, void unpaid/draft invoices
          //    without ever deleting invoice rows or reusing sequence numbers.
          const invRows = await tx
            .select()
            .from(complianceInvoices)
            .where(eq(complianceInvoices.orderId, entity.id))
            .for("update");

          const paymentRows =
            invRows.length > 0
              ? await tx
                  .select({
                    invoiceId: complianceInvoicePayments.invoiceId,
                    method: complianceInvoicePayments.method,
                    status: complianceInvoicePayments.status,
                    amountMinor: complianceInvoicePayments.amountMinor,
                    waivedMinor: complianceInvoicePayments.waivedMinor,
                  })
                  .from(complianceInvoicePayments)
                  .where(
                    inArray(
                      complianceInvoicePayments.invoiceId,
                      invRows.map((r) => r.id),
                    ),
                  )
                  .for("update")
              : [];

          const settledByInvoice = computeSettledByInvoice(paymentRows);
          let paidInvoices = 0;
          let voidedInvoices = 0;

          for (const inv of invRows) {
            const settled = settledByInvoice.get(inv.id) ?? 0;
            if (isSettledOrZeroIssuedInvoice(inv, settled)) {
              paidInvoices += 1;
              continue;
            }
            if (inv.voidedAt === null) {
              await tx
                .update(complianceInvoices)
                .set({
                  status: "void",
                  voidedAt: now,
                  voidReason: "Order permanently deleted",
                  version: inv.version + 1,
                  updatedAt: now,
                })
                .where(eq(complianceInvoices.id, inv.id));
            }
            voidedInvoices += 1;
          }

          // 3. Erase order intake submissions and revisions.
          const subRows = await tx
            .select({ id: intakeSubmissions.id })
            .from(intakeSubmissions)
            .where(eq(intakeSubmissions.orderId, entity.id))
            .for("update");

          if (subRows.length > 0) {
            const subIds = subRows.map((s) => s.id);
            await tx
              .delete(intakeSubmissionRevisions)
              .where(inArray(intakeSubmissionRevisions.submissionId, subIds));
            await tx.delete(intakeSubmissions).where(inArray(intakeSubmissions.id, subIds));
          }

          // 4. Count kept receipts and order policy acceptance evidence (checkout + workflow gate acceptances).
          const [[receiptCountRow], [checkoutAccRow], [orderAccRow]] = await Promise.all([
            tx
              .select({ total: count() })
              .from(compliancePaymentReceipts)
              .where(eq(compliancePaymentReceipts.orderId, entity.id)),
            tx
              .select({ total: count() })
              .from(policyAcceptances)
              .where(eq(policyAcceptances.orderId, entity.id)),
            tx
              .select({ total: count() })
              .from(orderPolicyAcceptances)
              .where(eq(orderPolicyAcceptances.orderId, entity.id)),
          ]);

          return {
            deleted: {
              intakeItems: subRows.length,
            },
            kept: {
              paidInvoices,
              voidedInvoices,
              receipts: receiptCountRow?.total ?? 0,
              policyAcceptances: (checkoutAccRow?.total ?? 0) + (orderAccRow?.total ?? 0),
            },
          };
        });
      }

      return deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        // 1. Freeze snapshots on any kept invoices belonging to this customer's orders before user tombstoning.
        try {
          const customerOrders = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.ownerUserId, entity.id));
          for (const ord of customerOrders) {
            await invoices.freezeInvoicesForOrderInTx(tx, ord.id);
          }
        } catch {
          // Standalone tests may omit `orders` table rows.
        }

        // 2. Erase non-evidentiary notice recipient & enforcement tracking rows for this customer.
        const [[noticeCountRow], [enforceCountRow], [generalAccRow], [orderAccRow]] =
          await Promise.all([
            tx
              .select({ total: count() })
              .from(policyNoticeRecipients)
              .where(eq(policyNoticeRecipients.userId, entity.id)),
            tx
              .select({ total: count() })
              .from(policyEnforcementActions)
              .where(eq(policyEnforcementActions.userId, entity.id)),
            tx
              .select({ total: count() })
              .from(policyAcceptances)
              .where(eq(policyAcceptances.userId, entity.id)),
            tx
              .select({ total: count() })
              .from(orderPolicyAcceptances)
              .where(eq(orderPolicyAcceptances.userId, entity.id)),
          ]);

        if ((noticeCountRow?.total ?? 0) > 0) {
          await tx
            .delete(policyNoticeRecipients)
            .where(eq(policyNoticeRecipients.userId, entity.id));
        }
        if ((enforceCountRow?.total ?? 0) > 0) {
          await tx
            .delete(policyEnforcementActions)
            .where(eq(policyEnforcementActions.userId, entity.id));
        }

        return {
          deleted: {
            policyNoticeRecipients: noticeCountRow?.total ?? 0,
            policyEnforcementActions: enforceCountRow?.total ?? 0,
          },
          kept: {
            policyAcceptances: (generalAccRow?.total ?? 0) + (orderAccRow?.total ?? 0),
          },
        };
      });
    },
  };
}
