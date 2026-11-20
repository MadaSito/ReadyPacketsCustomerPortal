import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";

function attachment(filename: string): string {
  const sanitized = Array.from(Buffer.from(filename).toString("utf8").normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}/\\]/gu, "_").trim()).slice(0, 150).join("");
  const safe = sanitized && !/^\.+$/.test(sanitized) ? sanitized : "download";
  const ascii = safe.replace(/[^a-zA-Z0-9_. -]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (value) =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface PrivateDownload {
  stream: Readable;
  filename: string;
  contentType: string;
  size?: number;
}

export async function sendPrivateDownload(res: Response, { stream, filename, contentType, size }: PrivateDownload): Promise<void> {
  const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType) && contentType.length <= 128
    ? contentType
    : "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", attachment(filename));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
  if (size !== undefined && Number.isSafeInteger(size) && size >= 0) res.setHeader("Content-Length", String(size));
  await pipeline(stream, res);
}
