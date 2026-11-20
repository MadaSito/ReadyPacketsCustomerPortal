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

/**
 * Maximum nesting depth of a JSON value, computed iteratively (no recursion, so hostile nesting cannot
 * exhaust the stack). Stops early and returns `stopAbove + 1` once the depth exceeds `stopAbove`.
 */
export function jsonDepth(value: unknown, stopAbove = 1024): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v && typeof v === "object") {
      const nd = d + 1;
      if (nd > max) max = nd;
      if (max > stopAbove) return stopAbove + 1;
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, nd]);
    }
  }
  return max;
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
