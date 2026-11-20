import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { DomainError } from "../../core/errors.js";
import { validateImage } from "./imageValidation.js";
import { createPlatformModule, type PlatformModuleImpl } from "./module.js";
import { platformPresentationImages, platformSettings } from "./schema.js";
import { announcementSchema, plainText, PRESENTATION_ANNOUNCEMENT, PRESENTATION_SLIDES, slidesSchema } from "./settings.js";
import { createSettingsStore } from "./settingsStore.js";

/* ------------------------------------------------------------- synthetic images */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function jpeg(width: number, height: number, withExif = true): Buffer {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(withExif ? [segment(0xe1, Buffer.from("Exif\0\0GPS 51.5N secret-camera", "latin1")), segment(0xfe, Buffer.from("comment: author", "latin1"))] : []),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}
function webpLossless(width: number, height: number, extraChunk?: { type: string; data: Buffer }): Buffer {
  const vp8l = Buffer.alloc(5);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  const chunks = [Buffer.concat([Buffer.from("VP8L"), u32le(vp8l.length), vp8l, Buffer.alloc(1)])];
  if (extraChunk) chunks.push(Buffer.concat([Buffer.from(extraChunk.type, "latin1"), u32le(extraChunk.data.length), extraChunk.data]));
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

describe("image validation", () => {
  it("accepts PNG and strips text/EXIF/time chunks and trailing data", () => {
    const input = Buffer.concat([png(64, 32, [chunk("tEXt", Buffer.from("Author\0Jane")), chunk("eXIf", Buffer.from("MM\0*")), chunk("tIME", Buffer.alloc(7))]), Buffer.from("<script>alert(1)</script>")]);
    const result = validateImage(input);
    expect(result).toMatchObject({ ok: true, mime: "image/png", width: 64, height: 32 });
    if (!result.ok) return;
    const text = result.bytes.toString("latin1");
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("tIME");
    expect(text).not.toContain("<script>");
    expect(validateImage(result.bytes)).toMatchObject({ ok: true });
  });

  it("accepts JPEG and strips APP1 (EXIF/GPS) and comments, keeping JFIF", () => {
    const result = validateImage(jpeg(100, 50));
    expect(result).toMatchObject({ ok: true, mime: "image/jpeg", width: 100, height: 50 });
    if (!result.ok) return;
    const text = result.bytes.toString("latin1");
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("author");
    expect(text).toContain("JFIF");
  });

  it("accepts lossless WebP and refuses WebP with EXIF/XMP", () => {
    expect(validateImage(webpLossless(40, 40))).toMatchObject({ ok: true, mime: "image/webp", width: 40, height: 40 });
    expect(validateImage(webpLossless(40, 40, { type: "EXIF", data: Buffer.alloc(8) }))).toEqual({ ok: false, reason: "METADATA_NOT_ALLOWED" });
    expect(validateImage(webpLossless(40, 40, { type: "XMP ", data: Buffer.alloc(8) }))).toEqual({ ok: false, reason: "METADATA_NOT_ALLOWED" });
  });

  it("refuses SVG, HTML, GIF, truncated files, bad dimensions and oversize input", () => {
    expect(validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(validateImage(Buffer.from("<!doctype html><script>x</script>"))).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(validateImage(Buffer.from("GIF89a\x10\x00\x10\x00", "latin1"))).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(validateImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "EMPTY" });
    expect(validateImage(png(64, 64).subarray(0, 40))).toEqual({ ok: false, reason: "MALFORMED" });
    expect(validateImage(jpeg(64, 64).subarray(0, 30))).toEqual({ ok: false, reason: "MALFORMED" });
    expect(validateImage(png(8, 8))).toEqual({ ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" });
    expect(validateImage(jpeg(5000, 20))).toEqual({ ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" });
    expect(validateImage(Buffer.alloc(2 * 1024 * 1024 + 1))).toEqual({ ok: false, reason: "TOO_LARGE" });
    const corrupt = png(64, 64);
    corrupt.writeUInt32BE(0xffffffff, 33); // chunk length beyond the buffer
    expect(validateImage(corrupt)).toEqual({ ok: false, reason: "MALFORMED" });
  });
});

describe("presentation settings validation", () => {
  it("accepts bounded plain text and refuses markup, script URLs and control characters", () => {
    const text = plainText(20);
    expect(text.parse("  Hello\u0301 world ")).toBe("Hello\u0301 world".normalize("NFC"));
    for (const bad of ["<b>x</b>", "javascript:alert(1)", "data:text/html,x", "a\u0000b", "rtl\u202Eoverride", "line\nbreak", "x".repeat(21), "`tick`"]) {
      expect(text.safeParse(bad).success).toBe(false);
    }
    expect(plainText(50, { multiline: true }).parse("a\r\nb")).toBe("a\nb");
  });

  it("bounds slides and only allows allowlisted or uploaded images", () => {
    const slide = (id: string, image: unknown = null) => ({ id, title: "Title", body: "Body", image });
    expect(slidesSchema.safeParse([slide("a"), slide("b")]).success).toBe(true);
    expect(slidesSchema.safeParse([slide("a"), slide("a")]).success).toBe(false);
    expect(slidesSchema.safeParse(Array.from({ length: 7 }, (_, i) => slide(`s${i}`))).success).toBe(false);
    expect(slidesSchema.safeParse([slide("a", { source: "brand", id: "brand-icon-light-512", alt: "Logo" })]).success).toBe(true);
    expect(slidesSchema.safeParse([slide("a", { source: "brand", id: "../../etc/passwd", alt: "x" })]).success).toBe(false);
    expect(slidesSchema.safeParse([slide("a", { source: "url", id: "https://evil.example/x.png", alt: "x" })]).success).toBe(false);
    expect(slidesSchema.safeParse([{ ...slide("a"), html: "<b>" }]).success).toBe(false);
    expect(announcementSchema.safeParse({ enabled: true, text: "Maintenance tonight", tone: "warning" }).success).toBe(true);
    expect(PRESENTATION_ANNOUNCEMENT.schema.safeParse({ enabled: true, text: "", tone: "info" }).success).toBe(false);
  });
});

const allow = async () => undefined;

describe("presentation service", () => {
  let t: TestDb;
  let h: TestHarness;
  let platform: PlatformModuleImpl;

  beforeAll(async () => {
    t = await createTestDb({ schema: { platformSettings, platformPresentationImages } });
  });
  afterAll(() => t.cleanup());
  beforeEach(async () => {
    await t.db.delete(platformSettings);
    await t.db.delete(platformPresentationImages);
    h = createTestDeps({ db: t.db });
    const store = createSettingsStore({ db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto, audit: h.audit });
    h.deps.settings = store;
    platform = createPlatformModule(h.deps);
  });

  async function reasonOf(promise: Promise<unknown>): Promise<string> {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).reasonCode;
  }

  it("public read returns only safe fields and the default slide", async () => {
    const view = await platform.presentation();
    expect(Object.keys(view).sort()).toEqual(["announcement", "slides", "slideshow", "supportText"]);
    expect(view.slides[0]).toMatchObject({ id: "welcome", image: null });
    expect(view.announcement).toBeNull();
    expect(view.slideshow).toEqual({ autoAdvance: false, intervalSeconds: 8 });
  });

  it("uploads a validated, metadata-stripped image with audit in the transaction", async () => {
    const summary = await platform.presentationService.uploadImage(jpeg(100, 50), allow);
    expect(summary).toMatchObject({ source: "upload", width: 100, height: 50 });
    expect(summary.path).toBe(`/api/platform/presentation/images/${summary.id}`);
    const stored = [...h.storage.objects.values()][0]!;
    expect(stored.toString("latin1")).not.toContain("GPS");
    expect(h.audit.named("platform.presentation.image.uploaded")).toHaveLength(1);
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    const opened = await platform.presentationService.openImage(summary.id);
    expect(opened.mimeType).toBe("image/jpeg");
  });

  it("refuses invalid uploads and audits the refusal", async () => {
    expect(await reasonOf(platform.presentationService.uploadImage(Buffer.from("<svg/>"), allow))).toBe("IMAGE_UNSUPPORTED_TYPE");
    expect(h.audit.named("platform.presentation.image.refused")).toHaveLength(1);
    expect(h.storage.objects.size).toBe(0);
  });

  it("leaves no stored object or row when the audit write fails", async () => {
    h.audit.failRecords = true;
    await expect(platform.presentationService.uploadImage(png(32, 32), allow)).rejects.toThrow();
    expect(h.storage.objects.size).toBe(0);
    expect(await t.db.select().from(platformPresentationImages)).toHaveLength(0);
  });

  it("references uploads from slides, refuses unknown images, and refuses deleting images in use", async () => {
    const image = await platform.presentationService.uploadImage(png(32, 32), allow);
    const slides = [{ id: "a", title: "Hello", body: "", image: { source: "upload", id: image.id, alt: "Our team" } }];
    expect(await reasonOf(platform.updateSetting(PRESENTATION_SLIDES.key, [{ ...slides[0], image: { source: "upload", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", alt: "x" } }], 0, allow))).toBe("UNKNOWN_IMAGE");
    await platform.updateSetting(PRESENTATION_SLIDES.key, slides, 0, allow);
    const view = await platform.presentation();
    expect(view.slides[0]?.image).toEqual({ id: image.id, alt: "Our team", url: `/api/platform/presentation/images/${image.id}` });
    expect(await reasonOf(platform.presentationService.deleteImage(image.id, allow))).toBe("IMAGE_IN_USE");
    await platform.updateSetting(PRESENTATION_SLIDES.key, [], 1, allow);
    await platform.presentationService.deleteImage(image.id, allow);
    expect(await reasonOf(platform.presentationService.openImage(image.id))).toBe("NOT_FOUND");
    expect(await reasonOf(platform.presentationService.openImage("../../etc/passwd"))).toBe("NOT_FOUND");
  });

  it("drops an image that disappeared after publication instead of substituting anything", async () => {
    const image = await platform.presentationService.uploadImage(png(32, 32), allow);
    await platform.updateSetting(PRESENTATION_SLIDES.key, [{ id: "a", title: "Hello", body: "", image: { source: "upload", id: image.id, alt: "x" } }], 0, allow);
    await t.db.update(platformPresentationImages).set({ deletedAt: h.clock.now() });
    expect((await platform.presentation()).slides[0]?.image).toBeNull();
  });
});
