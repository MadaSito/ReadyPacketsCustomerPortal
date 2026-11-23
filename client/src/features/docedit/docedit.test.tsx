import { deflateRawSync } from "node:zlib";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import mammoth from "mammoth";
import { Route } from "wouter";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord } from "@server/modules/files/index";
import { DOCX_MIME, editorToDocx } from "@/lib/docconvert";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { OrderDocumentEditView } from "./OrderDocumentEditPage";
import { doceditFeature } from "./routes";

const { handlers, fetchMock } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/sessionTransport", async (original) => ({
  ...(await original<typeof transportModule>()),
  sessionFetch: fetchMock,
}));

vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try {
      return Promise.resolve(handler(input));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") {
          return (input?: unknown, opts?: Record<string, unknown>) => ({
            queryKey: [key, input ?? null],
            queryFn: () => call(key, input),
            ...(opts ?? {}),
          });
        }
        if (prop === "mutationOptions") {
          return () => ({ mutationFn: (input: unknown) => call(key, input) });
        }
        if (prop === "mutate") {
          const parentKey = path.slice(0, -1).join(".");
          return (input: unknown) => call(parentKey, input);
        }
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return {
    ...(await original<typeof trpcModule>()),
    useTRPC: () => node([]),
    useTRPCClient: () => node([]),
  };
});

/** Minimal ZIP builder to inject unsupported OOXML parts (headers, comments) into generated fixtures. */
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const cdSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}

