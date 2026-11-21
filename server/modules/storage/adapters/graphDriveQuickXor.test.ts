import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QuickXorHash } from "./graphDriveQuickXor.js";

/** Straight port of Microsoft's reference (3 × 64-bit cells, last cell 32 bits) using BigInt — independent check. */
function referenceQuickXor(data: Uint8Array): string {
  const cells = [0n, 0n, 0n];
  const mask = (1n << 64n) - 1n;
  // single update from an empty state: shiftSoFar = 0
  let vectorArrayIndex = 0;
  let vectorOffset = 0;
  const iterations = Math.min(data.length, 160);
  for (let i = 0; i < iterations; i++) {
    const isLast = vectorArrayIndex === cells.length - 1;
    const bits = isLast ? 32 : 64;
    if (vectorOffset <= bits - 8) {
      for (let j = i; j < data.length; j += 160) cells[vectorArrayIndex] = (cells[vectorArrayIndex]! ^ (BigInt(data[j]!) << BigInt(vectorOffset))) & mask;
    } else {
      const index2 = isLast ? 0 : vectorArrayIndex + 1;
      const low = bits - vectorOffset;
      let x = 0;
      for (let j = i; j < data.length; j += 160) x ^= data[j]!;
      cells[vectorArrayIndex] = (cells[vectorArrayIndex]! ^ (BigInt(x) << BigInt(vectorOffset))) & mask;
      cells[index2] = cells[index2]! ^ (BigInt(x) >> BigInt(low));
    }
    vectorOffset += 11;
    while (vectorOffset >= bits) {
      vectorArrayIndex = isLast ? 0 : vectorArrayIndex + 1;
      vectorOffset -= bits;
    }
  }
  const out = Buffer.alloc(20);
  out.writeBigUInt64LE(cells[0]!, 0);
  out.writeBigUInt64LE(cells[1]!, 8);
  out.writeUInt32LE(Number(cells[2]! & 0xffffffffn), 16);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(data.length));
  for (let i = 0; i < 8; i++) out[12 + i]! ^= len[i]!;
  return out.toString("base64");
}

describe("QuickXorHash", () => {
  it("matches published vectors", () => {
    expect(new QuickXorHash().digestBase64()).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(new QuickXorHash().update(Buffer.from("hello world")).digestBase64()).toBe("aCgDG9jwBhDc4Q1yawMZAAAAAAA=");
    expect(new QuickXorHash().update(Buffer.from("hello from xsync repro\n")).digestBase64()).toBe("CSQji5vp5jAfdiZvfwMI8DCHPLg=");
  });

  it("matches the reference port for many sizes and is independent of chunking", () => {
    for (const size of [1, 7, 159, 160, 161, 319, 320, 1000, 4096, 65_537]) {
      const data = randomBytes(size);
      const expected = referenceQuickXor(data);
      expect(new QuickXorHash().update(data).digestBase64()).toBe(expected);
      const chunked = new QuickXorHash();
      for (let at = 0; at < size; at += 37) chunked.update(data.subarray(at, at + 37));
      expect(chunked.digestBase64()).toBe(expected);
    }
  });
});
