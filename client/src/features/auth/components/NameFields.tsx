/**
 * First / last / preferred name fields (increment 08, D1). Same bounds as the server: first and last required,
 * preferred optional, each at most 50 characters (UTF-16 units), no control characters, markup brackets or
 * bidi overrides. Autocomplete tokens given-name / family-name / nickname on self-service forms ("off" on admin forms).
 */
import { Field, Input } from "@/ui";

export interface NameValues {
  firstName: string;
  lastName: string;
  preferredName: string;
}
export type NameErrors = Partial<Record<keyof NameValues, string>>;

export const EMPTY_NAME: NameValues = { firstName: "", lastName: "", preferredName: "" };
export const NAME_PART_MAX = 50;
// eslint-disable-next-line no-control-regex
const REFUSED = /[\u0000-\u001F\u007F-\u009F<>\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

const tidy = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();

/** Client-side check mirroring the server; returns trimmed values ready to send, or per-field messages. */
export function validateNameParts(values: NameValues, subject: "your" | "their" = "your"): { ok: true; data: { firstName: string; lastName: string; preferredName: string | null } } | { ok: false; errors: NameErrors } {
  const errors: NameErrors = {};
  const first = tidy(values.firstName);
  const last = tidy(values.lastName);
  const preferred = tidy(values.preferredName);
  const check = (key: keyof NameValues, value: string, label: string, required: boolean) => {
    if (required && !value) errors[key] = subject === "your" ? `Enter your ${label}.` : `Enter the ${label}.`;
    else if (value.length > NAME_PART_MAX) errors[key] = `Use at most ${NAME_PART_MAX} characters — please shorten it.`;
    else if (REFUSED.test(value)) errors[key] = `The ${label} contains characters that are not allowed.`;
  };
  check("firstName", first, "first name", true);
  check("lastName", last, "last name", true);
  check("preferredName", preferred, "preferred name", false);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { firstName: first, lastName: last, preferredName: preferred || null } };
}

export function NameFields({ value, onChange, errors = {}, disabled, subject = "your" }: {
  value: NameValues;
  onChange: (next: NameValues) => void;
  errors?: NameErrors;
  disabled?: boolean;
  /** "your" on self-service forms; "their" on administrator forms (hint wording only). */
  subject?: "your" | "their";
}) {
  // Administrator forms describe someone else: never offer the administrator's own autofill values.
  const auto = (token: string) => (subject === "your" ? token : "off");
  const set = (key: keyof NameValues) => (event: { target: { value: string } }) => onChange({ ...value, [key]: event.target.value });
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Field label="First name" error={errors.firstName} required>
        <Input name="given-name" autoComplete={auto("given-name")} value={value.firstName} onChange={set("firstName")} maxLength={NAME_PART_MAX} disabled={disabled} />
      </Field>
      <Field label="Last name" error={errors.lastName} required>
        <Input name="family-name" autoComplete={auto("family-name")} value={value.lastName} onChange={set("lastName")} maxLength={NAME_PART_MAX} disabled={disabled} />
      </Field>
      <Field
        label="Preferred name (optional)"
        hint={subject === "your" ? "What you'd like us to call you in greetings." : "Used in greetings instead of the first name."}
        error={errors.preferredName}
        className="sm:col-span-2"
      >
        <Input name="nickname" autoComplete={auto("nickname")} value={value.preferredName} onChange={set("preferredName")} maxLength={NAME_PART_MAX} disabled={disabled} />
      </Field>
    </div>
  );
}