function buildMinimalOoxmlWithHeaderAndComments(paragraphText: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p>
    <w:ins w:id="1" w:author="Reviewer"><w:r><w:t>Tracked note</w:t></w:r></w:ins>
  </w:body>
</w:document>`;
  const headerXml = `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential Header</w:t></w:r></w:p></w:hdr>`;
  const commentsXml = `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>Margin comment</w:t></w:r></w:p></w:comment></w:comments>`;

  return buildZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/document.xml", data: enc.encode(docXml) },
    { name: "word/header1.xml", data: enc.encode(headerXml) },
    { name: "word/comments.xml", data: enc.encode(commentsXml) },
  ]);
}

/** Same-origin Mammoth Worker harness for jsdom unit tests. */
class TestMammothWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(data: { id: number; arrayBuffer: ArrayBuffer; styleMap: string[] }) {
    void (async () => {
      try {
        const res = await mammoth.convertToHtml(
          { buffer: Buffer.from(data.arrayBuffer) },
          { styleMap: data.styleMap, includeDefaultStyleMap: true },
        );
        if (this.terminated) return;
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              id: data.id,
              ok: true,
              rawHtml: res.value,
              messages: res.messages.map((m) => ({ type: m.type, message: m.message })),
            },
          }),
        );
      } catch (err) {
        if (this.terminated) return;
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              id: data.id,
              ok: false,
              errorMessage: err instanceof Error ? err.message : "Worker conversion failed.",
            },
          }),
        );
      }
    })();
  }

  terminate() {
    this.terminated = true;
  }
}

const ORDER_ID = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const FILE_V1_ID = "01JABCDEFGHJKMNPQRSTVWXYZ2";
const FILE_V2_ID = "01JABCDEFGHJKMNPQRSTVWXYZ3";
const LAZY_WAIT = { timeout: 15_000 } as const;

function makeFileRecord(patch: Partial<FileRecord> = {}): FileRecord {
  return {
    publicId: FILE_V1_ID,
    logicalPublicId: "01JABCDEFGHJKMNPQRSTVWXYZ9",
    orderPublicId: ORDER_ID,
    phasePublicId: null,
    version: 1,
    slotKey: "engagement_letter",
    statusKey: "intake",
    displayName: "engagement-questionnaire.docx",
    contentType: DOCX_MIME,
    extension: "docx",
    size: 4096,
    sha256: "a".repeat(64),
    category: "intake_attachment",
    visibility: "customer_visible",
    conversionState: null,
    conversionReason: null,
    durationSeconds: null,
    derivedFromPublicId: null,
    derivedFromFileId: null,
    supersededAt: null,
    deletedAt: null,
    createdAt: new Date("2026-11-23T10:00:00.000Z"),
    ...patch,
  };
}

describe("docedit feature (Increment 06 D9)", () => {
  const originalWorker = globalThis.Worker;

  beforeAll(() => {
    // ProseMirror measures selections; jsdom has no layout.
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
    Range.prototype.getBoundingClientRect ??= () => rect;
    Range.prototype.getClientRects ??= () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    document.elementFromPoint ??= () => null;
  });

  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    fetchMock.mockReset();
    (globalThis as unknown as { Worker: unknown }).Worker = TestMammothWorker;
  });

  afterEach(() => {
    (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
    vi.restoreAllMocks();
  });

  it("exposes lazy customer and staff routes in doceditFeature", () => {
    expect(doceditFeature.routes?.map((r) => ({ path: r.path, access: r.access }))).toEqual([
      { path: "/orders/:orderId/documents/:fileId/edit", access: "customer" },
      { path: "/admin/orders/:orderId/documents/:fileId/edit", access: "staff" },
    ]);
  });

  it(
    "opens a .docx, surfaces detected unsupported OOXML elements, edits tables/alignment without inline styles or storage, guards unsaved changes, and saves a new version",
    async () => {
      const storageSpy = vi.spyOn(Storage.prototype, "setItem");
      const user = userEvent.setup();
      const docxBytes = buildMinimalOoxmlWithHeaderAndComments("Initial questionnaire prompt");
      const v1 = makeFileRecord({ size: docxBytes.byteLength });
      const v2 = makeFileRecord({
        publicId: FILE_V2_ID,
        version: 2,
        derivedFromPublicId: FILE_V1_ID,
        derivedFromFileId: FILE_V1_ID,
        slotKey: "engagement_letter_reply",
        createdAt: new Date("2026-11-23T10:05:00.000Z"),
      });

      handlers["files.document.status"] = (input) => {
        const req = input as { filePublicId: string; taskKey?: string };
        return {
          enabled: true,
          maxBytes: 10 * 1024 * 1024,
          canEdit: true,
          disabledReason: null,
          agreementPolicyPublicId: null,
          agreementSignatureMode: null,
          file: req.filePublicId === FILE_V2_ID ? v2 : v1,
        };
      };

      handlers["files.document.versions"] = (input) => {
        const req = input as { filePublicId: string };
        if (req.filePublicId === FILE_V2_ID) {
          return [
            v2,
            makeFileRecord({
              ...v1,
              supersededAt: new Date("2026-11-23T10:05:00.000Z"),
            }),
          ];
        }
        return [v1];
      };

      let uploadedFormFile: File | null = null;
      let uploadedUrl = "";

      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (!init?.method || init.method === "GET") {
          return new Response(docxBytes, {
            status: 200,
            headers: { "Content-Type": DOCX_MIME },
          });
        }
        if (init.method === "POST") {
          uploadedUrl = url;
          const body = init.body as FormData;
          uploadedFormFile = body.get("files") as File;
          return new Response(JSON.stringify(v2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Unsupported", { status: 405 });
      });

      const editPath = `/orders/${ORDER_ID}/documents/${FILE_V1_ID}/edit?taskKey=engagement_letter`;
      const { container, location } = renderUi(
        <Route path="/orders/:orderId/documents/:fileId/edit">
          <OrderDocumentEditView area="customer" />
        </Route>,
        { path: editPath },
      );

      // Wait for Mammoth Worker conversion and lazy TipTap editor chunk to mount under CI load
      const textbox = await screen.findByRole(
        "textbox",
        { name: "engagement-questionnaire.docx" },
        LAZY_WAIT,
      );
      await waitFor(() => {
        expect(textbox.textContent).toContain("Initial questionnaire prompt");
      }, LAZY_WAIT);

      // Verify honest limits warning lists detected unsupported OOXML elements
      expect(screen.getByText("Portal Word editing limits")).toBeInTheDocument();
      expect(screen.getByText("Headers and footers:")).toBeInTheDocument();
      expect(screen.getByText("Comments:")).toBeInTheDocument();
      expect(screen.getByText("Tracked changes:")).toBeInTheDocument();

      // Automated WCAG 2.2 AA check (axe-core)
      await expectNoAxeViolations(container);

      // Edit content: align center, insert a 3x3 table, and type text
      await user.click(textbox);
      await user.keyboard(" — Customer completed answer");
      await user.click(screen.getByRole("button", { name: "Align center" }));
      await user.click(screen.getByRole("button", { name: "Table actions" }));
      const insertTableItem = await screen.findByRole(
        "menuitem",
        { name: "Insert 3x3 table" },
        LAZY_WAIT,
      );
      await user.click(insertTableItem);

      await waitFor(() => {
        expect(container.querySelector("table")).not.toBeNull();
        expect(container.querySelector('[data-text-align="center"]')).not.toBeNull();
      }, LAZY_WAIT);

      // Strict CSP invariant: zero inline `style` attributes in the rendered editor DOM
      expect(container.querySelector(".rp-docedit [style]")).toBeNull();

      // Zero browser persistence invariant: nothing written to Web Storage
      expect(storageSpy).not.toHaveBeenCalled();

      // Unsaved-changes guard: beforeunload cancels unload, and "Back to order" opens ConfirmDialog
      const unloadEvent = new Event("beforeunload", { cancelable: true });
      fireEvent(window, unloadEvent);
      expect(unloadEvent.defaultPrevented).toBe(true);

      await user.click(screen.getByRole("button", { name: "Back to order" }));
      expect(
        await screen.findByText("Leave with unsaved document changes?", {}, LAZY_WAIT),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Keep editing" }));

      // Save as new version
      const saveButton = screen.getByRole("button", { name: "Save as new version" });
      expect(saveButton).not.toBeDisabled();
      await user.click(saveButton);

      await waitFor(() => {
        expect(uploadedFormFile).not.toBeNull();
      }, LAZY_WAIT);
      expect(uploadedUrl).toContain(
        `/api/files/orders/${ORDER_ID}/${FILE_V1_ID}/document?taskKey=engagement_letter`,
      );
      expect(uploadedFormFile!.name).toBe("engagement-questionnaire.docx");
      expect(uploadedFormFile!.type).toBe(DOCX_MIME);
      expect(uploadedFormFile!.size).toBeGreaterThan(500);

      // Navigates to newly saved version v2 and renders version history lineage ("Edited from v1")
      await waitFor(() => {
        expect(location.history.at(-1)).toBe(
          `/orders/${ORDER_ID}/documents/${FILE_V2_ID}/edit`,
        );
      }, LAZY_WAIT);
      expect(await screen.findByText("Edited from v1", {}, LAZY_WAIT)).toBeInTheDocument();
    },
    30_000,
  );

  it(
    "renders read-only mode with order agreement prompt when AGREEMENT_REQUIRED blocks editing",
    async () => {
      const built = await editorToDocx("<p>Agreement gated document</p>");
      const responseBytes = new Uint8Array(built.bytes.byteLength);
      responseBytes.set(built.bytes);
      const v1 = makeFileRecord({ size: responseBytes.byteLength });

      handlers["files.document.status"] = () => ({
        enabled: true,
        maxBytes: 10 * 1024 * 1024,
        canEdit: false,
        disabledReason: "Sign the required order agreement before saving document changes.",
        agreementPolicyPublicId: "01JPOLICYABCDEFGHJKMNPQRST",
        agreementSignatureMode: "typed_name",
        file: v1,
      });
      handlers["files.document.versions"] = () => [v1];

      fetchMock.mockResolvedValue(
        new Response(responseBytes, { status: 200, headers: { "Content-Type": DOCX_MIME } }),
      );

      renderUi(
        <Route path="/orders/:orderId/documents/:fileId/edit">
          <OrderDocumentEditView area="customer" />
        </Route>,
        { path: `/orders/${ORDER_ID}/documents/${FILE_V1_ID}/edit` },
      );

      expect(
        await screen.findByText("Order agreement required before saving", {}, LAZY_WAIT),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Review and sign order agreement" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save as new version" }),
      ).not.toBeInTheDocument();
    },
    30_000,
  );
});
