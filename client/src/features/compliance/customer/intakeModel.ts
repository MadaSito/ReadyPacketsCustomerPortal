import type { IntakeAnswerMap } from "@server/modules/compliance/domain";
import type { StoredIntakeFieldDef } from "@server/modules/compliance/schema";
import { safeError } from "@/lib/trpc";

export type FieldErrors = Record<string, string>;

export function prepareAnswers(fields: readonly StoredIntakeFieldDef[], values: IntakeAnswerMap, submit: boolean) {
  const answers: Record<string, string | number | string[] | null> = Object.create(null);
  const errors: FieldErrors = Object.create(null);
  for (const field of fields) {
    const raw = Object.hasOwn(values, field.key) ? values[field.key] : null;
    const value = typeof raw === "string" ? raw.normalize("NFC").trim() : raw;
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      if (submit && field.required) errors[field.key] = "Answer this required question.";
      answers[field.key] = null;
      continue;
    }
    switch (field.type) {
      case "short_text":
      case "long_text": {
        const max = field.maxLength ?? (field.type === "short_text" ? 500 : 8000);
        if (typeof value !== "string") errors[field.key] = "Enter text.";
        else if (value.length > max) errors[field.key] = `Enter no more than ${max} characters.`;
        else if (submit && field.minLength !== undefined && value.length < field.minLength) errors[field.key] = `Enter at least ${field.minLength} characters.`;
        break;
      }
      case "single_choice":
        if (!field.options?.some((option) => option.value === value)) errors[field.key] = "Choose one of the listed options.";
        break;
      case "multi_choice":
        if (!Array.isArray(value) || value.some((entry) => !field.options?.some((option) => option.value === entry))) {
          errors[field.key] = "Choose only listed options.";
        } else if (field.maxSelections !== undefined && value.length > field.maxSelections) {
          errors[field.key] = `Choose no more than ${field.maxSelections} options.`;
        } else if (submit && field.minSelections !== undefined && value.length < field.minSelections) {
          errors[field.key] = `Choose at least ${field.minSelections} options.`;
        }
        break;
      case "number": {
        const parsed = typeof value === "number" || (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) ? Number(value) : NaN;
        if (!Number.isFinite(parsed)) errors[field.key] = "Enter a valid number.";
        else if (parsed > (field.maxNumber ?? 1e12)) errors[field.key] = `Enter a number no greater than ${field.maxNumber ?? 1e12}.`;
        else if (parsed < -1e12 || (submit && field.minNumber !== undefined && parsed < field.minNumber)) {
          errors[field.key] = `Enter a number no smaller than ${submit ? field.minNumber ?? -1e12 : -1e12}.`;
        }
        answers[field.key] = Number.isFinite(parsed) ? parsed : null;
        continue;
      }
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors[field.key] = "Enter a valid calendar date.";
        else {
          const d = new Date(`${value}T00:00:00Z`);
          if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) errors[field.key] = "Enter a valid calendar date.";
        }
        break;
    }
    answers[field.key] = typeof value === "string" || typeof value === "number" ? value : [...value];
  }
  return { answers, errors };
}

export function intakeFieldErrors(error: unknown, fields: readonly StoredIntakeFieldDef[]): FieldErrors {
  const safe = safeError(error);
  const errors: FieldErrors = Object.create(null);
  const fieldKeys = new Set(fields.map((field) => field.key));
  const key = safe?.details?.field;
  if (typeof key === "string" && fieldKeys.has(key) && safe) errors[key] = safe.safeMessage;
  const missing = safe?.details?.missingFields;
  if (Array.isArray(missing)) for (const missingKey of missing) {
    if (typeof missingKey === "string" && fieldKeys.has(missingKey)) errors[missingKey] = "Answer this required question.";
  }
  for (const [path, messages] of Object.entries(safe?.fieldErrors ?? {})) {
    const pathKey = path.split(".")[1];
    if (path.startsWith("answers.") && pathKey && fieldKeys.has(pathKey) && messages[0]) errors[pathKey] = messages[0];
  }
  return errors;
}
