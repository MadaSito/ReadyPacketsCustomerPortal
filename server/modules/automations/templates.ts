/**
 * Logic-less `{{variable}}` substitution, header/control-character hygiene, and HMAC-SHA256 webhook signing
 * (Decision 9, Section 4, Gate 4.1 J).
 */
import { createHmac } from "node:crypto";
import { validation } from "../../core/errors.js";
import type { AutomationScalarValue } from "./contracts.js";

const VALID_PLACEHOLDER_TOKEN = /^\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}$/;
const ANY_MUSTACHE_LIKE = /\{\{[\s\S]*?\}\}|\{|\}/g;
const HEADER_CONTROL_CHARS = /[\r\n\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const BODY_FORBIDDEN_CONTROL = /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Parses a logic-less template string (`"Order {{order_reference}} created"`) and rejects any invalid syntax,
 * unclosed braces, expressions (`{{a + b}}`, `{{#if}}`), or undeclared variable names.
 */
export function extractAndValidateTemplateVars(
  template: string,
  allowedKeys: ReadonlySet<string>,
  options: { singleLine?: boolean; fieldLabel: string },
): string[] {
  if (options.singleLine && HEADER_CONTROL_CHARS.test(template)) {
    throw validation(
      "TEMPLATE_CONTROL_CHARS",
      `${options.fieldLabel} must not contain line breaks or control characters.`,
    );
  }
  if (!options.singleLine && BODY_FORBIDDEN_CONTROL.test(template)) {
    throw validation(
      "TEMPLATE_CONTROL_CHARS",
      `${options.fieldLabel} contains unsupported control characters.`,
    );
  }

  const referenced = new Set<string>();
  const matches = template.matchAll(/\{\{([\s\S]*?)\}\}/g);
  for (const match of matches) {
    const full = match[0];
    const parsed = VALID_PLACEHOLDER_TOKEN.exec(full);
    if (!parsed) {
      throw validation(
        "INVALID_TEMPLATE_PLACEHOLDER",
        `${options.fieldLabel} contains invalid placeholder "${full.slice(0, 32)}". Only simple {{field_name}} placeholders are permitted.`,
      );
    }
    const varName = parsed[1]!;
    if (!allowedKeys.has(varName)) {
      throw validation(
        "UNKNOWN_TEMPLATE_VARIABLE",
        `${options.fieldLabel} references "${varName}", which is not declared on the selected trigger.`,
      );
    }
    referenced.add(varName);
  }

  // Reject stray `{` or `}` outside valid `{{field}}` tokens (blocks triple-stache `{{{raw}}}` or broken syntax).
  const stripped = template.replace(/\{\{\s*[a-z][a-z0-9_]{0,63}\s*\}\}/g, "");
  if (ANY_MUSTACHE_LIKE.test(stripped)) {
    ANY_MUSTACHE_LIKE.lastIndex = 0;
    throw validation(
      "INVALID_TEMPLATE_SYNTAX",
      `${options.fieldLabel} contains stray braces. Use {{field_name}} placeholders only.`,
    );
  }

  return [...referenced];
}

export function sanitizeHeaderScalar(value: AutomationScalarValue | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\r\n\0\x01-\x1f\x7f]+/g, " ").trim();
}

export function sanitizeBodyScalar(value: AutomationScalarValue | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, "");
}

/**
 * Renders a plain-text template (`subjectTemplate`, `titleTemplate`, `bodyTemplate`) without HTML interpretation.
 */
export function renderPlainTemplate(
  template: string,
  vars: Readonly<Record<string, AutomationScalarValue>>,
  options: { singleLine?: boolean } = {},
): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g, (_match, key: string) => {
    const raw = vars[key];
    return options.singleLine ? sanitizeHeaderScalar(raw) : sanitizeBodyScalar(raw);
  });
}

/**
 * Computes timestamped HMAC-SHA256 webhook signature (`v1=<hex>` over `${timestampSec}.${rawBody}`).
 */
export function signAutomationWebhook(
  signingSecret: string,
  timestampSec: number,
  rawBody: string,
): string {
  const mac = createHmac("sha256", signingSecret)
    .update(`${timestampSec}.${rawBody}`, "utf8")
    .digest("hex");
  return `v1=${mac}`;
}
