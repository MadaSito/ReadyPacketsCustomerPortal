import { z } from "zod";
import { validation } from "../../core/errors.js";
import type { OutboundMail, OutboundMailAttachment } from "../../core/types.js";
import { PAYMENT_RECEIPT_TEMPLATE, RECEIPT_PDF_MAX_BYTES, receiptNumberSchema } from "./receiptMail.js";

const metadata = {
  filename: z.string().regex(/^RPR-\d{4}-\d{6}\.pdf$/u),
  contentType: z.literal("application/pdf"),
};
const pdfSignature = Buffer.from("%PDF-", "ascii");
const hasSupportedPdfBytes = (buffer: Buffer) => buffer.byteLength > pdfSignature.byteLength
  && buffer.byteLength <= RECEIPT_PDF_MAX_BYTES && buffer.subarray(0, pdfSignature.byteLength).equals(pdfSignature);
const input = z.strictObject({ ...metadata, content: z.instanceof(Buffer).refine(hasSupportedPdfBytes) });
const invalidAttachment = () => validation("INVALID_MAIL_ATTACHMENT", "Only one server-generated receipt PDF up to 690 KiB may be attached.");

const maxBase64 = 4 * Math.ceil(RECEIPT_PDF_MAX_BYTES / 3);
export const storedAttachments = z.array(z.strictObject({
  ...metadata,
  contentBase64: z.string().min(8).max(maxBase64),
})).length(1).optional();

export function encodeMailAttachments(mail: OutboundMail) {
  if (mail.template === PAYMENT_RECEIPT_TEMPLATE && (!("userId" in mail.to) || !receiptNumberSchema.safeParse(mail.vars.receiptNumber).success)) throw invalidAttachment();
  if (mail.attachments === undefined) return undefined;
  if (mail.template !== PAYMENT_RECEIPT_TEMPLATE) throw invalidAttachment();
  const parsed = z.array(input).length(1).safeParse(mail.attachments);
  if (!parsed.success) throw invalidAttachment();
  return parsed.data.map(({ content, ...rest }) => {
    if (rest.filename !== `${mail.vars.receiptNumber}.pdf`) throw invalidAttachment();
    return { ...rest, contentBase64: content.toString("base64") };
  });
}

export function decodeMailAttachments(
  template: string, vars: OutboundMail["vars"], to: OutboundMail["to"], stored: z.infer<typeof storedAttachments>,
): OutboundMailAttachment[] | undefined {
  if (template === PAYMENT_RECEIPT_TEMPLATE && (!("userId" in to) || !receiptNumberSchema.safeParse(vars.receiptNumber).success)) throw invalidAttachment();
  if (!stored) return undefined;
  if (template !== PAYMENT_RECEIPT_TEMPLATE) throw invalidAttachment();
  return stored.map(({ contentBase64, ...rest }) => {
    const content = Buffer.from(contentBase64, "base64");
    if (!hasSupportedPdfBytes(content) || content.toString("base64") !== contentBase64
      || rest.filename !== `${vars.receiptNumber}.pdf`) throw invalidAttachment();
    return { ...rest, content };
  });
}
