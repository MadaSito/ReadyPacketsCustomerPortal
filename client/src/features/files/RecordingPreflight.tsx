import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { parseAgreementRequiredDetails, type AgreementSignatureMode } from "@/lib/agreementGate";
import { Button, Callout, Dialog, Field, Select } from "@/ui";
import { formatBytes } from "./format";
import { activeRecordingType, microphoneConstraints, microphoneHelp, pickRecorderFormat } from "./recordingDevice";

type TestRun = { stream?: MediaStream; recorder?: MediaRecorder; context?: AudioContext; meter?: number; stop?: number };
type State = "ready" | "permission" | "recording" | "done" | "failed";

export function RecordingPreflight({ orderId, slotKey, deviceId, onDevice, onClose, onContinue, onAgreementRequired }: {
  orderId: string; slotKey?: string; deviceId: string; onDevice: (id: string) => void; onClose: () => void; onContinue: (fallback: boolean) => void;
  onAgreementRequired: (agreement: { policyPublicId: string; signatureMode: AgreementSignatureMode }) => void;
}) {
  const trpc = useTRPC();
  const check = useQuery(trpc.files.recording.preflight.queryOptions({ orderPublicId: orderId, slotKey }, { retry: false, refetchOnMount: "always" }));
  const run = useRef<TestRun | null>(null);
  const preview = useRef<string | null>(null);
  const [state, setState] = useState<State>("ready");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mime = pickRecorderFormat(check.data?.acceptedTypes ?? []);
  const secure = window.isSecureContext !== false;
  const micAvailable = secure && mime !== null && typeof navigator.mediaDevices?.getUserMedia === "function";
  const busy = state === "permission" || state === "recording";

  function release(test: TestRun) {
    if (test.stop !== undefined) window.clearTimeout(test.stop);
    if (test.meter !== undefined) window.clearInterval(test.meter);
    if (test.recorder && test.recorder.state !== "inactive") test.recorder.stop();
    test.stream?.getTracks().forEach((track) => track.stop());
    void test.context?.close().catch(() => {});
  }

  useEffect(() => () => {
    const test = run.current;
    run.current = null;
    if (test) release(test);
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
  }, []);
  useEffect(() => {
    if (check.isFetching || !check.error) return;
    const agreement = parseAgreementRequiredDetails(check.error);
    if (agreement) onAgreementRequired(agreement);
  }, [check.error, check.isFetching, onAgreementRequired]);
  function cancel() {
    const test = run.current;
    run.current = null;
    if (test) release(test);
    setState("ready");
  }

  async function testMicrophone() {
    if (run.current || mime === null) return;
    const test: TestRun = {};
    run.current = test;
    setNotice(null);
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    setUrl(null);
    setLevel(0);
    setState("permission");
    function fail(message: string) {
      if (run.current !== test) return;
      run.current = null;
      release(test);
      setNotice(message);
      setState("failed");
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (run.current !== test) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      test.stream = stream;
      void navigator.mediaDevices.enumerateDevices?.()
        .then((devices) => { if (run.current === test) setMicrophones(devices.filter((device) => device.kind === "audioinput" && !!device.deviceId)); })
        .catch(() => {});
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      test.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.addEventListener("dataavailable", (event) => {
        if (run.current !== test || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > 4 * 1024 * 1024) fail("The microphone test exceeded its local playback limit. Try another microphone or the device recorder.");
        else chunks.push(event.data);
      });
      recorder.addEventListener("error", () => fail("The microphone test could not be recorded. Try another microphone or the device recorder."));
      recorder.addEventListener("stop", () => {
        if (run.current !== test) return;
        if (!chunks.length) { fail("No audio was captured. Check that the microphone is connected and unmuted."); return; }
        run.current = null;
        release(test);
        const playback = URL.createObjectURL(new Blob(chunks, { type: activeRecordingType(recorder, chunks, mime) }));
        preview.current = playback;
        setUrl(playback);
        setState("done");
      });
      try {
        const context = new AudioContext();
        test.context = context;
        void context.resume().catch(() => {});
        const meter = context.createAnalyser();
        meter.fftSize = 256;
        const data = new Float32Array(meter.fftSize);
        context.createMediaStreamSource(stream).connect(meter);
        test.meter = window.setInterval(() => {
          meter.getFloatTimeDomainData(data);
          setLevel(Math.min(100, Math.round(400 * Math.sqrt(data.reduce((sum, value) => sum + value ** 2, 0) / data.length))));
        }, 200);
      } catch { /* Recording still works when the meter is unavailable. */ }
      recorder.start(1000);
      test.stop = window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 5000);
      setState("recording");
    } catch {
      fail(`The microphone could not be started. ${microphoneHelp(navigator.userAgent)}`);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="Check your recording setup"
    description="Choose a microphone and record a five-second test. The test stays on this device and is never uploaded."
    footer={<>
      <Button variant="secondary" onClick={onClose}>Close</Button>
      {check.data?.enabled && !check.isError ? <Button variant="secondary" disabled={check.isFetching} onClick={() => onContinue(true)}>Use device recorder</Button> : null}
      {check.data?.enabled && micAvailable && !check.isError ? <Button disabled={busy || check.isFetching} onClick={() => onContinue(false)}>Continue to recording</Button> : null}
    </>}>
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-1 text-sm text-body" aria-live="polite">
        <p>{secure ? "Pass: secure browser context." : "Fail: microphone recording needs a secure connection (HTTPS)."}</p>
        <p className="break-words">{check.isPending ? "Checking supported formats…" : micAvailable ?
          mime ? `Pass: browser recorder available. Format: ${mime}.` : "Warning: the browser chooses the default recording format. The server checks whether it is accepted." :
          "Warning: browser recorder unavailable."}</p>
        <p>{state === "done" ? "Pass: microphone permission granted and test recorded." : state === "failed" ?
          "Fail: microphone test did not complete." : state === "recording" ? "Pass: microphone permission granted." : "Warning: microphone not yet tested."}</p>
      </div>
      {check.isPending ? <p role="status">Checking order recording settings…</p> : null}
      {check.isError ? <Callout tone="warning" title="Could not check recording settings">Refresh the check before recording. <Button variant="secondary" onClick={() => { void check.refetch(); }}>Try again</Button></Callout> : null}
      {check.data ? <div className="grid min-w-0 gap-2 text-sm text-body">
        {!check.data.enabled ? <Callout tone="warning" title="Recording unavailable">This order or task does not currently accept recordings.</Callout> : <>
          <p className="break-words">Pass: order accepts {check.data.acceptedTypes.join(", ").toUpperCase()}. Limit: {check.data.maxMinutes} minutes and {formatBytes(check.data.maxBytes)}.</p>
          <p>{check.data.conversionAvailable ? "Pass: the server can re-encode supported audio to WebM/Opus. It keeps the original." :
            "Warning: the server cannot re-encode audio right now. It keeps the original; tasks that require a verified duration may be unavailable."}</p>
        </>}
      </div> : null}
      {check.data?.enabled && !micAvailable ? <Callout tone="info" title="Browser recorder unavailable">Use the device recorder, or choose an existing audio file if the task allows it.</Callout> : null}
      {micAvailable ? <>
        <Field label="Microphone" hint="Device names become available after you grant permission.">
          <Select value={deviceId} onChange={(event) => onDevice(event.target.value)} disabled={busy}
            options={[{ value: "", label: "Default microphone" }, ...microphones.map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` }))]} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { if (busy) cancel(); else void testMicrophone(); }}>
            {busy ? "Cancel microphone test" : state === "done" ? "Test again" : "Test microphone"}
          </Button>
        </div>
        <p role="status" aria-atomic="true" className="text-sm text-body">{state === "permission" ? "Waiting for microphone permission." :
          state === "recording" ? "Recording a five-second test." : state === "done" ? "Test ready to play." : ""}</p>
        {state === "recording" ? <div className="grid gap-1">
          <meter aria-label="Test microphone level" className="w-full" value={level} min={0} max={100} />
          <p className="text-sm text-body">Microphone level: {level > 15 ? "We can hear you." : "Quiet or unavailable. Speak into the microphone."}</p>
        </div> : null}
        {url ? <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- This audio-only test is generated locally by the user's own microphone. */}
          <audio controls className="w-full min-w-0" src={url} aria-label="Play your microphone test"
            onError={() => setNotice("This browser could not play the test. Try the device recorder or a different browser.")} />
        </> : null}
      </> : null}
      {notice ? <Callout tone="warning" title="Microphone check" live="assertive">{notice}</Callout> : null}
      <p className="text-sm text-body">{microphoneHelp(navigator.userAgent)}</p>
    </div>
  </Dialog>;
}
