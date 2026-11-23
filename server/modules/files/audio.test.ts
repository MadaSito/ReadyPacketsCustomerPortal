import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { convertAudio, measureTaskAudio, probeAudioBinary } from "./audio.js";
import { createObjectStorage } from "./storage.js";
import { silentLogger } from "../../../tests/helpers/fakes.js";
import { exampleWav } from "./fixtures.test-support.js";
import { classifyFile } from "./classification.js";

const binary = "/usr/bin/ffmpeg";
const rules = { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true } as const;
async function testRun(opts?: { input?: Buffer; binary?: string; sha256?: string; extension?: string }) {
  const root = await mkdtemp(join(tmpdir(), "rp-audio-test-"));
  try {
    const storage = createObjectStorage({ config: { storageDir: root }, logger: silentLogger });
    const input = opts?.input ?? exampleWav(8000);
    const result = await storage.withConversionDirectory((directory) => convertAudio({
      binary: opts?.binary ?? binary, directory, input: Readable.from([input]), size: input.length,
      sha256: opts?.sha256 ?? createHash("sha256").update(input).digest("hex"), extension: opts?.extension ?? "wav", rules,
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
  it("checks decoded Opus sample duration and independently verifies PCM WAV without FFmpeg", async () => {
    const root = await mkdtemp(join(tmpdir(), "rp-audio-duration-"));
    try {
      const storage = createObjectStorage({ config: { storageDir: root }, logger: silentLogger });
      const measure = (input: Buffer, extension: string, executable: string) =>
        storage.withConversionDirectory((directory) => measureTaskAudio({
          binary: executable, directory, input: Readable.from([input]), size: input.length,
          sha256: createHash("sha256").update(input).digest("hex"), extension, maxMinutes: 1,
        }));
      const opus = await testRun();
      await expect(measure(opus.bytes, "webm", binary)).resolves.toBeGreaterThanOrEqual(990);
      await expect(measure(opus.bytes, "webm", "/nonexistent/ffmpeg")).rejects.toMatchObject({ reasonCode: "AUDIO_CONVERSION_UNAVAILABLE" });
      await expect(measure(exampleWav(60 * 8000), "wav", "/nonexistent/ffmpeg")).resolves.toBe(60_000);
      await expect(measure(exampleWav(60 * 8000 + 8), "wav", "/nonexistent/ffmpeg")).rejects.toMatchObject({ reasonCode: "AUDIO_DURATION_EXCEEDED" });
    } finally { await rm(root, { force: true, recursive: true }); }
  });
  it.each([
    ["mp4", ["-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4"], "audio/mp4"],
    ["aac", ["-c:a", "aac", "-f", "adts"], "audio/aac"],
    ["mp3", ["-c:a", "libmp3lame", "-f", "mp3"], "audio/mpeg"],
    ["caf", ["-c:a", "pcm_s16le", "-f", "caf"], "audio/x-caf"],
  ] as const)("recognizes and re-encodes real synthetic stereo %s audio to WebM/Opus", async (extension, args, mime) => {
    const root = await mkdtemp(join(tmpdir(), "rp-audio-fixture-"));
    try {
      const output = join(root, `source.${extension}`);
      execFileSync(binary, [
        "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.2", "-ac", "2", ...args, output,
      ], { timeout: 8000, maxBuffer: 128 * 1024 });
      const fixture = await readFile(output);
      await expect(classifyFile(async (offset, length) => fixture.subarray(offset, offset + length), fixture.length))
        .resolves.toMatchObject({ mime });
      const converted = await testRun({ input: fixture, extension });
      expect(converted.durationMs).toBeGreaterThanOrEqual(180);
      expect(converted.durationMs).toBeLessThan(350);
    } finally { await rm(root, { force: true, recursive: true }); }
  }, 15_000);
});
