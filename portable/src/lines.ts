import type { Hash } from "node:crypto";
import { PortableError } from "./errors.js";

/**
 * Split a byte stream into UTF-8 lines (LF terminated), hashing raw bytes as they pass. A final line
 * without LF is yielded with `unterminated: true`. Lines longer than `maxLine` throw SIZE_LIMIT.
 */
export async function* splitLines(
  source: AsyncIterable<Buffer>,
  maxLine: number,
  hash?: Hash,
  onBytes?: (n: number) => void,
): AsyncGenerator<{ text: string; unterminated: boolean }> {
  let carry: Buffer = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (b: Buffer): string => {
    try {
      return decoder.decode(b);
    } catch {
      throw new PortableError("RECORD_INVALID", "A record line is not valid UTF-8.");
    }
  };
  for await (const chunk of source) {
    hash?.update(chunk);
    onBytes?.(chunk.length);
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      if (idx > maxLine) throw new PortableError("SIZE_LIMIT", "A record line exceeds the size limit.");
      yield { text: decode(buf.subarray(0, idx)), unterminated: false };
      buf = buf.subarray(idx + 1);
    }
    if (buf.length > maxLine) throw new PortableError("SIZE_LIMIT", "A record line exceeds the size limit.");
    carry = Buffer.from(buf);
  }
  if (carry.length) yield { text: decode(carry), unterminated: true };
}
