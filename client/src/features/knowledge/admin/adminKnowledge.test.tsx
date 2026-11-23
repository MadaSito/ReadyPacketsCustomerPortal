import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { AppRoutes } from "@/app/AppRouter";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";
import { knowledgeFeature } from "../routes";
import { moveItem, slugify } from "./AdminKnowledgeListPage";
import { validateArticle } from "./AdminKnowledgeEditorPage";

/** Queries every full-session shell makes (policy enforcement prompt, increment 06); empty = no prompt. */
const SHELL_PROMPT_HANDLERS: Record<string, () => unknown> = {
  "compliance.policies.enforcement.pending": () => [],
  "compliance.policies.myStatus": () => ({ pendingRequired: [] }),
};

vi.mock("@/app/slots", () => ({
  NotificationSlot: () => null,
  GlobalSearchSlot: () => null,
  AnalyticsConsentSlot: () => null,
  CookieConsentSlot: () => null,
  CustomerMaintenanceSlot: () => null,
  CartBadgeSlot: () => null,
  SsoSignInSlot: () => null,
}));

type Handler = (input: unknown) => unknown;
class Refuse {
  constructor(readonly code: string, readonly httpStatus: number, readonly safe?: Record<string, unknown>) {}
}
const date = new Date("2026-11-20T12:00:00.000Z");
const A1 = "01JAAAAAAAAAAAAAAAAAAAAAA1";
const A2 = "01JAAAAAAAAAAAAAAAAAAAAAA2";
const C1 = "01JCCCCCCCCCCCCCCCCCCCCCC1";
const C2 = "01JCCCCCCCCCCCCCCCCCCCCCC2";

function me(role: "staff" | "admin"): MeResult {
  return { user: { publicId: "usr_1", role, name: "Avery Example", email: "a@example.test", status: "active" }, state: "full", pendingSteps: [], nextStep: null };
}

const summary = (publicId: string, title: string, state: "draft" | "published" | "archived") => ({
  publicId,
  slug: slugify(title),
  title,
  summary: `${title} summary`,
  tags: ["billing"],
  audience: "customers" as const,
  state,
  categoryPublicId: C1,
  categorySlug: "billing",
  categoryTitle: "Billing",
  reviewedOn: null,
  publishedAt: state === "published" ? date : null,
  viewCount: 4,
  helpfulYesCount: 3,
  helpfulNoCount: 1,
  currentVersionNumber: 2,
  version: 5,
  sortOrder: 0,
  updatedAt: date,
});
const category = (publicId: string, title: string, sortOrder: number) => ({ publicId, parentPublicId: null, slug: slugify(title), title, description: null, sortOrder, archivedAt: null, version: 1, publishedArticleCount: 1, children: [] });
const detail = {
  ...summary(A1, "Paying an invoice", "draft"),
  bodyHtml: "<h2>Steps</h2><p>Open the invoice.</p>",
  bodyBlocks: [{ type: "heading", level: 2, id: "steps", text: "Steps" }],
  toc: [{ id: "steps", level: 2, text: "Steps" }],
  attachments: [{ publicId: "01JFFFFFFFFFFFFFFFFFFFFFF1", displayName: "guide.pdf", size: 2048, contentType: "application/pdf", extension: "pdf", createdAt: date }],
  relatedArticles: [],
  myFeedback: null,
  allowFeedbackComments: true,
  uploadPolicy: { extensions: ["pdf", "png"], maxFileBytes: 10_485_760, maxRequestBytes: 52_428_800, maxFiles: 5 },
};

