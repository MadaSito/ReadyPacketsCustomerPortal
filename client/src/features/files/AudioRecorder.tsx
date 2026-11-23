import { useEffect, useId, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { Button, Callout } from "@/ui";
import { formatBytes } from "./format";
import { activeRecordingType, extensionForRecording, microphoneConstraints, microphoneHelp, pickRecorderFormat } from "./recordingDevice";

export function formatDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

type State = "ready" | "permission" | "recording" | "paused" | "stopping" | "review";
type Capture = { stream: MediaStream; recorder: MediaRecorder; context?: AudioContext; timer?: number; deadline?: number; wakeLock?: WakeLockSentinel };
type Review = { file: File; url: string; duration: number };

export function AudioRecorder({ maxSeconds, maxBytes, extensions, onChoose, deviceId = "", onUnavailable }: {
  maxSeconds: number; maxBytes: number; extensions: readonly string[]; onChoose: (file: File) => void;
  deviceId?: string; onUnavailable?: () => void;
}) {
  const titleId = useId();
  const hintId = useId();
  const reviewButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const pauseButton = useRef<HTMLButtonElement>(null);
  const active = useRef<Capture | null>(null);
  const activeRequest = useRef<symbol | null>(null);
  const preview = useRef<string | null>(null);
  const [state, setState] = useState<State>("ready");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const selectedType = pickRecorderFormat(extensions);
  const supported = selectedType !== null && typeof navigator.mediaDevices?.getUserMedia === "function";

  function release(capture: Capture) {
    if (capture.timer !== undefined) window.clearInterval(capture.timer);
    if (capture.deadline !== undefined) window.clearTimeout(capture.deadline);
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.context?.close().catch(() => {});
    void capture.wakeLock?.release().catch(() => {});
  }

  useEffect(() => () => {
    activeRequest.current = null;
    if (active.current) {
      const capture = active.current;
      active.current = null;
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
      release(capture);
    }
    if (preview.current) URL.revokeObjectURL(preview.current);
  }, []);

  useEffect(() => {
    if (state === "review") reviewButton.current?.focus();
    if (state === "permission") cancelButton.current?.focus();
    if (state === "recording" && document.activeElement === document.body) pauseButton.current?.focus();
    if (state === "ready" && error && document.activeElement === document.body) startButton.current?.focus();
  }, [state, error]);

  async function start() {
    if (selectedType === null || activeRequest.current || active.current) return;
    setError(null);
    setElapsed(0);
    setLevel(0);
    setState("permission");
    const request = Symbol();
    activeRequest.current = request;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (activeRequest.current !== request) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { ...(selectedType ? { mimeType: selectedType } : {}), audioBitsPerSecond: 48_000 });
      const capture: Capture = { stream, recorder };
      active.current = capture;
      const chunks: Blob[] = [];
      let total = 0;
      let exceeded = false;
      let completedMs = 0;
      let started = performance.now();
      let finishMs: number | undefined;
      const duration = () => completedMs + (finishMs === undefined && recorder.state === "recording" ? performance.now() - started : 0);
      const stop = () => {
        if (recorder.state === "inactive") return;
        finishMs ??= Math.min(maxSeconds * 1000, duration());
        setState("stopping");
        recorder.stop();
      };
      const armDeadline = () => {
        if (capture.deadline !== undefined) window.clearTimeout(capture.deadline);
        // Leave room for encoder padding and scheduling around the verified server limit.
        capture.deadline = window.setTimeout(stop, Math.max(0, maxSeconds * 1000 - duration() - 150));
      };
      recorder.addEventListener("pause", () => {
        completedMs += performance.now() - started;
        if (capture.deadline !== undefined) window.clearTimeout(capture.deadline);
        if (active.current === capture) setState("paused");
      });
      recorder.addEventListener("resume", () => {
        started = performance.now();
        armDeadline();
        if (active.current === capture) setState("recording");
      });
      recorder.addEventListener("dataavailable", (event) => {
        if (active.current !== capture || exceeded || event.data.size === 0) return;
        total += event.data.size;
        if (total > maxBytes) {
          exceeded = true;
          chunks.length = 0;
          stop();
        } else {
          chunks.push(event.data);
          if (total >= maxBytes * 0.95) stop();
        }
      });
      recorder.addEventListener("error", () => {
        if (active.current !== capture) return;
        active.current = null;
        release(capture);
        setError("The recording failed. Try again or choose an audio file.");
        onUnavailable?.();
        setState("ready");
      });
      recorder.addEventListener("stop", () => {
        if (active.current !== capture) return;
        active.current = null;
        release(capture);
        if (exceeded || chunks.length === 0) {
          setError(exceeded ? "The recording exceeded the size limit. Record a shorter clip." : "No audio was captured. Try again or choose a file.");
          setState("ready");
          return;
        }
        const mime = activeRecordingType(recorder, chunks, selectedType);
        const ext = extensionForRecording(mime, extensions);
        if (!ext) {
          setError("This device recorded a format the order does not accept. Try the device recorder or an approved audio file.");
          onUnavailable?.();
          setState("ready");
          return;
        }
        const file = new File(chunks, `recording.${ext}`, { type: mime });
        const url = URL.createObjectURL(file);
        preview.current = url;
        setReview({ file, url, duration: (finishMs ?? Math.max(completedMs, performance.now() - started)) / 1000 });
        setState("review");
      });
      let analyser: AnalyserNode | undefined;
      let sample: Float32Array<ArrayBuffer> | undefined;
      try {
        const context = new AudioContext();
        capture.context = context;
        void context.resume().catch(() => {});
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        sample = new Float32Array(analyser.fftSize);
      } catch { /* The browser may record without a level meter. */ }
      recorder.start(1000);
      started = performance.now();
      armDeadline();
      void navigator.wakeLock?.request("screen").then((lock) => {
        if (active.current === capture) capture.wakeLock = lock;
        else void lock.release().catch(() => {});
      }).catch(() => {});
      setState("recording");
      capture.timer = window.setInterval(() => {
        if (recorder.state !== "recording") return;
        const time = duration();
        setElapsed(Math.min(Math.floor(time / 1000), maxSeconds));
        if (time >= maxSeconds * 1000) stop();
        if (analyser && sample) {
          analyser.getFloatTimeDomainData(sample);
          setLevel(Math.min(100, Math.round(100 * Math.sqrt(sample.reduce((sum, value) => sum + value ** 2, 0) / sample.length) * 4)));
        }
      }, 150);
      // Keep one stop action for all paths, including the user's manual stop.
      manualStop.current = stop;
    } catch (cause) {
      if (activeRequest.current !== request) return;
      if (active.current) { release(active.current); active.current = null; }
      else stream?.getTracks().forEach((track) => track.stop());
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? `Microphone access was denied. ${microphoneHelp(navigator.userAgent)}`
        : "The microphone could not be started. Try again or choose an audio file.");
      onUnavailable?.();
      setState("ready");
    } finally { if (activeRequest.current === request) activeRequest.current = null; }
  }

  const manualStop = useRef<(() => void) | null>(null);
  function discard() {
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    setReview(null);
    setState("ready");
    window.requestAnimationFrame(() => startButton.current?.focus());
  }

  return <div className="grid min-w-0 gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-3 sm:p-4" role="group" aria-labelledby={titleId}>
    <p className="font-semibold text-ink" id={titleId}>Record audio</p>
    <p className="text-sm text-body" id={hintId}>Your browser may ask for microphone access. You can listen before uploading. Until you choose Upload, the recording stays on this device.</p>
    {!supported ? <p className="text-sm text-muted">Recording in an approved audio format is not supported in this browser. You can still choose an audio file.</p> : <>
      <p className="text-sm text-muted">Recording limit: {formatDuration(maxSeconds)} and {formatBytes(maxBytes)}.</p>
      <p role="status" aria-atomic="true" className="text-sm text-body">
        {state === "permission" ? "Waiting for microphone permission." : state === "paused" ? `Paused at ${formatDuration(elapsed)}.` :
          state === "recording" ? `Recording. ${formatDuration(Math.floor(elapsed / 5) * 5)} elapsed.` :
            state === "stopping" ? "Preparing local playback." : state === "review" ? "Recording ready to review." : ""}
      </p>
      {state === "ready" ? <div><Button ref={startButton} aria-describedby={hintId} variant="secondary" leadingIcon={<Mic aria-hidden />}
        onClick={() => { void start(); }}>Start recording</Button></div> : null}
      {state === "permission" ? <div><Button ref={cancelButton} variant="secondary" onClick={() => {
        activeRequest.current = null; setState("ready"); window.requestAnimationFrame(() => startButton.current?.focus());
      }}>Cancel microphone request</Button></div> : null}
      {state === "recording" || state === "paused" ? <>
        <p className="font-mono text-sm tabular-nums text-ink">{formatDuration(elapsed)} elapsed · {formatDuration(maxSeconds - elapsed)} remaining</p>
        {state === "recording" ? <div className="grid gap-1">
          <meter className="w-full" aria-label="Microphone level" min={0} max={100} value={level} />
          <p className="text-sm text-muted">Microphone level: {level > 65 ? "High" : level > 15 ? "Moderate" : "Quiet or unavailable"}</p>
        </div> : null}
        <div className="flex flex-wrap gap-2">
          <Button ref={pauseButton} variant="secondary" onClick={() => state === "paused" ? active.current?.recorder.resume() : active.current?.recorder.pause()}>
            {state === "paused" ? "Resume recording" : "Pause recording"}
          </Button>
          <Button onClick={() => manualStop.current?.()}>Stop recording</Button>
        </div>
      </> : null}
      {review ? <div className="grid min-w-0 gap-3">
        <p className="text-sm text-body">Duration: {formatDuration(review.duration)} · {formatBytes(review.file.size)}</p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- This is a private, audio-only microphone preview; a transcript can be entered after selection. */}
        <audio className="w-full min-w-0" controls preload="metadata" src={review.url} aria-label="Play your local recording" />
        <div className="flex flex-wrap gap-2">
          <Button ref={reviewButton} onClick={() => { onChoose(review.file); discard(); }}>Use this recording</Button>
          <Button variant="secondary" onClick={discard}>Discard recording</Button>
        </div>
      </div> : null}
    </>}
    {error ? <Callout title="Recording notice" tone="warning" live="assertive">{error}</Callout> : null}
  </div>;
}
