import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { classifyFile } from "./classification.js";
import type { AudioRules } from "./settings.js";

const limiter = "/usr/bin/prlimit";
const demuxers: Readonly<Record<string, string>> = {
  wav: "wav", webm: "matroska", m4a: "mov", mp4: "mov", ogg: "ogg", mp3: "mp3", aac: "aac", caf: "caf",
};
const childEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: "/nonexistent" };
export const audioJob = "files.audio_conversion";
// 120 min × 256 kbit/s is ~220 MiB before container overhead; ingress and output limits are separate.
export const maxAudioOutputBytes = 240 * 1024 * 1024;

type AudioFailure = "AUDIO_CONVERSION_UNAVAILABLE" | "AUDIO_CONVERSION_FAILED" | "AUDIO_DURATION_EXCEEDED" |
  "AUDIO_SOURCE_INTEGRITY" | "AUDIO_OUTPUT_INVALID";
export class AudioConversionError extends Error {
  constructor(readonly reasonCode: AudioFailure) { super(reasonCode); }
}

function run(binary: string, args: string[], limits: { cwd?: string; timeout: number; signal?: AbortSignal }) {
  return new Promise<string>((resolve, reject) => {
    execFile(binary, args, { ...limits, env: childEnv, maxBuffer: 128 * 1024, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function probeAudioBinary(binary: string): Promise<string | null> {
  if (!isAbsolute(binary)) return null;
  try {
    await access(limiter, constants.X_OK);
    const output = await run(limiter, ["--as=1073741824", "--cpu=4", "--", binary, "-version"], { timeout: 8000 });
    return /^ffmpeg version ([A-Za-z0-9.+:~_-]{1,80})(?:\s|$)/u.exec(output)?.[1] ?? null;
  } catch { return null; }
}

async function stageVerifiedAudio(directory: string, input: Readable, size: number, expectedHash: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  const verifyInput = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > size) return done(new AudioConversionError("AUDIO_SOURCE_INTEGRITY"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(input, verifyInput, createWriteStream(join(directory, "source"), { flags: "wx", mode: 0o600 }), { signal });
  if (bytes !== size || hash.digest("hex") !== expectedHash) throw new AudioConversionError("AUDIO_SOURCE_INTEGRITY");
}

const movRestrictions = (demuxer: string) => demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : [];
const lastTimestamp = (report: string) => Number([...report.matchAll(/^out_time_us=(\d{1,12})$/gmu)].at(-1)?.[1] ?? 0) / 1000;

async function readPcmWavDuration(directory: string, size: number): Promise<number | undefined> {
  const file = await open(join(directory, "source"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const read = async (position: number, length: number) => {
      const result = Buffer.alloc(length);
      const { bytesRead } = await file.read(result, 0, length, position);
      if (bytesRead !== length) throw new AudioConversionError("AUDIO_SOURCE_INTEGRITY");
      return result;
    };
    if (size < 44) return undefined;
    const riff = await read(0, 12);
    if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE" || riff.readUInt32LE(4) !== size - 8) return undefined;
    let sampleRate = 0;
    let blockAlign = 0;
    let frames = 0;
    let offset = 12;
    for (let chunks = 0; chunks < 1024 && offset + 8 <= size; chunks++) {
      const head = await read(offset, 8);
      const bytes = head.readUInt32LE(4);
      const next = offset + 8 + bytes + (bytes % 2);
      if (next > size) return undefined;
      const type = head.toString("ascii", 0, 4);
      if (type === "fmt ") {
        if (sampleRate || bytes !== 16) return undefined;
        const fmt = await read(offset + 8, 16);
        if (fmt.readUInt16LE(0) !== 1) return undefined;
        const channels = fmt.readUInt16LE(2);
        const bits = fmt.readUInt16LE(14);
        blockAlign = fmt.readUInt16LE(12);
        sampleRate = fmt.readUInt32LE(4);
        if (!channels || channels > 32 || ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * bits / 8 ||
            !sampleRate || sampleRate > 384_000 || fmt.readUInt32LE(8) !== blockAlign * sampleRate) return undefined;
      } else if (type === "data") {
        if (!blockAlign || frames || !bytes || bytes % blockAlign) return undefined;
        frames = bytes / blockAlign;
      }
      offset = next;
    }
    return offset === size && frames ? Math.ceil(frames * 1000 / sampleRate) : undefined;
  } finally { await file.close(); }
}

/** Check decoded sample duration for task admission; never trust user timestamps or container estimates. */
export async function measureTaskAudio(options: {
  binary: string; directory: string; input: Readable; size: number; sha256: string; extension: string; maxMinutes: number;
}): Promise<number> {
  const { binary, directory, input, size, sha256, maxMinutes } = options;
  const demuxer = demuxers[options.extension];
  if (!demuxer) throw new AudioConversionError("AUDIO_SOURCE_INTEGRITY");
  const signal = AbortSignal.timeout(20_000);
  await stageVerifiedAudio(directory, input, size, sha256, signal);
  const cap = maxMinutes * 60;
  if (options.extension === "wav") {
    const pcmDuration = await readPcmWavDuration(directory, size);
    if (pcmDuration !== undefined) {
      if (pcmDuration > cap * 1000) throw new AudioConversionError("AUDIO_DURATION_EXCEEDED");
      return pcmDuration;
    }
  }
  if (!isAbsolute(binary)) throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE");
  try { await Promise.all([binary, limiter].map((path) => access(path, constants.X_OK))); }
  catch { throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE"); }
  let report: string;
  try {
    report = await run(limiter, [
      "--as=1073741824", "--cpu=12:13", "--core=0", "--", binary,
      "-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-nostats", "-progress", "pipe:1",
      "-protocol_whitelist", "file", "-max_alloc", "67108864", "-threads", "1", "-f", demuxer, ...movRestrictions(demuxer),
      "-i", "source", "-map", "0:a:0", "-map_metadata", "-1", "-filter_threads", "1", "-af", "asetpts=N/SR/TB",
      "-c:a", "pcm_s16le", "-t", String(cap + 2), "-f", "null", "-",
    ], { cwd: directory, timeout: 15_000, signal });
  } catch { throw new AudioConversionError("AUDIO_CONVERSION_FAILED"); }
  const durationMs = Math.ceil(lastTimestamp(report));
  if (!durationMs || !/^progress=end$/mu.test(report)) throw new AudioConversionError("AUDIO_OUTPUT_INVALID");
  if (durationMs > cap * 1000 + 25) throw new AudioConversionError("AUDIO_DURATION_EXCEEDED");
  return durationMs;
}

export async function convertAudio<T>(options: {
  binary: string; directory: string; input: Readable; size: number; sha256: string; extension: string;
  rules: AudioRules; signal: AbortSignal;
  accept: (stream: Readable, durationMs: number) => Promise<T>;
}): Promise<T> {
  const { binary, directory, input, signal, rules } = options;
  const demuxer = demuxers[options.extension];
  if (!demuxer) throw new AudioConversionError("AUDIO_SOURCE_INTEGRITY");
  if (!isAbsolute(binary)) throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE");
  try { await Promise.all([binary, limiter].map((path) => access(path, constants.X_OK))); }
  catch { throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE"); }
  await stageVerifiedAudio(directory, input, options.size, options.sha256, signal);
  const seconds = rules.maxMinutes * 60;
  const output = "derived.webm";
  let report: string;
  try {
    report = await run(limiter, [
      "--as=1073741824", "--cpu=300:301", `--fsize=${maxAudioOutputBytes}`, "--core=0", "--",
      binary, "-hide_banner", "-nostdin", "-n", "-loglevel", "error", "-xerror", "-nostats", "-progress", "pipe:1",
      "-stats_period", "2", "-protocol_whitelist", "file", "-max_alloc", "67108864", "-threads", "1",
      "-f", demuxer, ...movRestrictions(demuxer),
      "-i", "source", "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-filter_threads", "1", "-threads", "1", "-t", String(seconds + 1), "-c:a", "libopus",
      "-b:a", `${rules.bitrateKbps}k`, "-vbr", "constrained",
      "-af", "aformat=sample_rates=8000|12000|16000|24000|48000:channel_layouts=mono|stereo", "-f", "webm", output,
    ], { cwd: directory, timeout: 330_000, signal });
  } catch {
    signal.throwIfAborted();
    throw new AudioConversionError("AUDIO_CONVERSION_FAILED");
  }
  const durationMs = Math.ceil(lastTimestamp(report));
  if (!durationMs || !/^progress=end$/mu.test(report)) throw new AudioConversionError("AUDIO_OUTPUT_INVALID");
  if (durationMs > seconds * 1000 + 25) throw new AudioConversionError("AUDIO_DURATION_EXCEEDED");
  const result = await open(join(directory, output), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await result.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() ||
        stat.size <= 0 || stat.size > maxAudioOutputBytes) {
      throw new AudioConversionError("AUDIO_OUTPUT_INVALID");
    }
    const kind = await classifyFile(async (offset, length) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await result.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    }, stat.size);
    if (kind?.extension !== "webm" || kind.mime !== "audio/webm") throw new AudioConversionError("AUDIO_OUTPUT_INVALID");
    const stream = result.createReadStream({ start: 0, autoClose: false });
    try { return await options.accept(stream, Math.min(durationMs, seconds * 1000)); }
    finally { stream.destroy(); }
  } finally { await result.close(); }
}
