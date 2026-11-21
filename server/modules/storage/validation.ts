import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { STORAGE_PROVIDER_KINDS, STORAGE_PURPOSES } from "./contracts.js";

export const storagePublicId = z.string().length(26).regex(ULID_PATTERN);
const version = z.number().int().min(1).max(0xffff_ffff);
const key = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/).refine((name) => name !== "constructor" && name !== "prototype");
const name = z.string().trim().normalize().min(1).max(120).refine((text) => !/\p{C}/u.test(text));
const config = z.record(key, z.union([z.string().max(2048), z.number().int().safe(), z.boolean()]))
  .refine((fields) => Object.keys(fields).length <= 24);
const credentials = z.record(key, z.string().min(1).max(16_384))
  .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 12 &&
    Buffer.byteLength(JSON.stringify(fields)) <= 32_768);

export const storageList = z.strictObject({ cursor: storagePublicId.optional(), limit: z.number().int().min(1).max(100).optional() });
export const storageGet = z.strictObject({ publicId: storagePublicId });
export const storageTest = z.strictObject({ publicId: storagePublicId, expectedVersion: version });
export const storageCreate = z.strictObject({ kind: z.enum(STORAGE_PROVIDER_KINDS), name, config, credentials: credentials.optional() });
export const storageUpdate = z.strictObject({
  publicId: storagePublicId, expectedVersion: version, name: name.optional(), config: config.optional(),
  credentials: credentials.nullable().optional(), enabled: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.config !== undefined || value.credentials !== undefined || value.enabled !== undefined);
export const storageAssignment = z.strictObject({
  purpose: z.enum(STORAGE_PURPOSES),
  connectionPublicIds: z.array(storagePublicId).max(8),
}).refine(({ purpose, connectionPublicIds }) =>
  (purpose === "order_files" || connectionPublicIds.length <= 1) && new Set(connectionPublicIds).size === connectionPublicIds.length);

export const copySegment = z.string().min(1).max(180).refine((text) => text === text.normalize("NFC") &&
  text !== "." && text !== ".." && !/[\\/%]|\p{C}/u.test(text) && !/^[ .]|[ .]$/u.test(text));
export const copyMetadata = z.object({
  path: z.array(copySegment).max(12),
  name: copySegment,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().max(120).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
});
