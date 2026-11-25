import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord, UploadPolicy } from "@server/modules/files/index";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { FileUploadPanel } from "./FileUploadPanel";
import { FilesAdminContent } from "./FilesAdminPage";
import OrderFilesTab from "./OrderFilesTab";
import { PhaseUploadedFiles, PhaseUploadPanel } from "./PhaseFiles";
import { RecordingPreflight } from "./RecordingPreflight";
import { formatAudioTimeRemaining } from "./format";

const { fetchMock, view, phasePolicy } = vi.hoisted(() => ({ fetchMock: vi.fn(), view: vi.fn(), phasePolicy: vi.fn() }));
vi.mock("@/lib/agreementGate", () => ({
  AgreementDialog: ({ onAccepted }: { onAccepted: () => Promise<void> }) => <button type="button" onClick={() => { void onAccepted(); }}>Accept test agreement</button>,
  parseAgreementRequiredDetails: () => null,
}));
vi.mock("@/lib/sessionTransport", async (original) => ({
  ...await original<typeof transportModule>(),
  sessionFetch: fetchMock,
}));
vi.mock("./archives/ArchiveAction", () => ({
  OrderArchiveAction: () => <button type="button">Download all files (ZIP)</button>,
  PhaseArchiveAction: ({ phaseName }: { phaseName: string }) => <button type="button">Download {phaseName} files (ZIP)</button>,
}));
vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof trpcModule>(),
  useTRPCClient: () => ({ files: {
    issueDownloadTicket: { mutate: async () => ({ ticket: "synthetic-test-ticket" }) },
    issuePlaybackTicket: { mutate: async () => ({ ticket: "synthetic-playback-ticket" }) },
    readTranscript: { mutate: async () => ({ transcript: "Synthetic transcript" }) },
  } }),
  useTRPC: () => {
    const mutation = { mutationOptions: () => ({ mutationFn: async () => ({}) }) };
    return {
      orders: { requirements: { forOrder: { queryKey: (input: { orderId: string }) => ["requirements", input.orderId] } } },
      files: {
        list: {
          infiniteQueryOptions: () => ({
            queryKey: ["file-tabs", "fixture"], queryFn: view, initialPageParam: null,
            getNextPageParam: () => undefined,
          }),
          pathKey: () => ["file-tabs"],
        },
        phasePolicy: {
          queryOptions: () => ({ queryKey: ["phase-policy"], queryFn: phasePolicy }),
          pathKey: () => ["phase-policy"],
        },
        teamFiles: { pathKey: () => ["team-files"] },
        recording: { preflight: { queryOptions: () => ({ queryKey: ["preflight"], queryFn: async () => ({
          enabled: true, conversionAvailable: false, maxMinutes: 2, maxBytes: policy.maxFileBytes, acceptedTypes: ["wav"],
        }) }) } },
        remove: mutation, restore: mutation, setVisibility: mutation,
      },
    };
  },
}));

const orderId = `01JTEST${"0".repeat(19)}`;
const policy: UploadPolicy = { extensions: ["wav", "pdf", "jpg"], maxFiles: 4, maxFileBytes: 1024 * 1024, maxRequestBytes: 4 * 1024 * 1024 };
const sample: FileRecord = {
  publicId: `01JTEST${"0".repeat(18)}1`,
  orderPublicId: orderId,
  logicalPublicId: `01JTEST${"0".repeat(18)}1`,
  phasePublicId: null,
  statusKey: "intake",
  slotKey: null, derivedFromPublicId: null, conversionState: null, conversionReason: null, durationSeconds: null,
  version: 1,
  visibility: "customer_visible",
  category: "supporting",
  displayName: "Example document.pdf",
  size: 8,
  sha256: "0".repeat(64),
  contentType: "application/pdf",
  extension: "pdf",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
  supersededAt: null,
};

beforeEach(() => {
  fetchMock.mockReset();
  view.mockReset().mockResolvedValue({ items: [sample], nextCursor: null, canUpload: false, uploadPolicy: null });
  phasePolicy.mockReset().mockResolvedValue(null);
});

