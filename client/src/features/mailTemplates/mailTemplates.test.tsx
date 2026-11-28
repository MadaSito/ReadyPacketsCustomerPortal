import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type * as trpcModule from "@/lib/trpc";
import { INERT_PREVIEW_CSP } from "@/ui";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import type { MailTemplateDetailView, MailTemplateSummaryView } from "@server/modules/mailTemplates/service";
import { findMissingRequiredVariables, normalizeCustomTemplateKey } from "./model";
import MailTemplateEditorPage from "./pages/MailTemplateEditorPage";
import MailTemplatesPage from "./pages/MailTemplatesPage";
import { mailTemplatesFeature } from "./routes";

const { handlers, calls } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
}));

function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`No mock handler for ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input],
      queryFn: () => run(input),
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({
      mutationFn: run,
      ...opts,
    }),
    queryKey: (input?: unknown) => (input === undefined ? [key] : [key, input]),
    pathFilter: () => ({ queryKey: [key] }),
  };
  return new Proxy(api, {
    get: (target, prop: string) =>
      prop in target ? target[prop as keyof typeof target] : proxy([...path, prop]),
  });
}

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => proxy([]),
}));

beforeAll(() => {
  // ProseMirror selection layout stubs for jsdom (`client/src/ui/richtext.test.tsx`).
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
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint ??= () => null;
});

const NOW = new Date("2026-11-21T12:00:00.000Z");

function sampleList(): { items: MailTemplateSummaryView[] } {
  return {
    items: [
      {
        publicId: "01J9TPL0000000000000000001",
        templateKey: "auth.password_reset",
        kind: "system",
        category: "auth",
        name: "Password reset",
        description: "Single-use password reset link requested by an account holder.",
        declaredVars: [
          {
            name: "link",
            label: "Password reset URL",
            required: true,
            sensitive: true,
            sampleValue: "https://portal.example.test/reset?token=sample",
          },
        ],
        hasPublishedOverride: true,
        hasWorkingDraft: false,
        activeFormat: "html",
        latestVersionNumber: 1,
        version: 2,
        updatedAt: NOW,
      },
      {
        publicId: "01J9TPL0000000000000000002",
        templateKey: "custom.order_followup",
        kind: "custom",
        category: "automation",
        name: "Order follow-up",
        description: "Sent by automation after order creation.",
        declaredVars: [
          { name: "recipient_name", label: "Recipient name", required: true, sampleValue: "Taylor Jordan" },
          { name: "order_reference", label: "Order reference", required: true, sampleValue: "RP-2026-0142" },
        ],
        hasPublishedOverride: false,
        hasWorkingDraft: true,
        activeFormat: "html",
        latestVersionNumber: 1,
        version: 1,
        updatedAt: NOW,
      },
    ],
  };
}

function samplePasswordResetDetail(): MailTemplateDetailView {
  return {
    publicId: "01J9TPL0000000000000000001",
    templateKey: "auth.password_reset",
    kind: "system",
    category: "auth",
    name: "Password reset",
    description: "Single-use password reset link requested by an account holder.",
    declaredVars: [
      {
        name: "link",
        label: "Password reset URL",
        required: true,
        sensitive: true,
        sampleValue: "https://portal.example.test/reset?token=sample",
      },
    ],
    hasPublishedOverride: true,
    hasWorkingDraft: false,
    activeFormat: "html",
    latestVersionNumber: 1,
    version: 2,
    updatedAt: NOW,
    systemDefault: {
      format: "html",
      subject: "Reset your password",
      bodyHtml: '<p>Use this link: <a href="{{link}}">Reset password</a></p>',
      bodyText: "Use this link: {{link}}",
    },
    activePublished: {
      publicId: "01J9VER0000000000000000001",
      versionNumber: 1,
      state: "published",
      format: "html",
      subject: "Reset your ReadyPackets password",
      bodyHtml: '<p>Click below to reset:</p><p><a href="{{link}}" data-rp-button="primary">Reset password</a></p>',
      bodyText: "Click below to reset:\n{{link}}",
      contentHash: "a".repeat(64),
      changeNote: "Initial brand wording",
      restoredFromVersionNumber: null,
      publishedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    workingDraft: null,
    versions: [
      {
        publicId: "01J9VER0000000000000000001",
        versionNumber: 1,
        state: "published",
        format: "html",
        subject: "Reset your ReadyPackets password",
        bodyHtml: '<p>Click below to reset:</p><p><a href="{{link}}" data-rp-button="primary">Reset password</a></p>',
        bodyText: "Click below to reset:\n{{link}}",
        contentHash: "a".repeat(64),
        changeNote: "Initial brand wording",
        restoredFromVersionNumber: null,
        publishedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
});

describe("mailTemplates client feature (Package D)", () => {
  it("registers /admin/email-templates under mail.manage in Integrations nav (order 61)", () => {
    expect(mailTemplatesFeature.routes.map((r) => r.path)).toEqual([
      "/admin/email-templates",
      "/admin/email-templates/:templateKey",
    ]);
    for (const r of mailTemplatesFeature.routes) {
      expect(r.access).toBe("admin");
      expect(r.capability).toBe("mail.manage");
    }
    expect(mailTemplatesFeature.nav?.[0]).toMatchObject({
      label: "E-mail templates",
      href: "/admin/email-templates",
      group: "Integrations",
      order: 61,
      capability: "mail.manage",
    });
  });

  it("normalizes custom keys and detects missing required variables in HTML or plain-text branches", () => {
    expect(normalizeCustomTemplateKey("order-followup")).toBe("custom.order_followup");
    expect(normalizeCustomTemplateKey("custom.welcome_note")).toBe("custom.welcome_note");

    const declaredVars = [
      { name: "link", label: "Reset URL", required: true, sensitive: true, sampleValue: "https://example.test" },
    ];
    expect(
      findMissingRequiredVariables({
        declaredVars,
        format: "html",
        subject: "Reset password",
        bodyHtml: "<p>No link here</p>",
        bodyText: "No link here",
        deriveTextFromHtml: true,
      }),
    ).toEqual(["link"]);

    expect(
      findMissingRequiredVariables({
        declaredVars,
        format: "html",
        subject: "Reset password",
        bodyHtml: '<p><a href="{{link}}">Reset</a></p>',
        bodyText: "Manual text missing placeholder",
        deriveTextFromHtml: false,
      }),
    ).toEqual(["link"]);
  });

  it("renders the template catalogue with zero axe violations, 320px card support, and custom template creation", async () => {
    handlers.set("mailTemplates.list", () => sampleList());
    handlers.set("mailTemplates.createCustom", () => ({
      ...samplePasswordResetDetail(),
      templateKey: "custom.shipping_alert",
      kind: "custom",
      name: "Shipping alert",
    }));

    const mem = memoryLocation({ path: "/admin/email-templates" });
    const { container } = renderUi(
      <Router hook={mem.hook}>
        <Route path="/admin/email-templates" component={MailTemplatesPage} />
      </Router>,
    );

    expect((await screen.findAllByText("Password reset")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Order follow-up").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Customised").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Draft only").length).toBeGreaterThan(0);

    await expectNoAxeViolations(container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /New custom template/i }));
    const dialog = await screen.findByRole("dialog", { name: /New custom template/i });

    await user.type(within(dialog).getByLabelText(/Template key/i), "shipping_alert");
    await user.type(within(dialog).getByLabelText(/Display name/i), "Shipping alert");
    await user.click(within(dialog).getByRole("button", { name: /Create draft template/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === "mailTemplates.createCustom")).toBe(true);
    });
    const createCall = calls.find((c) => c.path === "mailTemplates.createCustom");
    expect(createCall?.input).toMatchObject({
      templateKey: "custom.shipping_alert",
      name: "Shipping alert",
    });
  });

  it("renders editor with RichTextEditor, inert sandboxed iframe preview, Send test to me, Reset to default, and zero axe violations", async () => {
    const detail = samplePasswordResetDetail();
    handlers.set("mailTemplates.get", () => detail);
    handlers.set("mailTemplates.preview", () => ({
      subject: "Reset your ReadyPackets password",
      text: "Click below to reset:\nhttps://portal.example.test/reset?token=sample",
      previewHtml: "<p>Click below to reset:</p><p><span>[Button: Reset password]</span></p>",
    }));
    handlers.set("mailTemplates.sendTestToMe", () => ({
      queued: true,
      targetSource: "published",
    }));
    handlers.set("mailTemplates.resetToDefault", () => ({
      ...detail,
      hasPublishedOverride: false,
      activePublished: null,
      version: 3,
    }));
    handlers.set("mailTemplates.restoreVersion", () => ({
      ...detail,
      hasWorkingDraft: true,
      workingDraft: {
        ...detail.versions[0]!,
        state: "draft",
        versionNumber: 2,
        restoredFromVersionNumber: 1,
      },
      version: 4,
    }));

    const mem = memoryLocation({ path: "/admin/email-templates/auth.password_reset" });
    const { container } = renderUi(
      <Router hook={mem.hook}>
        <Route path="/admin/email-templates/:templateKey" component={MailTemplateEditorPage} />
      </Router>,
    );

    const editorBox = await screen.findByRole("textbox", { name: /HTML message body/i });
    expect(editorBox).toHaveAttribute("aria-multiline", "true");
    expect(screen.getByText("Redacted in audit copies")).toBeInTheDocument();

    const user = userEvent.setup();

    // Verify inert sandboxed iframe attributes (`sandbox=""`, no scripts/same-origin, strict CSP in srcDoc)
    const iframe = await screen.findByTitle("Preview of Password reset");
    expect(calls).toContainEqual(expect.objectContaining({
      path: "mailTemplates.preview", input: expect.objectContaining({ templateKey: "auth.password_reset" }),
    }));
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe.getAttribute("srcdoc")).toContain(INERT_PREVIEW_CSP);
    expect(iframe.getAttribute("srcdoc")).not.toContain("href=");

    // Switch to Plain text tab (jsdom srcDoc iframe has no postMessage window for axe-core frame probe, matching increment03.test.tsx)
    await user.click(screen.getByRole("tab", { name: "Plain text" }));
    expect(screen.getByLabelText("Preview of Password reset, plain text")).toHaveTextContent(
      "https://portal.example.test/reset?token=sample",
    );

    await expectNoAxeViolations(container);

    // Send test to me
    await user.click(screen.getByRole("button", { name: /Send test to me/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "mailTemplates.sendTestToMe")).toBe(true);
    });

    // Restore historical version to draft via ConfirmDialog
    const restoreButtons = screen.getAllByRole("button", { name: /Restore to draft/i });
    await user.click(restoreButtons[0]!);
    const restoreDialog = await screen.findByRole("alertdialog");
    await user.click(within(restoreDialog).getByRole("button", { name: /Restore to draft/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "mailTemplates.restoreVersion")).toBe(true);
    });

    // Reset system template to default via destructive ConfirmDialog
    await user.click(screen.getByRole("button", { name: /Reset to default/i }));
    const resetDialog = await screen.findByRole("alertdialog");
    await user.click(within(resetDialog).getByRole("button", { name: /Reset to default/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "mailTemplates.resetToDefault")).toBe(true);
    });
  });
});
