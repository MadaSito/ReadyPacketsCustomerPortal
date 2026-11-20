import { describe, expect, it } from "vitest";
import { acceptsDeclaredType, classifyFile, sanitizeDisplayName } from "./classification.js";
import { exampleMp4, exampleOgg, examplePdf, exampleWav, exampleWebm } from "./fixtures.test-support.js";

const classify = (value: Buffer) => classifyFile(async (offset, length) => value.subarray(offset, offset + length), value.length);

describe("canonical file admission", () => {
  it.each([
    [exampleWebm("audio", true), "webm", "audio/webm"],
    [exampleWebm("video"), "webm", "video/webm"],
    [exampleMp4("audio"), "m4a", "audio/mp4"],
    [exampleMp4("audio", "isom"), "m4a", "audio/mp4"],
    [exampleMp4("video"), "mp4", "video/mp4"],
    [exampleMp4("both"), "mp4", "video/mp4"],
    [exampleOgg("audio"), "ogg", "audio/ogg"],
    [exampleOgg("video"), "ogg", "video/ogg"],
    [exampleWav(), "wav", "audio/wav"],
    [examplePdf(), "pdf", "application/pdf"],
  ])("selects the canonical extension and MIME from synthesized track signatures", async (bytes, extension, mime) => {
    await expect(classify(bytes)).resolves.toEqual({ extension, mime });
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("ordinary text cannot bypass the signature checks"),
    Buffer.from("<html><p>Not an approved format</p></html>"),
    Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
    Buffer.from("MZsynthetic non-document bytes"),
    Buffer.from("\x1a\x45\xdf\xa3WebM signature without structure", "latin1"),
    exampleMp4("video", "M4A "),
    exampleOgg("audio", false),
    examplePdf("/OpenAction 2 0 R"),
    examplePdf("/J#61vaScript 2 0 R"),
    Buffer.concat([examplePdf(), Buffer.from("unframed additional bytes")]),
    Buffer.concat([exampleWebm("audio", true), Buffer.from("unframed additional bytes")]),
    Buffer.concat([exampleMp4("video"), Buffer.from("unframed additional bytes")]),
    Buffer.concat([exampleOgg("video"), Buffer.from("unframed additional bytes")]),
  ])("refuses unsafe formats, inconsistent structure and trailing unframed content", async (bytes) => {
    await expect(classify(bytes)).resolves.toBeNull();
  });

  it("accepts only known legacy declaration aliases after actual classification", () => {
    expect(acceptsDeclaredType({ extension: "webm", mime: "audio/webm" }, "video/webm")).toBe(true);
    expect(acceptsDeclaredType({ extension: "m4a", mime: "audio/mp4" }, "video/mp4")).toBe(false);
    expect(acceptsDeclaredType({ extension: "ogg", mime: "audio/ogg" }, "application/ogg")).toBe(true);
    expect(acceptsDeclaredType({ extension: "pdf", mime: "application/pdf" }, "text/html")).toBe(false);
  });

  it("normalizes display filenames and strips delimiter and control characters", () => {
    expect(sanitizeDisplayName(" ..Résumé\r\n//\\\"\u202e.pdf.. ")).toBe("Résumé_______.pdf");
    expect(() => sanitizeDisplayName("name with no extension")).toThrow();
  });
});
