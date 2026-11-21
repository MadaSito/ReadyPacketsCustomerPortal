/**
 * QuickXorHash: the content hash OneDrive for Business and SharePoint report for files
 * (`file.hashes.quickXorHash`, base64). They do not report SHA-256, so the Graph drive adapter verifies the
 * uploaded object's identity with this hash and returns no `sha256` (storage contract: only genuinely
 * provider-reported SHA-256 may be returned).
 *
 * Algorithm (Microsoft's published reference): a 160-bit circular register; byte k of the stream is XORed in
 * at bit offset (11·k) mod 160; finally the 64-bit little-endian length is XORed into the last 8 bytes.
 * Because gcd(11, 160) = 1 the offsets repeat every 160 bytes, so bytes are first folded into 160 lanes.
 */
const WIDTH_BITS = 160;
const SHIFT = 11;

export class QuickXorHash {
  private readonly lanes = new Uint8Array(WIDTH_BITS);
  private lane = 0;
  private length = 0n;

  update(chunk: Uint8Array): this {
    const lanes = this.lanes;
    let lane = this.lane;
    for (let i = 0; i < chunk.length; i++) {
      lanes[lane]! ^= chunk[i]!;
      lane = lane === WIDTH_BITS - 1 ? 0 : lane + 1;
    }
    this.lane = lane;
    this.length += BigInt(chunk.length);
    return this;
  }

  digest(): Buffer {
    const out = Buffer.alloc(WIDTH_BITS / 8);
    for (let k = 0; k < WIDTH_BITS; k++) {
      const value = this.lanes[k]!;
      if (value === 0) continue;
      const bit = (SHIFT * k) % WIDTH_BITS;
      const byteIndex = bit >> 3;
      const offset = bit & 7;
      const wide = value << offset; // up to 15 bits
      out[byteIndex]! ^= wide & 0xff;
      out[(byteIndex + 1) % out.length]! ^= wide >> 8;
    }
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt.asUintN(64, this.length));
    for (let i = 0; i < 8; i++) out[out.length - 8 + i]! ^= len[i]!;
    return out;
  }

  digestBase64(): string {
    return this.digest().toString("base64");
  }
}