describe("phase uploader", () => {
  const phaseDefaults = { enabled: true, disabledReason: null, maxSeconds: 60, policy,
    remainingDocuments: 3, remainingAudio: 3, remainingAudioSeconds: 7200 };

  it("reports queued and in-flight files until both results are definitive, and clears the count on unmount", async () => {
    phasePolicy.mockResolvedValue(phaseDefaults);
    let finish = (_response: Response) => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = vi.fn();
    const user = userEvent.setup();
    const props = { orderId, stageKey: "intake_phase", intent: "document", onPendingChange: pending } as const;
    const { container, unmount } = renderUi(<PhaseUploadPanel {...props} />);
    await screen.findByRole("button", { name: "Choose files" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const evidence = new File(["synthetic"], "evidence.pdf", { type: "application/pdf" });
    await user.upload(fileInput, [evidence, new File(["synthetic"], "another.pdf", { type: "application/pdf" })]);
    expect(pending).toHaveBeenLastCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Upload 2 files" }));
    expect(pending).toHaveBeenLastCalledWith(2);
    finish(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }, { index: 1, outcome: "refused" }] })));
    expect(await screen.findByText("1 of 2 uploads confirmed.")).toBeInTheDocument();
    expect(pending).toHaveBeenLastCalledWith(0);
    await user.upload(fileInput, evidence);
    expect(pending).toHaveBeenLastCalledWith(1);
    unmount();
    expect(pending).toHaveBeenLastCalledWith(0);
  });

  it("shows the remaining audio allowance as hours and minutes", async () => {
    phasePolicy.mockResolvedValue({ ...phaseDefaults, remainingAudioSeconds: 5400 });
    renderUi(<PhaseUploadPanel orderId={orderId} stageKey="intake_phase" intent="prerecorded_audio" />);
    expect(await screen.findByText("3 files remaining · 1 hour 30 minutes of audio remaining")).toBeInTheDocument();
    expect([7200, 2700, 59, 0].map(formatAudioTimeRemaining)).toEqual(["2 hours", "45 minutes", "less than 1 minute", "0 minutes"]);
  });
});

