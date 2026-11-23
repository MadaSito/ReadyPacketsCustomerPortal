export const audioFileExtensions = ["webm", "m4a", "mp4", "ogg", "wav", "mp3", "aac", "caf"] as const;

const formats = [
  { mime: "audio/webm;codecs=opus", extensions: ["webm"] },
  { mime: "audio/webm", extensions: ["webm"] },
  { mime: "audio/mp4;codecs=mp4a.40.2", extensions: ["m4a", "mp4"] },
  { mime: "audio/mp4", extensions: ["m4a", "mp4"] },
  { mime: "audio/ogg;codecs=opus", extensions: ["ogg"] },
] as const;

export function pickRecorderFormat(allowed: readonly string[]): string | null {
  if (typeof MediaRecorder === "undefined" || !audioFileExtensions.some((ext) => allowed.includes(ext))) return null;
  for (const format of formats) {
    try {
      if (format.extensions.some((ext) => allowed.includes(ext)) && MediaRecorder.isTypeSupported?.(format.mime)) return format.mime;
    } catch { /* Continue to the browser's default encoder. */ }
  }
  return "";
}

export function activeRecordingType(recorder: MediaRecorder, chunks: readonly Blob[], requested: string) {
  return recorder.mimeType || chunks.find((chunk) => chunk.type)?.type || requested;
}

export function extensionForRecording(mime: string, allowed: readonly string[]) {
  const base = mime.toLowerCase().split(";")[0];
  const candidates = formats.find((format) => format.mime.split(";")[0] === base)?.extensions ??
    ({ "audio/wav": ["wav"], "audio/x-wav": ["wav"], "audio/mpeg": ["mp3"], "audio/aac": ["aac"], "audio/x-caf": ["caf"] }[base ?? ""] ?? []);
  return candidates.find((extension) => allowed.includes(extension));
}

export function microphoneHelp(userAgent: string) {
  if (/iPhone|iPad|CriOS|FxiOS/iu.test(userAgent)) return "On iPhone or iPad, check the website’s microphone permission in Safari’s page settings and the browser’s permission in Settings. For playback, turn off Silent Mode and turn up media volume.";
  if (/Firefox/iu.test(userAgent)) return "In Firefox, open the permissions icon beside the address, clear the microphone block, then reload or try again.";
  if (/Safari/iu.test(userAgent) && !/Chrome|Chromium|Edg/iu.test(userAgent)) return "In Safari, open Settings for This Website, set Microphone to Ask or Allow, then try again.";
  return "Open the site controls next to the address bar, allow microphone access, and check your operating system’s privacy settings.";
}

export function microphoneConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
}
