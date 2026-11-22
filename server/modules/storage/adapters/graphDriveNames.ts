/**
 * SharePoint Online / OneDrive for Business naming rules for the Graph drive adapter (increment 04 part B,
 * package W). Pure and deterministic: the same input always maps to the same safe name, and mapping a mapped
 * name changes nothing, so retries and concurrent workers target the same remote path.
 *
 * Rules applied (Microsoft "Restrictions and limitations in OneDrive and SharePoint"):
 *  - characters " * : < > ? / \ | are replaced by "_"; control and format characters are dropped;
 *  - leading spaces, trailing spaces and trailing dots are removed;
 *  - reserved names CON, PRN, AUX, NUL, COM0–9, LPT0–9 (also with an extension), ".lock", "desktop.ini",
 *    a leading "~$", "_vti_" anywhere, and a top-level "forms" folder are altered;
 *  - a name has at most 255 characters (shortened with "~" and 8 hex characters of a SHA-256 of the
 *    original, keeping a file's extension);
 *  - the decoded path, including the library's server-relative path, the configured root and the file name,
 *    has at most 400 characters (`fitFileName`).
 */
import { createHash } from "node:crypto";

export const MAX_SEGMENT = 255;
export const MAX_DECODED_PATH = 400;
/** Most "name (n).ext" variants tried for a same-name conflict before giving up (never overwrite). */
export const MAX_SUFFIX = 99;

const RESERVED_CHARS = /["*:<>?/\\|]/gu;
const DROPPED = /[\p{Cc}\p{Cf}]/gu;
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/iu;
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/u;

const hash8 = (raw: string) => createHash("sha256").update(raw.normalize("NFC"), "utf8").digest("hex").slice(0, 8);
const chars = (s: string) => Array.from(s);
const trimEnd = (s: string) => s.replace(/[\s.]+$/u, "");

/** Splits "report.final.pdf" into ["report.final", ".pdf"]; names without a usable extension keep "". */
export function splitExtension(name: string): [string, string] {
  const m = EXTENSION.exec(name);
  if (!m || m.index === 0) return [name, ""];
  return [name.slice(0, m.index), m[0]];
}

/** Cuts `name` to `max` characters, keeping a file's extension, marking the cut with "~" + hash of `raw`. */
function shorten(name: string, max: number, raw: string, file: boolean): string {
  if (name.length <= max) return name;
  const [base, ext] = file ? splitExtension(name) : [name, ""];
  const mark = `~${hash8(raw)}`;
  const room = Math.max(1, max - ext.length - mark.length);
  let cut = "";
  for (const ch of chars(base)) {
    if (cut.length + ch.length > room) break;
    cut += ch;
  }
  cut = trimEnd(cut) || "_";
  return `${cut}${mark}${ext}`;
}

/**
 * Maps one path segment to a SharePoint/OneDrive-safe name. `topLevel` marks a folder directly under the
 * drive root (where "forms" is reserved in document libraries).
 */
export function safeDriveName(raw: string, options: { file: boolean; topLevel?: boolean }): string {
  let s = raw.normalize("NFC").replace(DROPPED, "").replace(RESERVED_CHARS, "_");
  s = trimEnd(s.replace(/^\s+/u, ""));
  if (s === "") s = "_";
  if (s.startsWith("~$")) s = `~_${s.slice(2)}`;
  s = s.replace(/_vti_/giu, "_vti-");
  const firstDot = s.indexOf(".");
  const stem = firstDot === -1 ? s : s.slice(0, firstDot);
  if (DEVICE.test(stem)) s = `${stem}_${s.slice(stem.length)}`;
  const lower = s.toLowerCase();
  if (lower === "desktop.ini") s = `${s.slice(0, 7)}_${s.slice(7)}`;
  if (lower === ".lock") s = `_${s}`;
  if (!options.file && options.topLevel && lower === "forms") s = `${s}_`;
  return shorten(s, MAX_SEGMENT, raw, options.file);
}

/** The n-th conflict variant: "name.ext", "name (1).ext", "name (2).ext", … */
export function conflictVariant(name: string, n: number): string {
  if (n === 0) return name;
  const [base, ext] = splitExtension(name);
  return `${base} (${n})${ext}`;
}

/** Decoded length of the joined path ("a/b/c"). */
export const decodedLength = (segments: readonly string[]) => segments.join("/").length;

/**
 * Shortens the file name so that `prefix/…/name` stays within MAX_DECODED_PATH even with the widest conflict
 * suffix. Returns null when the folders alone leave no room for a meaningful name.
 */
export function fitFileName(prefixLength: number, name: string, raw: string): string | null {
  const widest = ` (${MAX_SUFFIX})`.length;
  const room = MAX_DECODED_PATH - prefixLength - 1 - widest; // "/" before the name
  const [, ext] = splitExtension(name);
  if (room < ext.length + 9 + 1) return null; // at least one character + "~hash8" + extension
  return shorten(name, Math.min(room, MAX_SEGMENT - widest), raw, true);
}
