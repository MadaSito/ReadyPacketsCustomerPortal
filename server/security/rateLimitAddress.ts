import { isIP } from "node:net";

/** Canonical IPv4, or an IPv6 /64. Never use the prefix in place of full audit source addresses. */
export function rateLimitAddress(address: string | undefined): string {
  if (!address) return "unknown";
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return "unknown";
  // Zone identifiers describe local interfaces, not different networks.
  const normalized = new URL(`http://[${address.split("%", 1)[0]}]`).hostname.slice(1, -1);
  const [left = "", right] = normalized.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  const words = groups.map((part) => Number.parseInt(part, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6]! >>> 8, words[6]! & 255, words[7]! >>> 8, words[7]! & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function normalizeRateLimitKey(key: string): string {
  for (const prefix of ["ip:", "edge:ip:"]) {
    if (key.startsWith(prefix) && isIP(key.slice(prefix.length))) {
      return prefix + rateLimitAddress(key.slice(prefix.length));
    }
  }
  return key;
}
