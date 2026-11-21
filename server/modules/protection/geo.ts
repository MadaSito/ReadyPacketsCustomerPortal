import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Request } from "express";
import { Reader, type CountryResponse } from "mmdb-lib";
import type { Clock, Logger } from "../../core/types.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const REFRESH_MS = 60_000;
const STALE_MS = 5 * REFRESH_MS;

export function createCountryResolver(config: {
  protectionMmdbPath?: string;
  protectionCountryHeader?: string;
}, clock: Clock, logger: Logger) {
  let reader: Reader<CountryResponse> | undefined;
  let fingerprint = "";
  let checkedAt = Number.NEGATIVE_INFINITY;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | undefined;

  async function load(path: string) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("MMDB_FILE_INVALID");
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (reader && stamp === fingerprint) return;
      const buffer = Buffer.alloc(stat.size);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, filled);
        if (!bytesRead) throw new Error("MMDB_FILE_CHANGED");
        filled += bytesRead;
      }
      const final = await fd.stat();
      if (stat.size !== final.size || stat.mtimeMs !== final.mtimeMs) throw new Error("MMDB_FILE_CHANGED");
      const next = new Reader<CountryResponse>(buffer);
      if (!/country|city/i.test(next.metadata.databaseType)) throw new Error("MMDB_TYPE_UNSUPPORTED");
      reader = next;
      fingerprint = stamp;
    } finally {
      await fd.close();
    }
  }

  function ensure(): Promise<void> {
    const path = config.protectionMmdbPath;
    const now = clock.now().getTime();
    if (pending) return pending;
    if (!path || checkedAt + REFRESH_MS > now) return Promise.resolve();
    checkedAt = now;
    pending = load(path).then(() => { refreshedAt = clock.now().getTime(); }, () => {
      logger.warn("protection country database unavailable", { reasonCode: "PROTECTION_MMDB_UNAVAILABLE" });
    }).finally(() => { pending = undefined; });
    return pending;
  }

  function lookup(address: string | undefined, req?: Request): string | null {
    const header = config.protectionCountryHeader;
    const peer = req?.socket.remoteAddress;
    const isTrusted = req?.app.get("trust proxy fn") as ((ip: string, index: number) => boolean) | undefined;
    if (header && peer && isTrusted?.(peer, 0)) {
      const value = req?.get(header);
      if (value && /^[A-Z]{2}$/.test(value)) return value;
    }
    if (!address || !reader || refreshedAt + STALE_MS <= clock.now().getTime()) return null;
    try {
      const value = reader.get(address)?.country?.iso_code;
      return value && /^[A-Z]{2}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return { ensure, lookup };
}