function base(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "platform.bootstrap": () => ({ features: { knowledge: true }, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }),
    "knowledge.status": () => ({ enabled: false, canManage: true, canConfigure: true }),
    "knowledge.admin.categories.list": () => ({ items: [category(C1, "Billing", 0), category(C2, "Accounts", 1)] }),
    "knowledge.admin.articles.list": () => ({ items: [summary(A1, "Paying an invoice", "draft"), summary(A2, "Changing your email", "published")], nextCursor: null }),
    "knowledge.admin.articles.get": () => detail,
    "knowledge.admin.articles.versions": () => ({
      items: [
        { publicId: "v2", versionNumber: 2, slug: "paying-an-invoice", title: "Paying an invoice", summary: "s", tags: [], audience: "customers", reviewedOn: null, changeNote: "Clarified steps", createdAt: date },
        { publicId: "v1", versionNumber: 1, slug: "paying-an-invoice", title: "Paying an invoice", summary: "s", tags: [], audience: "customers", reviewedOn: null, changeNote: null, createdAt: date },
      ],
    }),
    "knowledge.admin.insights": () => ({
      stats: { publishedCustomerArticles: 1, publishedStaffArticles: 0, draftArticles: 1, archivedArticles: 0, totalViews: 8, helpfulYesTotal: 3, helpfulNoTotal: 1 },
      topSearches: [{ term: "invoice", searchCount: 5, zeroResultCount: 0, lastResultCount: 2, lastSearchedAt: date }],
      zeroResultSearches: [{ term: "refund", zeroResultCount: 2, searchCount: 2, lastSearchedAt: date }],
      recentFeedback: [],
    }),
    "knowledge.admin.settings.get": () => ({ enabled: false, searchLogRetentionDays: 90, allowFeedbackComments: true }),
    ...overrides,
  };
}

function renderAt(path: string, handlers: Record<string, Handler>, calls: { path: string; input: unknown }[] = [], role: "staff" | "admin" = "admin") {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const url = new URL(String(request));
          const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as Record<string, Parameters<typeof superjson.deserialize>[0]>;
          const paths = url.pathname.slice("/rpc/".length).split(",");
          const result = await Promise.all(
            paths.map(async (p, index) => {
              const respond = handlers[p] ?? SHELL_PROMPT_HANDLERS[p];
              if (!respond) throw new Error(`Unexpected test request: ${p}`);
              const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
              calls.push({ path: p, input });
              const value = await respond(input);
              if (value instanceof Refuse) return { error: superjson.serialize({ message: "Refused", code: -32603, data: { code: value.code, httpStatus: value.httpStatus, ...(value.safe ? { safe: value.safe } : {}) } }) };
              return { result: { data: superjson.serialize(value) } };
            }),
          );
          return Response.json(result, { status: result.some((r) => "error" in r) ? 207 : 200 });
        },
      }),
    ],
  });
  return renderUi(<AppRoutes routes={knowledgeFeature.routes} />, {
    queryClient,
    path,
    api: fakeAuthApi({ me: async () => me(role) }),
    wrapper: (node) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    ),
  });
}

const LAZY_WAIT = { timeout: 15_000 } as const;
const TEST_TIMEOUT = { timeout: 25_000 } as const;
const ready = async (name: string) => screen.findByRole("heading", { level: 1, name }, LAZY_WAIT);

describe("knowledge console page a11y", TEST_TIMEOUT, () => {
  pageA11y("/admin/knowledge articles ready", async () => {
    renderAt("/admin/knowledge", base());
    await ready("Knowledge base");
    await screen.findAllByText("Paying an invoice", {}, LAZY_WAIT);
  });

  pageA11y("/admin/knowledge category dialog open", async () => {
    renderAt("/admin/knowledge", base());
    await ready("Knowledge base");
    await userEvent.click(screen.getByRole("tab", { name: "Categories" }));
    await userEvent.click(await screen.findByRole("button", { name: "New category" }, LAZY_WAIT));
    await screen.findByRole("dialog", { name: "New category" }, LAZY_WAIT);
  });

  pageA11y("/admin/knowledge/new ready", async () => {
    renderAt("/admin/knowledge/new", base());
    await ready("New article");
    await screen.findByLabelText(/Title/, {}, LAZY_WAIT);
    await screen.findByRole("textbox", { name: /Article text/ }, LAZY_WAIT);
  });

  pageA11y("/admin/knowledge/:id preview open", async () => {
    renderAt(`/admin/knowledge/${A1}`, base({ "knowledge.admin.articles.preview": () => ({ sanitizedHtml: "<h2>Steps</h2>", bodyBlocks: detail.bodyBlocks, toc: detail.toc }) }));
    await ready("Edit article");
    await userEvent.click(await screen.findByRole("button", { name: "Preview" }, LAZY_WAIT));
    await screen.findByRole("dialog", { name: "Preview" }, LAZY_WAIT);
  });
});

