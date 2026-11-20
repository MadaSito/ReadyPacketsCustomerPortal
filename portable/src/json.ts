/** Canonical JSON: recursively sorted object keys, no whitespace. Used for manifest bytes and digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Parse JSON rejecting `__proto__`/`constructor`/`prototype` keys (prototype-pollution defence). */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, v: unknown) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new SyntaxError("forbidden key");
    }
    return v;
  });
}

export function jsonDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, jsonDepth(v, depth + 1)), depth + 1);
  if (value && typeof value === "object")
    return Object.values(value).reduce<number>((m, v) => Math.max(m, jsonDepth(v, depth + 1)), depth + 1);
  return depth;
}

/** True when the string contains C0 control characters or DEL. */
export function hasControlChars(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Replace path separators and control characters with `_`. */
export function sanitizeFileName(v: string): string {
  let out = "";
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    out += ch === "/" || ch === "\\" || c < 0x20 || c === 0x7f ? "_" : ch;
  }
  return out;
}
