export const ORDER_FILE_FOLDER_TOKENS = ["customer_ref", "order_ref", "order_name", "phase", "slot", "yyyy", "mm"] as const;
export type OrderFileFolderToken = (typeof ORDER_FILE_FOLDER_TOKENS)[number];
export const DEFAULT_ORDER_FILE_FOLDER_TEMPLATE = "customers/{customer_ref}/orders/{order_ref}/{phase}";

const tokenPattern = /\{([a-z_]+)\}/gu;
const tokenNames = new Set<string>(ORDER_FILE_FOLDER_TOKENS);
export const STAGE_FILE_FOLDER_TOKENS = ["phase_key", "order_number", "customer_folder"] as const;
export type StageFileFolderToken = (typeof STAGE_FILE_FOLDER_TOKENS)[number];
const stageTokenNames = new Set<string>([...ORDER_FILE_FOLDER_TOKENS, ...STAGE_FILE_FOLDER_TOKENS]);
const unsafe = /[\\%#:"<>?*|{}\p{C}]/u;
const unsafeValue = /[/\\%#:"<>?*|{}\p{C}]/gu;
const reserved = /^(?:\.{1,2}|\.lock|(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|desktop\.ini)(?:\.|$)|~\$)|_vti_/iu;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const segmentLimit = 180;

function validSegment(value: string): boolean {
  return value.length > 0 && value.length <= segmentLimit && value === value.trim() &&
    !value.endsWith(".") && !unsafe.test(value) && !reserved.test(value);
}

function validSegments(parts: string[]): boolean {
  return parts.length > 0 && parts.length <= 8 && parts.every(validSegment) && parts.join("/").length <= 400;
}

/** Replace untrusted names with a single NFC segment; never use the original as a path. */
export function safeOrderFileFolderValue(value: string, maxBytes = 48): string {
  const normalized = value.normalize("NFC").replace(unsafeValue, "_").replace(/^[.\s]+|[.\s]+$/gu, "");
  let safe = "";
  for (const char of normalized) {
    if (byteLength(safe + char) > maxBytes) break;
    safe += char;
  }
  safe = safe.replace(/[.\s]+$/gu, "");
  return !safe || reserved.test(safe) ? "unspecified" : safe;
}

/** Check literal parts and token spelling at save time, before values are available. */
export function isOrderFileFolderTemplate(template: string): boolean {
  return isFolderTemplate(template, tokenNames);
}

function isFolderTemplate(template: string, allowed: ReadonlySet<string>): boolean {
  if (template.length > 400 || template.normalize("NFC") !== template) return false;
  return validSegments(template.replace(tokenPattern, (match, token: string) => allowed.has(token) ? "x" : match).split("/"));
}

/** Managed folders leave room for the two frozen order-root segments. */
export function isStageOrderFileFolderTemplate(template: string): boolean {
  return template.split("/").length <= 6 && isFolderTemplate(template, stageTokenNames);
}

export function resolveStageOrderFileFolder(template: string, values: Record<OrderFileFolderToken | StageFileFolderToken, string>): string[] {
  if (!isStageOrderFileFolderTemplate(template)) throw new RangeError("ORDER_FILE_FOLDER_INVALID");
  const segments = template.replace(tokenPattern, (_match, token: OrderFileFolderToken | StageFileFolderToken) =>
    safeOrderFileFolderValue(values[token], token === "customer_folder" || token === "order_number" ? 80 : 48)).split("/");
  if (!isResolvedOrderFileFolder(segments)) throw new RangeError("ORDER_FILE_FOLDER_INVALID");
  return segments;
}

/** Check the complete expanded path again; invalid paths are never sent to an adapter. */
export function resolveOrderFileFolder(template: string, values: Record<OrderFileFolderToken, string>): string[] {
  if (!isOrderFileFolderTemplate(template)) throw new RangeError("ORDER_FILE_FOLDER_INVALID");
  const segments = template.replace(tokenPattern, (_match, token: OrderFileFolderToken) => safeOrderFileFolderValue(values[token])).split("/");
  if (!validSegments(segments)) throw new RangeError("ORDER_FILE_FOLDER_INVALID");
  return segments;
}

/** Checks an already resolved path from a persisted copy intent. */
export function isResolvedOrderFileFolder(segments: string[]): boolean {
  return !segments.some((segment) => segment.includes("/") || segment !== segment.normalize("NFC")) && validSegments(segments);
}