describe("knowledge console helpers", () => {
  it("slugifies titles and moves items within bounds", () => {
    expect(slugify("  Paying an Invoice — fast! ")).toBe("paying-an-invoice-fast");
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("validates article fields like the server", () => {
    const errors = validateArticle({ title: "x", summary: "hey", slug: "Bad Slug", bodyHtml: "<p> </p>", categoryPublicId: "", audience: "customers", tags: [], reviewedOn: "21/11", related: [], changeNote: "" });
    expect(Object.keys(errors).sort()).toEqual(["bodyHtml", "reviewedOn", "slug", "summary", "title"]);
  });
});

describe("knowledge console list", TEST_TIMEOUT, () => {
  it("applies filters and publishes with the expected version", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderAt("/admin/knowledge", base({ "knowledge.admin.articles.setState": () => detail }), calls);
    await ready("Knowledge base");
    expect(await screen.findByText(/Customers cannot see the help centre yet/, {}, LAZY_WAIT)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("State"), "published");
    await waitFor(() => expect(calls.some((c) => c.path === "knowledge.admin.articles.list" && (c.input as { state?: string }).state === "published")).toBe(true), LAZY_WAIT);
    const [publish] = await screen.findAllByRole("button", { name: "Publish Paying an invoice" }, LAZY_WAIT);
    await userEvent.click(publish!);
    await waitFor(() => expect(calls.find((c) => c.path === "knowledge.admin.articles.setState")?.input).toEqual({ publicId: A1, expectedVersion: 5, state: "published" }), LAZY_WAIT);
  });

  it("reorders categories with buttons and announces the move", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderAt("/admin/knowledge", base({ "knowledge.admin.categories.reorder": () => ({ updated: 2 }) }), calls);
    await ready("Knowledge base");
    await userEvent.click(screen.getByRole("tab", { name: "Categories" }));
    const up = await screen.findByRole("button", { name: "Move Billing up" }, LAZY_WAIT);
    expect((up as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Move Billing down" }));
    await waitFor(() => expect(calls.find((c) => c.path === "knowledge.admin.categories.reorder")?.input).toEqual({ parentPublicId: null, orderedPublicIds: [C2, C1] }), LAZY_WAIT);
    expect(await screen.findByText("Billing moved to position 2 of 2", {}, LAZY_WAIT)).toBeTruthy();
  });

  it("asks for step-up before changing settings", async () => {
    renderAt("/admin/knowledge", base({ "knowledge.admin.settings.update": () => new Refuse("FORBIDDEN", 403, { domainCode: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED", safeMessage: "Verify" }) }));
    await ready("Knowledge base");
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("switch", { name: /Show the help centre to customers/ }, LAZY_WAIT));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" }, LAZY_WAIT)).toBeTruthy();
  });

  it("disables settings for staff without platform.settings.manage", async () => {
    renderAt("/admin/knowledge", base({ "knowledge.status": () => ({ enabled: true, canManage: true, canConfigure: false }) }), [], "staff");
    await ready("Knowledge base");
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(((await screen.findByRole("switch", { name: /Show the help centre/ }, LAZY_WAIT)) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Only administrators can change these settings.")).toBeTruthy();
  });
});

describe("knowledge console editor", TEST_TIMEOUT, () => {
  it("restores a version with the current expected version", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderAt(`/admin/knowledge/${A1}`, base({ "knowledge.admin.articles.restoreVersion": () => detail }), calls);
    await ready("Edit article");
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }, LAZY_WAIT));
    const dialog = await screen.findByRole("alertdialog", { name: "Restore version 1?" }, LAZY_WAIT);
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(calls.find((c) => c.path === "knowledge.admin.articles.restoreVersion")?.input).toEqual({ publicId: A1, expectedVersion: 5, versionNumber: 1, changeNote: "Restored version 1" }), LAZY_WAIT);
  });

  it("shows field errors instead of sending an invalid article", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderAt("/admin/knowledge/new", base(), calls);
    await ready("New article");
    await userEvent.click(await screen.findByRole("button", { name: "Save draft" }, LAZY_WAIT));
    expect(await screen.findByText("Enter a title of 2 to 200 characters.", {}, LAZY_WAIT)).toBeTruthy();
    expect(calls.some((c) => c.path === "knowledge.admin.articles.create")).toBe(false);
  });
});
