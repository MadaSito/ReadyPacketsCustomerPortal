import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { AudioRecorder } from "./AudioRecorder";
import { extensionForRecording, pickRecorderFormat } from "./recordingDevice";

class Recorder extends EventTarget {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; this.dispatchEvent(new Event("pause")); }
  resume() { this.state = "recording"; this.dispatchEvent(new Event("resume")); }
  stop() {
    this.state = "inactive";
    const frame = Object.assign(new Event("dataavailable"), { data: new Blob(["synthetic audio"]) });
    this.dispatchEvent(frame);
    this.dispatchEvent(new Event("stop"));
  }
}

const originalDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
function support() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const media = vi.fn<() => Promise<MediaStream>>().mockResolvedValue(stream);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: media } });
  return { stop, media, stream, create, revoke };
}

function renderRecorder(onChoose = vi.fn()) {
  return renderUi(<main><title>Voice evidence</title><h1>Voice evidence</h1>
    <AudioRecorder maxSeconds={5} maxBytes={1024} extensions={["webm"]} onChoose={onChoose} />
  </main>);
}

afterEach(() => {
  if (originalDevices) Object.defineProperty(navigator, "mediaDevices", originalDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("explains the fallback when MediaRecorder is unavailable", () => {
  vi.stubGlobal("MediaRecorder", undefined);
  renderRecorder();
  expect(screen.getByText(/not supported in this browser/iu)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start recording" })).not.toBeInTheDocument();
});

it("prefers WebM/Opus, then the supported MP4 variation, then falls back to the browser default", () => {
  const isTypeSupported = vi.fn((type: string) => type === "audio/mp4;codecs=mp4a.40.2" || type === "audio/ogg;codecs=opus");
  vi.stubGlobal("MediaRecorder", { isTypeSupported });
  expect(pickRecorderFormat(["webm", "mp4", "ogg"])).toBe("audio/mp4;codecs=mp4a.40.2");
  expect(isTypeSupported.mock.calls.map(([mime]) => mime)).toEqual(["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2"]);
  expect(pickRecorderFormat(["wav"])).toBe("");
  expect(pickRecorderFormat(["pdf"])).toBeNull();
  expect(extensionForRecording("audio/mp4;codecs=mp4a.40.2", ["mp4"])).toBe("mp4");
});

it("requires a user gesture, allows keyboard pause and review, and releases the local recording", async () => {
  const { stop, media, create, revoke } = support();
  const user = userEvent.setup();
  const onChoose = vi.fn();
  renderRecorder(onChoose);
  const recorder = within(screen.getByRole("group", { name: "Record audio" }));
  expect(media).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Start recording" }).focus();
  await user.keyboard("{Enter}");
  expect(media).toHaveBeenCalledWith({ audio: true, video: false });
  expect(await screen.findByRole("button", { name: "Pause recording" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(recorder.getByRole("status")).toHaveTextContent("Paused");
  await user.keyboard("{Enter}");
  expect(recorder.getByRole("status")).toHaveTextContent("Recording");
  await user.tab();
  await user.keyboard("{Enter}");
  expect(recorder.getByRole("status")).toHaveTextContent("Recording ready to review");
  expect(stop).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(expect.any(File));
  expect(onChoose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Use this recording" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ name: "recording.webm" }));
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
});

it("announces denied permission and releases a microphone granted after cancellation", async () => {
  const { stop, media, stream } = support();
  const user = userEvent.setup();
  media.mockRejectedValueOnce(new DOMException("Synthetic denial", "NotAllowedError"));
  renderRecorder();
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  expect(await screen.findByText(/Microphone access was denied/iu)).toBeInTheDocument();
  let grant!: (value: MediaStream) => void;
  media.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  await user.click(screen.getByRole("button", { name: "Cancel microphone request" }));
  await act(async () => grant(stream));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start recording" })).toBeInTheDocument();
});

pageA11y("Local audio review", async () => {
  support();
  const user = userEvent.setup();
  renderRecorder();
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  await user.click(await screen.findByRole("button", { name: "Stop recording" }));
  expect(screen.getByRole("button", { name: "Use this recording" })).toBeInTheDocument();
});
