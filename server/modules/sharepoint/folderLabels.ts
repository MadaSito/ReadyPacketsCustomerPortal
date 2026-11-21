/**
 * Folder labels for order files on remote storage (master prompt §6, increment-03 package H).
 *
 *   customer folder:  <first two characters of the first name><full last name>_<customer reference>
 *                     e.g. "JoSmith_CUST-0042"
 *   order folder:     <order reference> <safe project label>
 *                     e.g. "RP-2026-0001 Riverside Clinic Packet"
 *
 * Labels are DISPLAY METADATA only: never authority for ownership or access, never logged, never put in
 * audit attributes. Once assigned, a label is persisted and reused (labelStore.ts): renaming a customer or
 * project never silently renames existing remote folders.
 *
 * Rules (pure, deterministic, tested):
 *  - Unicode: NFC; control, format (incl. bidi overrides), private-use and unassigned code points removed;
 *    letters/marks/numbers of every script kept; length counted and cut in grapheme clusters, so a
 *    combining sequence or emoji is never split.
 *  - Characters invalid in SharePoint / OneDrive / Windows names (" * : < > ? / \ | and others) become a
 *    space; runs of separators collapse; leading/trailing dots, spaces, hyphens and underscores trimmed.
 *  - Reserved names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, desktop.ini, names starting "~$", containing
 *    "_vti_") are prefixed with "_".
 *  - Length: each segment ≤ SEGMENT_MAX graphemes (and ≤ SEGMENT_MAX_UTF16 code units).
 *  - Collisions: case- and compatibility-insensitive key (labelKey); the store appends " (2)", " (3)", …
 *    within the same parent, keeping the result within the length limit.
 */

export const SEGMENT_MAX = 80;
const SEGMENT_MAX_UTF16 = 160;
const PROJECT_MAX = 60;
const NAME_PART_MAX = 40;
const REFERENCE_MAX = 32;

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (g) => g.segment);

/** Characters that are not allowed in OneDrive/SharePoint/Windows path segments, or are risky in URLs. */
const INVALID = /["*:<>?/\\|#%{}~&+=;,[\]^`$@!]/gu;
/** Control, format (bidi), surrogate, private-use and unassigned code points. */
const NON_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/gu;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|forms)(\..*)?$/iu;

function truncateGraphemes(s: string, max: number): string {
  const parts = graphemes(s);
  let out = "";
  for (const part of parts.slice(0, max)) {
    if (out.length + part.length > SEGMENT_MAX_UTF16) break;
    out += part;
  }
  return out;
}

function trimEdges(s: string): string {
  return s.replace(/^[\s._-]+|[\s._-]+$/gu, "");
}

/** Cleans arbitrary text into a safe single path-segment fragment (may return ""). */
export function cleanText(input: string | null | undefined, max: number): string {
  if (!input) return "";
  const cleaned = input
    .normalize("NFC")
    .replace(NON_TEXT, "")
    .replace(INVALID, " ")
    .replace(/[\s\u00a0\u3000]+/gu, " ");
  return trimEdges(truncateGraphemes(trimEdges(cleaned), max));
}

/** Final guard for a complete segment: never empty, never reserved, within limits. */
export function safeSegment(input: string, fallback = "Folder"): string {
  let s = cleanText(input, SEGMENT_MAX);
  if (!s) s = fallback;
  if (RESERVED.test(s) || s.startsWith("~$") || /_vti_/iu.test(s)) s = truncateGraphemes(`_${s}`, SEGMENT_MAX);
  return s;
}

/** Compact name fragment: letters/marks/numbers of the name, no spaces (e.g. "O'Brien-Smith" → "OBrienSmith"). */
function compactName(input: string | null | undefined, max: number): string {
  return truncateGraphemes(cleanText(input, max * 2).replace(/[^\p{L}\p{M}\p{N}]+/gu, ""), max);
}

export interface CustomerLabelInput {
  firstName: string | null;
  lastName: string | null;
  customerReference: string | null;
}

export function customerFolderLabel(input: CustomerLabelInput): string {
  const first = graphemes(compactName(input.firstName, NAME_PART_MAX)).slice(0, 2).join("");
  const last = compactName(input.lastName, NAME_PART_MAX);
  const name = `${first}${last}` || "Customer";
  const ref = cleanText(input.customerReference, REFERENCE_MAX).replace(/\s+/gu, "-");
  return safeSegment(ref ? `${name}_${ref}` : name, "Customer");
}

export interface OrderLabelInput {
  reference: string;
  projectName: string | null;
}

export function orderFolderLabel(input: OrderLabelInput): string {
  const ref = cleanText(input.reference, REFERENCE_MAX).replace(/\s+/gu, "-") || "Order";
  const project = cleanText(input.projectName, PROJECT_MAX);
  return safeSegment(project ? `${ref} ${project}` : ref, "Order");
}

/** Collision key: compatibility-folded, case-folded, whitespace-insensitive. */
export function labelKey(label: string): string {
  return label.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

/** `label`, or `label (n)` for the first n ≥ 2 whose key is free; stays within SEGMENT_MAX. */
export function disambiguate(label: string, isTaken: (key: string) => boolean, maxTries = 1000): string {
  if (!isTaken(labelKey(label))) return label;
  for (let n = 2; n <= maxTries; n++) {
    const suffix = ` (${n})`;
    const base = trimEdges(truncateGraphemes(label, SEGMENT_MAX - suffix.length));
    const candidate = `${base}${suffix}`;
    if (!isTaken(labelKey(candidate))) return candidate;
  }
  throw new Error("folder label collision limit reached");
}
