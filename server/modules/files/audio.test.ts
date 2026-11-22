import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { convertAudio, probeAudioBinary } from "./audio.js";
import { createObjectStorage } from "./storage.js";
import { silentLogger } from "../../../tests/helpers/fakes.js";
import { exampleWav } from "./fixtures.test-support.js";

const binary = "/usr/bin/ffmpeg";
const rules = { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true } as const;
async function testRun(opts?: { input?: Buffer; binary?: string; sha256?: string }) {
  const root = await mkdtemp(join(tmpdir(), "rp-audio-test-"));
  try {
    const storage = createObjectStorage({ config: { storageDir: root }, logger: silentLogger });
    const input = opts?.input ?? exampleWav(8000);
    const result = await storage.withConversionDirectory((directory) => convertAudio({
      binary: opts?.binary ?? binary, directory, input: Readable.from([input]), size: input.length,
      sha256: opts?.sha256 ?? createHash("sha256").update(input).digest("hex"), extension: "wav", rules,
      signal: new AbortController().signal, accept: async (stream, durationMs) => ({ bytes: await buffer(stream), durationMs }),
    }));
    expect(await readdir(join(root, "quarantine"))).toEqual([]);
    return result;
  } finally { await rm(root, { force: true, recursive: true }); }
}
describe("bounded audio conversion with real local FFmpeg", () => {
  it("probes FFmpeg and converts a synthetic waveform through the private quarantine directory", async () => {
    expect(await probeAudioBinary(binary)).toMatch(/\d+\.\d+/u);
    const result = await testRun();
    expect(result.bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(result.durationMs).toBeGreaterThanOrEqual(990);
    expect(result.durationMs).toBeLessThan(1040);
  });
  it("fails closed for a missing executable, corrupt source digest, and over-duration media", async () => {
    const missing = "/nonexistent/ffmpeg";
    expect(await probeAudioBinary(missing)).toBeNull();
    await expect(testRun({ binary: missing })).rejects.toMatchObject({ reasonCode: "AUDIO_CONVERSION_UNAVAILABLE" });
    await expect(testRun({ sha256: "0".repeat(64) })).rejects.toMatchObject({ reasonCode: "AUDIO_SOURCE_INTEGRITY" });
    await expect(testRun({ input: exampleWav(62 * 8000) })).rejects.toMatchObject({ reasonCode: "AUDIO_DURATION_EXCEEDED" });
  });
});
