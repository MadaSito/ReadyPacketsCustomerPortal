import type {
  MailTemplateCategory,
  MailTemplateFormat,
  MailTemplateKind,
  MailTemplateVariableSpec,
} from "@server/modules/mailTemplates/schema";

export const MAIL_TEMPLATES_BASE = "/admin/email-templates";

export const CATEGORY_LABELS: Record<MailTemplateCategory, string> = {
  auth: "Account and sign-in",
  orders: "Orders",
  compliance: "Billing and compliance",
  engagement: "Support and messaging",
  operations: "Platform operations",
  automation: "Automations",
};

export const CATEGORY_OPTIONS = [
  { value: "", label: "All categories" },
  { value: "auth", label: CATEGORY_LABELS.auth },
  { value: "orders", label: CATEGORY_LABELS.orders },
  { value: "compliance", label: CATEGORY_LABELS.compliance },
  { value: "engagement", label: CATEGORY_LABELS.engagement },
  { value: "operations", label: CATEGORY_LABELS.operations },
  { value: "automation", label: CATEGORY_LABELS.automation },
] as const;

export const KIND_OPTIONS = [
  { value: "", label: "All template kinds" },
  { value: "system", label: "System templates" },
  { value: "custom", label: "Custom templates" },
] as const;

export const CUSTOM_CATEGORY_OPTIONS: readonly { value: MailTemplateCategory; label: string }[] = [
  { value: "automation", label: CATEGORY_LABELS.automation },
  { value: "orders", label: CATEGORY_LABELS.orders },
  { value: "compliance", label: CATEGORY_LABELS.compliance },
  { value: "engagement", label: CATEGORY_LABELS.engagement },
  { value: "operations", label: CATEGORY_LABELS.operations },
];

export const FORMAT_OPTIONS: readonly { value: MailTemplateFormat; label: string; description: string }[] = [
  {
    value: "html",
    label: "HTML with plain-text alternative",
    description: "Formatted message body sanitised on save and on send, paired with a plain-text version.",
  },
  {
    value: "text",
    label: "Plain text only",
    description: "Sends a plain-text message body without HTML markup.",
  },
];

const PLACEHOLDER_SCAN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,63})\s*\}\}/g;

export function extractPlaceholdersClient(input: string): Set<string> {
  const found = new Set<string>();
  PLACEHOLDER_SCAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_SCAN_RE.exec(input)) !== null) {
    found.add(match[1]!);
  }
  return found;
}

export function findMissingRequiredVariables(params: {
  declaredVars: readonly MailTemplateVariableSpec[];
  format: MailTemplateFormat;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  deriveTextFromHtml: boolean;
}): string[] {
  const required = params.declaredVars.filter((v) => v.required || v.sensitive);
  if (required.length === 0) return [];

  const inSubject = extractPlaceholdersClient(params.subject);
  const inHtml = params.format === "html" ? extractPlaceholdersClient(params.bodyHtml) : new Set<string>();
  const inText =
    params.format === "html" && params.deriveTextFromHtml
      ? inHtml
      : extractPlaceholdersClient(params.bodyText);

  const missing: string[] = [];
  for (const v of required) {
    const presentInHtmlBranch = params.format !== "html" || inSubject.has(v.name) || inHtml.has(v.name);
    const presentInTextBranch = inSubject.has(v.name) || inText.has(v.name);
    if (!presentInHtmlBranch || !presentInTextBranch) {
      missing.push(v.name);
    }
  }
  return missing;
}

export function normalizeCustomTemplateKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const withoutPrefix = trimmed.startsWith("custom.") ? trimmed.slice("custom.".length) : trimmed;
  const cleanSlug = withoutPrefix.replace(/[^a-z0-9_]/g, "_").replace(/^_+/, "");
  if (!cleanSlug) return "";
  return `custom.${cleanSlug}`;
}

export function describeTemplateDeliveryState(item: {
  kind: MailTemplateKind;
  hasPublishedOverride: boolean;
  publishedVersionNumber?: number | null;
}): { label: string; tone: "neutral" | "info" | "success" | "warning" } {
  if (item.kind === "system") {
    if (item.hasPublishedOverride) {
      return {
        label: item.publishedVersionNumber ? `Customised (v${item.publishedVersionNumber})` : "Customised",
        tone: "info",
      };
    }
    return { label: "Built-in default", tone: "neutral" };
  }
  if (item.hasPublishedOverride) {
    return {
      label: item.publishedVersionNumber ? `Published (v${item.publishedVersionNumber})` : "Published",
      tone: "success",
    };
  }
  return { label: "Draft only", tone: "warning" };
}
