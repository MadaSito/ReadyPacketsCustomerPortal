export type AudioRange = { start: number; end: number } | "unsatisfiable" | null;

/** Accept a single inclusive byte range; never allocate from an untrusted range length. */
export function parseAudioRange(header: string | undefined, size: number): AudioRange {
  if (header === undefined) return null;
  const parts = header.length <= 48 ? /^bytes=(\d{0,16})-(\d{0,16})$/u.exec(header) : null;
  if (!parts || size <= 0 || (!parts[1] && !parts[2])) return "unsatisfiable";
  const first = parts[1] ? Number(parts[1]) : null;
  const last = parts[2] ? Number(parts[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return "unsatisfiable";
  if (first === null) return last ? { start: Math.max(0, size - last), end: size - 1 } : "unsatisfiable";
  if (first >= size || (last !== null && last < first)) return "unsatisfiable";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