describe("file upload", () => {
  it("keeps the phase and prerecorded intent distinct from microphone recording", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff={false}
      phase={{ key: "intake_phase", intent: "prerecorded_audio" }} policy={{ ...policy, extensions: ["wav"] }}
      audio={{ enabled: true, maxMinutes: 5 }} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "evidence.wav", { type: "audio/wav" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("1 of 1 uploads confirmed.")).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("stageKey=intake_phase&intent=prerecorded_audio");
    expect(url).not.toContain("source=recording");
  });

  it("binds the selected workflow status and slot and sends the optional transcript only on explicit upload", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff={false} policy={policy}
      slot={{ key: "voice_evidence", statusKey: "intake", label: "Voice evidence", kind: "audio", maxCount: 1, allowedTypes: ["wav"] }}
      audio={{ enabled: true, maxMinutes: 5 }} onChanged={vi.fn()} />);
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "evidence.wav", { type: "audio/wav" }));
    await user.type(screen.getByLabelText("Audio transcript (optional)"), "Synthetic statement");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("1 of 1 uploads confirmed.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("slotKey=voice_evidence&statusKey=intake");
    expect((init.body as FormData).get("transcript")).toBe("Synthetic statement");
  });
  it("shows actual upload progress state and distinct server-confirmed outcomes", async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    let complete: (value: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff={false} policy={policy} onChanged={changed} />);
    await expectNoAxeViolations(container);
    expect(screen.queryByLabelText("Visibility")).not.toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    await user.upload(input, [new File(["synthetic"], "audio.wav"), new File(["synthetic"], "document.pdf")]);
    await user.click(screen.getByRole("button", { name: "Upload 2 files" }));
    expect(await screen.findByRole("progressbar", { name: "Sending and validating selected files…" })).not.toHaveAttribute("value");
    complete(new Response(JSON.stringify({ results: [
      { index: 0, outcome: "completed" },
      { index: 1, outcome: "refused", message: "Contents did not match the approved format." },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("1 of 2 uploads confirmed.")).toBeInTheDocument();
    expect(screen.getByText("Contents did not match the approved format.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload 2 files" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear results" })).toHaveFocus();
    expect(changed).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/api/files/upload/${orderId}?`),
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  });

  it("keeps a lost connection unknown rather than claiming the file was refused", async () => {
    const user = userEvent.setup();
    const pending = vi.fn();
    fetchMock.mockRejectedValue(new Error("synthetic transport interruption"));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff policy={policy} onPendingChange={pending} onChanged={vi.fn()} />);
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "audio.wav"));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("Unknown outcome")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 uploads confirmed.")).toBeInTheDocument();
    expect(pending).toHaveBeenLastCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Clear results" }));
    expect(pending).toHaveBeenLastCalledWith(0);
  });

  it("uses the device capture control for a recording-only task when the browser has no recorder", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    renderUi(<FileUploadPanel orderId={orderId} staff={false} policy={policy}
      slot={{ key: "voice_evidence", statusKey: "intake", label: "Voice evidence", kind: "audio", maxCount: 1, allowedTypes: ["wav"], capture: "record", maxMinutes: 2 }}
      audio={{ enabled: true, maxMinutes: 30 }} onChanged={vi.fn()} />);
    expect(screen.queryByLabelText("Choose files")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record" }));
    const dialog = screen.getByRole("dialog", { name: "Check your recording setup" });
    expect(await within(dialog).findByText(/Limit: 2 minutes/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/Warning: browser recorder unavailable/u)).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Use device recorder" }));
    const capture = screen.getByLabelText("Record with your device");
    expect(capture).toHaveAttribute("accept", "audio/*");
    expect(capture).toHaveAttribute("capture");
    await user.upload(capture, new File(["synthetic"], "audio.wav", { type: "audio/wav" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("1 of 1 uploads confirmed.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("source=recording&slotKey=voice_evidence"), expect.anything());
  });

  it("keeps keyboard focus on the microphone test through cancel and local playback", async () => {
    class TestRecorder extends EventTarget {
      static isTypeSupported = () => false;
      state: RecordingState = "inactive";
      mimeType = "audio/wav";
      start = vi.fn((timeslice: number) => { expect(timeslice).toBe(1000); this.state = "recording"; });
      stop() {
        this.state = "inactive";
        this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["synthetic"], { type: this.mimeType }) }));
        this.dispatchEvent(new Event("stop"));
      }
    }
    const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const trackStop = vi.fn();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recording-test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("MediaRecorder", TestRecorder);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }),
      enumerateDevices: async () => [{ deviceId: "default", kind: "audioinput", label: "Sandbox microphone" }],
    } });
    const { unmount } = renderUi(<RecordingPreflight orderId={orderId} deviceId="" onDevice={vi.fn()} onClose={vi.fn()}
      onContinue={vi.fn()} onAgreementRequired={vi.fn()} />);
    try {
      const button = await screen.findByRole("button", { name: "Test microphone" });
      const user = userEvent.setup();
      button.focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: "Cancel microphone test" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: "Test microphone" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("button", { name: "Test again" }, { timeout: 10_000 })).toHaveFocus();
      expect(screen.getByLabelText("Play your microphone test")).toHaveAttribute("src", "blob:recording-test");
      expect(trackStop).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      unmount();
      expect(revoke).toHaveBeenCalledWith("blob:recording-test");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      vi.unstubAllGlobals();
      if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("replays only files that the agreement gate refused, never earlier confirmed files", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [
        { index: 0, outcome: "completed" },
        { index: 1, outcome: "refused", reason: "AGREEMENT_REQUIRED", details: { policyPublicId: orderId, signatureMode: "checkbox" } },
      ] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff={false} policy={policy} onChanged={vi.fn()} />);
    await user.upload(container.querySelector("input[type=file]")!, [
      new File(["first"], "first.pdf", { type: "application/pdf" }), new File(["second"], "second.pdf", { type: "application/pdf" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Upload 2 files" }));
    await user.click(await screen.findByRole("button", { name: "Accept test agreement" }));
    expect(await screen.findByText("2 of 2 uploads confirmed.")).toBeInTheDocument();
    expect((fetchMock.mock.calls[1]![1].body as FormData).getAll("files")).toEqual([expect.objectContaining({ name: "second.pdf" })]);
  });
});

describe("order file tab", () => {
  it.each([true, false])("sends the right general upload binding with stageUploadsRequired=%s", async (stageUploadsRequired) => {
    view.mockResolvedValue({ items: [], nextCursor: null, canUpload: true, uploadPolicy: policy, stageUploadsRequired,
      currentStageKey: "intake_phase", phases: [{ key: "intake_phase", label: "Intake" }], uploadSlots: null });
    phasePolicy.mockResolvedValue({ enabled: true, maxSeconds: 60, policy, remainingDocuments: 3, remainingAudio: 3,
      remainingAudioSeconds: 7200 });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    const user = userEvent.setup();
    const { container } = renderUi(<OrderFilesTab orderId={orderId} area="customer" />);
    await screen.findByRole("button", { name: "Choose files" });
    if (stageUploadsRequired) expect(screen.getByLabelText("Upload phase")).toHaveValue("intake_phase");
    else expect(screen.queryByLabelText("Upload phase")).not.toBeInTheDocument();
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "evidence.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("1 of 1 uploads confirmed.")).toBeInTheDocument();
    const { searchParams } = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://example.test");
    expect(searchParams.get("stageKey")).toBe(stageUploadsRequired ? "intake_phase" : null);
    expect(searchParams.get("intent")).toBe(stageUploadsRequired ? "document" : null);
  });

  it("does not offer an unbound upload for a phased task without a current phase", async () => {
    view.mockResolvedValue({ items: [], nextCursor: null, canUpload: true, uploadPolicy: policy, stageUploadsRequired: true,
      currentStageKey: null, phases: [], uploadSlots: { statusKey: "intake", slots: [
        { key: "voice_evidence", label: "Voice evidence", kind: "audio", maxCount: 1, allowedTypes: ["wav"] },
      ] } });
    const user = userEvent.setup();
    const { container } = renderUi(<OrderFilesTab orderId={orderId} area="customer" />);
    await user.selectOptions(await screen.findByLabelText("Upload to"), "voice_evidence");
    expect(screen.getByText("No current phase is available for this requirement.")).toBeInTheDocument();
    expect(container.querySelector("input[type=file]")).toBeNull();
  });

  it("includes the visible edit text and filename in the console document link name", async () => {
    const file = { ...sample, displayName: "qa-synthetic.docx", extension: "docx" };
    view.mockResolvedValue({ items: [file], nextCursor: null, canUpload: false, uploadPolicy: null });
    const { container } = renderUi(<><h1>Order</h1><OrderFilesTab orderId={orderId} area="console" /></>);
    const links = await screen.findAllByRole("link", { name: "Edit document: qa-synthetic.docx" });
    for (const link of links) expect(link).toHaveTextContent("Edit document");
    await expectNoAxeViolations(container);
  });

  it("binds a format-3 task upload to the current phase and keeps its status and slot", async () => {
    view.mockResolvedValue({ items: [], nextCursor: null, canUpload: true, uploadPolicy: policy, stageUploadsRequired: true,
      currentStageKey: "intake_phase", phases: [{ key: "intake_phase", label: "Intake evidence" }],
      uploadSlots: { statusKey: "intake", slots: [
        { key: "voice_evidence", label: "Voice evidence", kind: "audio", maxCount: 1, allowedTypes: ["wav"] },
      ] } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, outcome: "completed" }] })));
    const user = userEvent.setup();
    const { container } = renderUi(<OrderFilesTab orderId={orderId} area="customer" />);
    await user.selectOptions(await screen.findByLabelText("Upload to"), "voice_evidence");
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "evidence.wav", { type: "audio/wav" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("1 of 1 uploads confirmed.")).toBeInTheDocument();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://example.test");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      stageKey: "intake_phase", intent: "prerecorded_audio", slotKey: "voice_evidence", statusKey: "intake",
    });
  });

  it("groups a mixed file library by phase and custody and orders versions newest first", async () => {
    view.mockResolvedValue({ items: [
      { ...sample, stageKey: "review", displayName: "Older version.pdf" },
      { ...sample, publicId: `${sample.publicId.slice(0, -1)}2`, stageKey: "review", displayName: "Latest version.pdf", version: 2 },
      { ...sample, publicId: `${sample.publicId.slice(0, -1)}3`, stageKey: "intake", displayName: "Team file.pdf", category: "deliverable" },
    ], nextCursor: null, canUpload: false, uploadPolicy: null,
    phases: [{ key: "intake", label: "Intake evidence" }, { key: "review", label: "Final review" }] });
    const { container } = renderUi(<><h1>Order</h1><OrderFilesTab orderId={orderId} area="customer" /></>);
    expect(await screen.findByRole("heading", { name: "Final review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Intake evidence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Final review files (ZIP)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download all files (ZIP)" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deliverable · Customer-visible" })).toBeInTheDocument();
    const latest = screen.getAllByText("Latest version.pdf")[0]!;
    const older = screen.getAllByText("Older version.pdf")[0]!;
    expect(latest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("renders a completed phase as a read-only, downloadable list", async () => {
    let finish = (_response: Response) => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const { container } = renderUi(<><h1>Order</h1><h2>Phases</h2><h3>Completed phase</h3><h4>Documents</h4>
      <PhaseUploadPanel orderId={orderId} stageKey="intake_phase" intent="document" readOnly /></>);
    const list = await screen.findByRole("list", { name: "Uploaded in this phase" });
    const download = within(list).getByRole("button", { name: `Download ${sample.displayName}` });
    expect(within(list).getByText("PDF · 8 B ·", { exact: false })).toBeInTheDocument();
    expect(list.querySelector("time")).toHaveAttribute("datetime", sample.createdAt.toISOString());
    expect(screen.queryByRole("button", { name: "Choose files" })).not.toBeInTheDocument();
    expect(container.querySelector("input[type=file]")).toBeNull();
    await expectNoAxeViolations(container);
    download.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(download).toHaveAttribute("aria-disabled", "true");
    expect(download).toHaveFocus();
    finish(new Response(null, { status: 404 }));
    expect(await screen.findByText("Download not available")).toBeInTheDocument();
    expect(download).toHaveFocus();
  });

  it("shows the uploaded audio list and launches the same ticket-based playback as the order library", async () => {
    const file = { ...sample, displayName: "Recorded evidence.webm", contentType: "audio/webm", extension: "webm" };
    const grantPublicId = `${sample.publicId.slice(0, -1)}4`;
    view.mockResolvedValue({ items: [file, { ...sample, displayName: "Staff note.wav", contentType: "audio/wav", visibility: "staff_only" }],
      nextCursor: null, canUpload: false, uploadPolicy: null });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ grantPublicId })));
    const user = userEvent.setup();
    renderUi(<PhaseUploadedFiles orderId={orderId} stageKey="intake_phase" intent="recording" />);
    expect(screen.getByRole("heading", { level: 5, name: "Uploaded in this phase" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: `Listen to ${file.displayName}` }));
    expect(screen.queryByText("Staff note.wav")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load audio and transcript" }));
    expect(await screen.findByLabelText(`Play ${file.displayName}`)).toHaveAttribute("src", expect.stringContaining(`/api/files/playback/${grantPublicId}`));
  });

  it("shows an empty state for a phase with no uploads", async () => {
    view.mockResolvedValue({ items: [], nextCursor: null, canUpload: false, uploadPolicy: null });
    renderUi(<PhaseUploadedFiles orderId={orderId} stageKey="intake_phase" intent="document" />);
    expect(await screen.findByText("Nothing uploaded yet.")).toBeInTheDocument();
  });

  it("uses the playback grant handle as the media URL without putting the ticket in it", async () => {
    const grantPublicId = `${sample.publicId.slice(0, -1)}4`;
    const file = { ...sample, displayName: "Voice clip.wav", contentType: "audio/wav", extension: "wav" };
    view.mockResolvedValue({ items: [file], nextCursor: null, canUpload: false, uploadPolicy: null });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ grantPublicId })));
    const user = userEvent.setup();
    renderUi(<OrderFilesTab orderId={orderId} area="customer" />);
    await user.click((await screen.findAllByRole("button", { name: `Listen to ${file.displayName}` }))[0]!);
    await user.click(screen.getByRole("button", { name: "Load audio and transcript" }));
    const player = await screen.findByLabelText(`Play ${file.displayName}`);
    expect(player.getAttribute("src")).toContain(`/api/files/playback/${grantPublicId}`);
    expect(player.getAttribute("src")).not.toContain("synthetic-playback-ticket");
    expect(screen.getByText("Synthetic transcript")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/files/playback"), expect.objectContaining({
      method: "POST", body: JSON.stringify({ ticket: "synthetic-playback-ticket" }),
    }));
  });

  it("preselects a task from the Files tab link and focuses the task heading", async () => {
    view.mockResolvedValue({ items: [], nextCursor: null, canUpload: true, uploadPolicy: policy,
      uploadSlots: { statusKey: "intake", slots: [
        { key: "voice_evidence", label: "Voice task", kind: "audio", maxCount: 1, allowedTypes: ["wav"], capture: "either" },
      ] }, audio: { enabled: true, maxMinutes: 30 } });
    renderUi(<OrderFilesTab orderId={orderId} area="customer" />, { path: `/orders/${orderId}/files?slot=voice_evidence` });
    const heading = await screen.findByRole("heading", { name: "Voice task" });
    expect(heading).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByLabelText("Upload to")).toHaveValue("voice_evidence");
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  });

  it("renders a read-only attachment access path without staff controls", async () => {
    const { container } = renderUi(<><h1>Example order</h1><OrderFilesTab orderId={orderId} area="customer" /></>);
    expect(await screen.findByText("File changes unavailable")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: `Download ${sample.displayName}` }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("checkbox", { name: "Include trash" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Actions for ${sample.displayName}` })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("file administration", () => {
  it("labels the rules, identifies unconfigured scanning, validates inputs, and sends bounded changes", async () => {
    const onSave = vi.fn(async () => {});
    const user = userEvent.setup();
    const { container } = renderUi(<FilesAdminContent onSave={onSave} saving={false} audioSaving={false} onSaveAudio={vi.fn()}
      documentSaving={false} onSaveDocument={vi.fn()} overview={{
      rules: { ...policy, retentionDays: 30 },
      supported: { ...policy, maxFileBytes: 100 * 1024 * 1024, maxRequestBytes: 256 * 1024 * 1024, maxFiles: 12 },
      storedBytes: "1024", storedFiles: 4, retainedFiles: 2, antivirus: "not_configured",
      audioRules: { enabled: false, maxMinutes: 5, bitrateKbps: 48, keepOriginal: true }, audioVersion: null,
      documentEditingRules: { enabled: true, maxBytes: 10 * 1024 * 1024 },
    }} />);
    expect(screen.getByRole("heading", { level: 1, name: "File administration" })).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("1 KiB")).toBeInTheDocument();
    await expectNoAxeViolations(container);
    const maxFiles = screen.getByRole("spinbutton", { name: /^Files per upload/u });
    fireEvent.change(maxFiles, { target: { value: "20" } });
    await user.click(screen.getByRole("button", { name: "Save file rules" }));
    expect(screen.getByText(/Check each limit/u)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(maxFiles, { target: { value: "5" } });
    await user.click(screen.getByRole("checkbox", { name: "WAV audio" }));
    await user.click(screen.getByRole("button", { name: "Save file rules" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ maxFiles: 5, extensions: ["pdf", "jpg"] })));
  });
});

pageA11y("Recording setup dialog", async () => {
  document.title = "Order recordings · ReadyPackets";
  renderUi(<main><h1>Order recordings</h1><RecordingPreflight orderId={orderId} deviceId="" onDevice={vi.fn()} onClose={vi.fn()}
    onContinue={vi.fn()} onAgreementRequired={vi.fn()} /></main>);
  expect(await screen.findByRole("button", { name: "Use device recorder" })).toBeInTheDocument();
});
