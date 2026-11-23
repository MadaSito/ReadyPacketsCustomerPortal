import { z } from "zod";
import { validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { Mailer, Tx } from "../../core/types.js";

export const PAYMENT_RECEIPT_TEMPLATE = "payment_receipt";
// Leave room in the 1 MiB field-crypto envelope for base64 expansion, mail metadata and JSON.
export const RECEIPT_PDF_MAX_BYTES = 690 * 1024;
export const receiptNumberSchema = z.string().regex(/^RPR-\d{4}-\d{6}$/u);
const ulid = z.string().regex(ULID_PATTERN);
const receiptInput = z.strictObject({
  receiptPublicId: ulid,
  recipientUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  receiptNumber: receiptNumberSchema,
  pdf: z.instanceof(Buffer),
  resendRequestPublicId: ulid.optional(),
});

export type PaymentReceiptMailInput = z.input<typeof receiptInput>;

export async function enqueuePaymentReceipt(mailer: Mailer, input: PaymentReceiptMailInput, tx?: Tx) {
  const parsed = receiptInput.safeParse(input);
  if (!parsed.success) throw validation("INVALID_RECEIPT_MAIL", "The receipt message is invalid.");
  const { receiptPublicId, recipientUserId, receiptNumber, pdf, resendRequestPublicId } = parsed.data;
  const idempotencyKey = `payment-receipt:${receiptPublicId}${resendRequestPublicId ? `:resend:${resendRequestPublicId}` : ""}`;
  const attach = pdf.byteLength <= RECEIPT_PDF_MAX_BYTES;
  await mailer.enqueue({
    template: PAYMENT_RECEIPT_TEMPLATE,
    to: { userId: recipientUserId },
    vars: { receiptNumber },
    idempotencyKey,
    ...(attach ? { attachments: [{ filename: `${receiptNumber}.pdf`, contentType: "application/pdf", content: pdf }] } : {}),
  }, tx);
  return { attachment: attach ? "attached" as const : "omitted_too_large" as const };
}
