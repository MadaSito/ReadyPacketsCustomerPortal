import { Eye, EyeOff } from "lucide-react";
import { useState, type Ref } from "react";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button, Field, Input } from "@/ui";

export type CredentialFieldKey =
  | "stripeSecretKey"
  | "stripeWebhookSecret"
  | "stripeWebhookSecretSecondary"
  | "squareAccessToken"
  | "squareWebhookSignatureKey";

const CREDENTIAL_FIELD_SET: ReadonlySet<string> = new Set<CredentialFieldKey>([
  "stripeSecretKey",
  "stripeWebhookSecret",
  "stripeWebhookSecretSecondary",
  "squareAccessToken",
  "squareWebhookSignatureKey",
]);

const SURROUNDING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];

const MASK_CHAR_PATTERN = /[•*…\u2022\u2217]/u;

/**
 * Normalizes pasted secret inputs before validation and submission:
 * - strips zero-width characters, BOM, and non-breaking spaces
 * - trims outer whitespace
 * - strips matching surrounding quotes or backticks from CLI/env pastes
 * - strips internal whitespace/newlines from line-wrapped pastes
 */
export function normalizeCredentialInput(raw: string): string {
  let cleaned = raw.replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/gu, "").trim();
  for (const [open, close] of SURROUNDING_QUOTE_PAIRS) {
    if (cleaned.length >= 2 && cleaned.startsWith(open) && cleaned.endsWith(close)) {
      cleaned = cleaned.slice(open.length, cleaned.length - close.length).trim();
      break;
    }
  }
  return cleaned.replace(/[\s\u200B-\u200D\u2060\uFEFF\u00A0]+/gu, "");
}

export type ClientFieldValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

/**
 * Validates a non-blank Stripe API secret key (`sk_*` / `rk_*`) against `mode`.
 * Describes the shape of a rejected value without echoing its content.
 */
export function validateStripeSecretKeyField(
  raw: string,
  mode: "test" | "live",
): ClientFieldValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const label = "Stripe API secret key";

  if (/^pk_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a Stripe publishable key (pk_…). ReadyPackets does not use publishable keys. Paste the secret key (sk_…) or restricted key (rk_…) from Stripe Developers > API keys.`,
    };
  }
  if (/^whsec_/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a webhook signing secret (whsec_…) — paste it into Primary Stripe webhook signing secret instead.`,
    };
  }
  if (/^we_/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a webhook endpoint ID (we_…), not an API secret key. Copy the sk_… or rk_… key from Stripe Developers > API keys.`,
    };
  }
  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This value contains masking characters (such as •••• or *). Reveal the full key in Stripe Developers > API keys before copying.`,
    };
  }
  if (mode === "live" && /^(?:sk|rk)_test_/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This is a test-mode key (sk_test_… / rk_test_…), while the target environment is Live payments. Paste a live key (sk_live_… / rk_live_…) or switch the environment to Test / sandbox.`,
    };
  }
  if (mode === "test" && /^(?:sk|rk)_live_/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This is a live-mode key (sk_live_… / rk_live_…), while the target environment is Test / sandbox. Paste a test key (sk_test_… / rk_test_…) or switch the environment to Live payments.`,
    };
  }
  const expectedPrefix = mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
  const expectedHint = mode === "live" ? "sk_live_… or rk_live_…" : "sk_test_… or rk_test_…";
  if (!expectedPrefix.test(normalized)) {
    return {
      ok: false,
      error: `${label}: Must start with ${expectedHint} from Stripe Developers > API keys.`,
    };
  }
  if (normalized.length < 16) {
    return {
      ok: false,
      error: `${label}: Value is shorter than a complete Stripe API key. Copy the full revealed key from Stripe Developers > API keys.`,
    };
  }
  if (normalized.length > 256) {
    return {
      ok: false,
      error: `${label}: Value is longer than expected (maximum 256 characters). Paste only the single key value.`,
    };
  }
  if (!/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/u.test(normalized)) {
    return {
      ok: false,
      error: `${label}: Contains unexpected punctuation or characters. Copy only the ${expectedHint} token from Stripe.`,
    };
  }
  return { ok: true, normalized };
}

/**
 * Validates a non-blank Stripe webhook signing secret (`whsec_*`).
 * Describes the shape of a rejected value without echoing its content.
 */
