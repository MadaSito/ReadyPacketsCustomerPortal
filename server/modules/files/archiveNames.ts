/**
 * Safe ZIP entry names (D8). Server-derived only: no client path ever reaches an entry name.
 * - NFC; control/format characters, `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` become `_`; leading dots/spaces trimmed.
 * - Never absolute, never `.` or `..` segments; Windows reserved device names are prefixed with `_`.
 * - At most 120 characters, extension kept; case-insensitive duplicates get ` (2)`, ` (3)`… before the extension.
 * - Order archives: one folder per phase (sanitised stage key) plus `Order files/` for unphased files.
 */

const MAX_NAME = 120;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
export const UNPHASED_FOLDER = "Order files";

/** ASCII download filename, distinct from the member names inside the ZIP. */
export function archiveDownloadName(reference: string, stageKey: string | null, customerLabel?: string): string {
  const ascii = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "");
  const stem = ascii(reference).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 64) || "order";
  const slug = (value: string) => ascii(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const suffix = stageKey ? (slug(customerLabel ?? "") || slug(stageKey) || "phase") : "all-files";
  return `${stem}-${suffix.slice(0, MAX_NAME - stem.length - "-.zip".length).replace(/-+$/u, "")}.zip`;
}

export function sanitiseSegment(raw: string, fallback = "file"): string {
  let name = raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, "_").replace(/\s+/gu, " ");
  name = name.replace(/^[.\s]+/u, "").replace(/[.\s]+$/u, "");
  if (!name || name === "." || name === "..") name = fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  return truncate(name, MAX_NAME);
}

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 12) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

function truncate(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const [base, ext] = splitExtension(name);
  const keep = Math.max(1, max - Array.from(ext).length);
  return Array.from(base).slice(0, keep).join("").replace(/[.\s]+$/u, "") + ext;
}

export interface NameInput { displayName: string; extension?: string | null; stageKey: string | null }

/** Returns one entry name per input, in order, unique case-insensitively across the whole archive. */
export function archiveEntryNames(files: readonly NameInput[], scope: "stage" | "order"): string[] {
  const used = new Set<string>();
  return files.map((file) => {
    let base = sanitiseSegment(file.displayName);
    const ext = file.extension ? `.${file.extension.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toLowerCase()}` : "";
    if (ext.length > 1 && !base.toLowerCase().endsWith(ext)) base = truncate(`${base}${ext}`, MAX_NAME);
    const folder = scope === "order" ? `${file.stageKey ? sanitiseSegment(file.stageKey, "phase") : UNPHASED_FOLDER}/` : "";
    const [stem, extension] = splitExtension(base);
    let candidate = `${folder}${base}`;
    // Reserve the suffix and extension first, truncate only the stem; bounded by the manifest length.
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      if (n > files.length + 1) throw new Error("archive entry names could not be made unique");
      const suffix = ` (${n})`;
      const room = Math.max(1, MAX_NAME - Array.from(extension).length - suffix.length);
      const cut = Array.from(stem).slice(0, room).join("").replace(/[.\s]+$/u, "") || "file";
      candidate = `${folder}${cut}${suffix}${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Defence in depth for the writer: every segment must already be a sanitised segment (no traversal, colons,
 * reserved device names, control characters or over-long names). */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 260 || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((segment) => {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (/[\p{Cc}\p{Cf}:*?"<>|]/u.test(segment) || RESERVED.test(segment)) return false;
    if (/^[.\s]|[.\s]$/u.test(segment) || Array.from(segment).length > MAX_NAME) return false;
    return segment === segment.normalize("NFC");
  });
}
