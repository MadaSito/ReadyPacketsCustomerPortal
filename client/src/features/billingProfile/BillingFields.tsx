/**
 * Reusable billing contact and address fields + validation helpers (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 *
 * Shared across:
 *  - `/account/billing` (`BillingInformationPage`)
 *  - `/cart/checkout` (`recovery_ops_engineer`)
 *  - `/register` (`identity_engineer` optional collapsed section)
 *
 * Designed and tested against WCAG 2.2 AA (explicit labels, autocomplete input-purpose tokens,
 * `aria-describedby` / `aria-invalid` error wiring via `<Field>`, responsive 240 px–1440 px layout,
 * plain-text rendering only).
 */
import {
  billingDetailsSchema,
  type BillingDetails,
  type BillingDetailsInput,
} from "@shared/billingDetails";
import { cn, Field, Input } from "@/ui";

export type { BillingDetails, BillingDetailsInput };

export type BillingFieldKey = keyof BillingDetails;

export type BillingFieldErrors = Partial<Record<BillingFieldKey, string>>;

export const EMPTY_BILLING_DETAILS: BillingDetails = {
  fullName: "",
  company: "",
  email: "",
  country: "",
  region: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  postalCode: "",
  taxId: "",
};

export const BILLING_FIELD_ORDER: readonly BillingFieldKey[] = [
  "fullName",
  "email",
  "company",
  "taxId",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "country",
] as const;

export interface BillingFieldMeta {
  key: BillingFieldKey;
  label: string;
  maxLength: number;
  autoComplete?: string;
  type?: "text" | "email";
  inputMode?: "text" | "email";
  required?: boolean;
  hint?: string;
  fullWidth?: boolean;
}

export const BILLING_FIELD_DEFS: readonly BillingFieldMeta[] = [
  {
    key: "fullName",
    label: "Billing name",
    maxLength: 160,
    autoComplete: "billing name",
    required: true,
  },
  {
    key: "email",
    label: "Billing email",
    maxLength: 254,
    autoComplete: "billing email",
    type: "email",
    inputMode: "email",
    required: true,
  },
  {
    key: "company",
    label: "Company",
    maxLength: 160,
    autoComplete: "billing organization",
  },
  {
    key: "taxId",
    label: "Tax ID",
    maxLength: 64,
  },
  {
    key: "addressLine1",
    label: "Address line 1",
    maxLength: 200,
    autoComplete: "billing address-line1",
    required: true,
    fullWidth: true,
  },
  {
    key: "addressLine2",
    label: "Address line 2",
    maxLength: 200,
    autoComplete: "billing address-line2",
    fullWidth: true,
  },
  {
    key: "city",
    label: "City or locality",
    maxLength: 120,
    autoComplete: "billing address-level2",
    required: true,
  },
  {
    key: "region",
    label: "State, province or region",
    maxLength: 64,
    autoComplete: "billing address-level1",
  },
  {
    key: "postalCode",
    label: "Postal code",
    maxLength: 32,
    autoComplete: "billing postal-code",
    required: true,
  },
  {
    key: "country",
    label: "Country code",
    maxLength: 2,
    autoComplete: "billing country",
    required: true,
    hint: "Two letters, such as US, CA or GB.",
  },
];

const REQUIRED_FIELD_MESSAGES: Partial<Record<BillingFieldKey, string>> = {
  fullName: "Enter the billing contact name.",
  email: "Enter a valid billing email address.",
  addressLine1: "Enter the street address.",
  city: "Enter the city or locality.",
  postalCode: "Enter the postal code.",
  country: "Enter a two-letter country code, such as US, CA or GB.",
};

export function billingFieldDomId(idPrefix: string, key: BillingFieldKey): string {
  return `${idPrefix}-${key}`;
}

/** Returns `true` when every billing field is blank after trimming (used by optional registration section). */
export function isBillingFieldsEmpty(value: Partial<BillingDetailsInput> | null | undefined): boolean {
  if (!value) return true;
  for (const key of BILLING_FIELD_ORDER) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return false;
    }
  }
  return true;
}

export type BillingValidationResult =
  | { ok: true; data: BillingDetails }
  | { ok: false; errors: BillingFieldErrors; firstKey: BillingFieldKey };

