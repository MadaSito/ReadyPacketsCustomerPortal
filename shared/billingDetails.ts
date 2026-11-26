/**
 * Billing contact and address (increment 08). One strict schema shared by cart checkout, the saved billing
 * profile and registration, so a saved profile is always valid at checkout. Plain text only: NFC-normalised,
 * trimmed, bounded, control characters refused. Rendered strictly as text.
 */
import { z } from "zod";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const boundedText = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((value) => !CONTROL_CHARACTERS.test(value), { message: "Control characters are not allowed." }),
    );

export const billingDetailsSchema = z
  .object({
    fullName: boundedText(1, 160),
    company: boundedText(0, 160).optional().default(""),
    email: boundedText(3, 254).pipe(z.email("Enter a valid billing email address.")),
    country: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, "Select a two-letter country code.")),
    region: boundedText(0, 64).optional().default(""),
    addressLine1: boundedText(1, 200),
    addressLine2: boundedText(0, 200).optional().default(""),
    city: boundedText(1, 120),
    postalCode: boundedText(1, 32),
    taxId: boundedText(0, 64).optional().default(""),
  })
  .strict();

export type BillingDetailsInput = z.input<typeof billingDetailsSchema>;
export type BillingDetails = z.output<typeof billingDetailsSchema>;