export function validateStripeWebhookSecretField(
  raw: string,
  field: "stripeWebhookSecret" | "stripeWebhookSecretSecondary",
): ClientFieldValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const label =
    field === "stripeWebhookSecret"
      ? "Primary Stripe webhook signing secret"
      : "Secondary Stripe webhook signing secret";

  if (/^pk_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a Stripe publishable key (pk_…). Open Stripe Workbench > Webhooks > select your endpoint > Signing secret > Reveal to copy the whsec_… value.`,
    };
  }
  if (/^(?:sk|rk)_(?:test_|live_)?/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a Stripe API key (sk_… / rk_…) — API keys belong in Stripe API secret key. Paste the whsec_… signing secret from your Stripe webhook endpoint here.`,
    };
  }
  if (/^we_/iu.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This looks like a webhook endpoint ID (we_…), not the signing secret. In Stripe Workbench > Webhooks, open the endpoint and click Reveal under Signing secret to copy the whsec_… value.`,
    };
  }
  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This value contains masking characters (such as •••• or *). Click Reveal under Signing secret in Stripe before copying.`,
    };
  }
  if (!normalized.startsWith("whsec_")) {
    return {
      ok: false,
      error: `${label}: Must start with whsec_. Copy the revealed Signing secret from Stripe Workbench > Webhooks > your endpoint > Signing secret > Reveal.`,
    };
  }
  if (normalized.length < 16) {
    return {
      ok: false,
      error: `${label}: Value after whsec_ is too short to be a complete Stripe signing secret. Click Reveal in Stripe and copy the entire secret.`,
    };
  }
  if (normalized.length > 256) {
    return {
      ok: false,
      error: `${label}: Value is longer than expected (maximum 256 characters). Paste only the single whsec_… secret.`,
    };
  }
  if (!/^whsec_[A-Za-z0-9+/=_-]+$/u.test(normalized)) {
    return {
      ok: false,
      error: `${label}: Contains unexpected characters outside whsec_ signing secret characters. Copy only the revealed whsec_… token from Stripe.`,
    };
  }
  return { ok: true, normalized };
}

export function validateSquareSecretField(
  raw: string,
  field: "squareAccessToken" | "squareWebhookSignatureKey",
): ClientFieldValidationResult {
  const normalized = normalizeCredentialInput(raw);
  const label = field === "squareAccessToken" ? "Square access token" : "Square webhook signature key";
  const minLen = field === "squareAccessToken" ? 16 : 12;

  if (MASK_CHAR_PATTERN.test(normalized)) {
    return {
      ok: false,
      error: `${label}: This value contains masking characters. Copy the full unmasked credential from Square Developer Console.`,
    };
  }
  if (normalized.length < minLen) {
    return {
      ok: false,
      error: `${label}: Value is too short to be a complete ${label.toLowerCase()}.`,
    };
  }
  if (normalized.length > 256) {
    return {
      ok: false,
      error: `${label}: Value is longer than expected (maximum 256 characters).`,
    };
  }
  const pattern =
    field === "squareAccessToken"
      ? /^[A-Za-z0-9_-]{16,256}$/u
      : /^[A-Za-z0-9+/=_-]{12,256}$/u;
  if (!pattern.test(normalized)) {
    return {
      ok: false,
      error: `${label}: Value contains unexpected characters for a ${label.toLowerCase()}.`,
    };
  }
  return { ok: true, normalized };
}

export function isLikelyValidWhsec(raw: string): boolean {
  if (!raw.trim()) return false;
  return validateStripeWebhookSecretField(raw, "stripeWebhookSecretSecondary").ok;
}

export function extractServerCredentialFieldError(
  error: unknown,
  fallback: string,
): { field?: CredentialFieldKey; message: string } {
  const safe = safeError(error);
  const message = errorMessage(error, fallback);
  if (safe?.details && typeof safe.details === "object") {
    const candidate = (safe.details as Record<string, unknown>).field;
    if (typeof candidate === "string" && CREDENTIAL_FIELD_SET.has(candidate)) {
      return { field: candidate as CredentialFieldKey, message };
    }
  }
  if (safe?.fieldErrors) {
    for (const key of Object.keys(safe.fieldErrors)) {
      if (CREDENTIAL_FIELD_SET.has(key)) {
        const firstMsg = safe.fieldErrors[key]?.[0];
        return { field: key as CredentialFieldKey, message: firstMsg ?? message };
      }
    }
  }
  return { message };
}

export interface SecretCredentialFieldProps {
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean | undefined;
  value: string;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
  onChange: (nextValue: string) => void;
}

/**
 * WCAG 2.2 AA secret input with:
 * - anti-autofill attributes so password managers do not overwrite adjacent secret fields
 * - 44x44px accessible Show/Hide toggle button (`aria-pressed`, distinct `aria-label`)
 * - automatic re-masking when cleared after save
 * - `Field` context wiring (`aria-describedby` for hint + inline error, `aria-invalid`)
 * - no character counter
 */
export function SecretCredentialField({
  label,
  hint,
  error,
  required,
  value,
  disabled,
  placeholder,
  inputRef,
  onChange,
}: SecretCredentialFieldProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Field
      label={label}
      hint={hint ? <span className="break-words [overflow-wrap:anywhere]">{hint}</span> : undefined}
      error={error ? <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{error}</span> : undefined}
      required={required}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          type={revealed ? "text" : "password"}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          maxLength={512}
          className="font-mono text-sm"
          onChange={(event) => {
            const nextVal = event.target.value;
            if (nextVal === "") setRevealed(false);
            onChange(nextVal);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-11 min-w-11 shrink-0 px-3"
          disabled={disabled}
          aria-pressed={revealed}
          aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
          onClick={() => setRevealed((prev) => !prev)}
        >
          {revealed ? (
            <EyeOff className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Eye className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="ml-1.5">{revealed ? "Hide" : "Show"}</span>
        </Button>
      </div>
    </Field>
  );
}