/** Validates billing fields client-side using `shared/billingDetails.ts` and produces accessible per-field messages. */
export function validateBillingFields(input: BillingDetailsInput): BillingValidationResult {
  const parsed = billingDetailsSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  const errors: BillingFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const rawKey = issue.path[0];
    if (typeof rawKey !== "string" || !BILLING_FIELD_ORDER.includes(rawKey as BillingFieldKey)) {
      continue;
    }
    const key = rawKey as BillingFieldKey;
    if (errors[key]) continue;

    const currentVal = typeof input[key] === "string" ? input[key].trim() : "";
    if (currentVal.length === 0 && REQUIRED_FIELD_MESSAGES[key]) {
      errors[key] = REQUIRED_FIELD_MESSAGES[key];
    } else if (key === "country") {
      errors[key] = "Enter a two-letter country code, such as US, CA or GB.";
    } else if (key === "email") {
      errors[key] = "Enter a valid billing email address.";
    } else {
      errors[key] = issue.message || "Enter a valid value.";
    }
  }

  const firstKey = BILLING_FIELD_ORDER.find((k) => Boolean(errors[k])) ?? "fullName";
  if (!errors[firstKey]) {
    errors[firstKey] = REQUIRED_FIELD_MESSAGES[firstKey] ?? "Check this billing field.";
  }

  return { ok: false, errors, firstKey };
}

/** Maps server `SafeErrorData.fieldErrors` (e.g. `details.country` or `billing.country`) into `BillingFieldErrors`. */
export function extractBillingFieldErrors(
  fieldErrors: Record<string, string[]> | undefined,
  prefix = "",
): BillingFieldErrors {
  const out: BillingFieldErrors = {};
  if (!fieldErrors) return out;
  const dotPrefix = prefix ? `${prefix}.` : "";

  for (const key of BILLING_FIELD_ORDER) {
    const messages =
      (dotPrefix ? fieldErrors[`${dotPrefix}${key}`] : undefined) ?? fieldErrors[key];
    if (messages && messages.length > 0 && messages[0]) {
      out[key] = messages[0];
    }
  }
  return out;
}

/** Formats saved `BillingDetails` into concise plain-text lines for account settings and checkout summaries. */
export function formatBillingSummaryLines(details: BillingDetails): string[] {
  const lines: string[] = [];
  lines.push(details.company ? `${details.fullName} · ${details.company}` : details.fullName);
  lines.push(details.email);
  lines.push(
    details.addressLine2
      ? `${details.addressLine1}, ${details.addressLine2}`
      : details.addressLine1,
  );
  const locality = [details.city, details.region, details.postalCode, details.country]
    .filter((part) => part.trim().length > 0)
    .join(", ");
  if (locality) lines.push(locality);
  if (details.taxId) lines.push(`Tax ID: ${details.taxId}`);
  return lines;
}

export interface BillingFieldsProps {
  value: BillingDetails;
  onChange: (next: BillingDetails) => void;
  errors?: BillingFieldErrors | undefined;
  disabled?: boolean | undefined;
  /** Optional DOM ID prefix (defaults to `"billing"`), producing `<idPrefix>-<fieldKey>` input IDs. */
  idPrefix?: string | undefined;
  className?: string | undefined;
}

export function BillingFields({
  value,
  onChange,
  errors,
  disabled = false,
  idPrefix = "billing",
  className,
}: BillingFieldsProps) {
  return (
    <div className={cn("grid min-w-0 gap-4 sm:grid-cols-2", className)}>
      {BILLING_FIELD_DEFS.map((field) => {
        const controlId = billingFieldDomId(idPrefix, field.key);
        const fieldError = errors?.[field.key];
        return (
          <Field
            key={field.key}
            id={controlId}
            label={field.label}
            required={field.required}
            hint={field.hint}
            error={fieldError}
            className={cn("min-w-0", field.fullWidth && "sm:col-span-2")}
          >
            <Input
              type={field.type ?? "text"}
              inputMode={field.inputMode}
              value={value[field.key]}
              maxLength={field.maxLength}
              autoComplete={field.autoComplete}
              disabled={disabled}
              onChange={(event) => {
                const nextVal =
                  field.key === "country"
                    ? event.target.value.toUpperCase()
                    : event.target.value;
                onChange({ ...value, [field.key]: nextVal });
              }}
            />
          </Field>
        );
      })}
    </div>
  );
}
