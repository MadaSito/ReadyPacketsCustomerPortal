import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord, UploadPolicy } from "@server/modules/files/index";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { FileUploadPanel } from "./FileUploadPanel";
import { FilesAdminContent } from "./FilesAdminPage";
import OrderFilesTab from "./OrderFilesTab";

const { fetchMock, view } = vi.hoisted(() => ({ fetchMock: vi.fn(), view: vi.fn() }));
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
      files: {
        list: {
          infiniteQueryOptions: () => ({
            queryKey: ["file-tabs", "fixture"], queryFn: view, initialPageParam: null,
            getNextPageParam: () => undefined,
          }),
          pathKey: () => ["file-tabs"],
        },
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
});

describe("order file tab", () => {
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
    const { container } = renderUi(<FilesAdminContent onSave={onSave} saving={false} overview={{
      rules: { ...policy, retentionDays: 30 },
      supported: { ...policy, maxFileBytes: 100 * 1024 * 1024, maxRequestBytes: 256 * 1024 * 1024, maxFiles: 12 },
      storedBytes: "1024", storedFiles: 4, retainedFiles: 2, antivirus: "not_configured",
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
