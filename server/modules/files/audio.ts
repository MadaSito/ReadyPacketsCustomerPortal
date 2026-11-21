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
const demuxers: Readonly<Record<string, string>> = { wav: "wav", webm: "matroska", m4a: "mov", ogg: "ogg" };
const childEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: "/nonexistent" };
export const audioJob = "files.audio_conversion";
export const maxAudioOutputBytes = 24 * 1024 * 1024;

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
    const output = await run(limiter, ["--as=1073741824", "--cpu=2", "--", binary, "-version"], { timeout: 2000 });
    return /^ffmpeg version ([A-Za-z0-9.+:~_-]{1,80})(?:\s|$)/u.exec(output)?.[1] ?? null;
  } catch { return null; }
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
  const hash = createHash("sha256");
  let bytes = 0;
  const verifyInput = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > options.size) return done(new AudioConversionError("AUDIO_SOURCE_INTEGRITY"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(input, verifyInput, createWriteStream(join(directory, "source"), { flags: "wx", mode: 0o600 }), { signal });
  if (bytes !== options.size || hash.digest("hex") !== options.sha256) throw new AudioConversionError("AUDIO_SOURCE_INTEGRITY");
  const seconds = rules.maxMinutes * 60;
  const output = "derived.webm";
  let report: string;
  try {
    report = await run(limiter, [
      "--as=1073741824", "--cpu=45:46", `--fsize=${maxAudioOutputBytes}`, "--core=0", "--",
      binary, "-hide_banner", "-nostdin", "-n", "-loglevel", "error", "-xerror", "-nostats", "-progress", "pipe:1",
      "-stats_period", "2", "-protocol_whitelist", "file", "-max_alloc", "67108864", "-threads", "1",
      "-f", demuxer, ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
      "-i", "source", "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-filter_threads", "1", "-threads", "1", "-t", String(seconds + 1), "-c:a", "libopus",
      "-b:a", `${rules.bitrateKbps}k`, "-ac", "1", "-ar", "48000", "-f", "webm", output,
    ], { cwd: directory, timeout: 60_000, signal });
  } catch {
    signal.throwIfAborted();
    throw new AudioConversionError("AUDIO_CONVERSION_FAILED");
  }
  const time = [...report.matchAll(/^out_time_us=(\d{1,12})$/gmu)].at(-1)?.[1];
  const durationMs = time ? Math.ceil(Number(time) / 1000) : 0;
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
