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
import { RecordingPreflight } from "./RecordingPreflight";

const { fetchMock, view } = vi.hoisted(() => ({ fetchMock: vi.fn(), view: vi.fn() }));
vi.mock("@/lib/agreementGate", () => ({
  AgreementDialog: ({ onAccepted }: { onAccepted: () => Promise<void> }) => <button type="button" onClick={() => { void onAccepted(); }}>Accept test agreement</button>,
  parseAgreementRequiredDetails: () => null,
}));
vi.mock("@/lib/sessionTransport", async (original) => ({
  ...await original<typeof transportModule>(),
  sessionFetch: fetchMock,
}));
vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof trpcModule>(),
  useTRPCClient: () => ({ files: { issueDownloadTicket: { mutate: async () => ({ ticket: "synthetic-test-ticket" }) } } }),
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
});

describe("file upload", () => {
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
    expect(changed).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/api/files/upload/${orderId}?`),
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  });

  it("keeps a lost connection unknown rather than claiming the file was refused", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new Error("synthetic transport interruption"));
    const { container } = renderUi(<FileUploadPanel orderId={orderId} staff policy={policy} onChanged={vi.fn()} />);
    await user.upload(container.querySelector("input[type=file]")!, new File(["synthetic"], "audio.wav"));
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("Unknown outcome")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 uploads confirmed.")).toBeInTheDocument();
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
