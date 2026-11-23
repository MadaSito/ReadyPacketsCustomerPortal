import { screen, waitFor } from "@testing-library/react";
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
import { knowledgeFeature } from "./routes";

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

const date = new Date("2026-11-20T12:00:00.000Z");
const C1 = "01JCCCCCCCCCCCCCCCCCCCCCC1";
const A1 = "01JAAAAAAAAAAAAAAAAAAAAAA1";

function customerMe(): MeResult {
  return {
    user: {
      publicId: "01JUUUUUUUUUUUUUUUUUUUUUU1",
      role: "customer",
      name: "Jordan Customer",
      email: "jordan@synthetic.test",
      status: "active",
    },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  };
}

const cat1 = {
  publicId: C1,
  parentPublicId: null,
  slug: "getting-started",
  title: "Getting Started",
  description: "First steps for preparing and submitting your packet.",
  sortOrder: 0,
  archivedAt: null,
  version: 1,
  publishedArticleCount: 2,
  children: [],
};

const art1Summary = {
  publicId: A1,
  slug: "preparing-exhibits",
  title: "Preparing Exhibits for Your Packet",
  summary: "How to scan, label, and verify PDF exhibits before uploading.",
  tags: ["exhibits", "pdf"],
  audience: "customers" as const,
  state: "published" as const,
  categoryPublicId: C1,
  categorySlug: "getting-started",
  categoryTitle: "Getting Started",
  reviewedOn: "2026-11-20",
  publishedAt: date,
  viewCount: 14,
  helpfulYesCount: 6,
  helpfulNoCount: 1,
  currentVersionNumber: 1,
  version: 1,
  sortOrder: 0,
  updatedAt: date,
};

const art1Detail = {
  ...art1Summary,
  bodyBlocks: [
    {
      kind: "heading" as const,
      level: 2 as const,
      id: "scanning-settings",
      children: [{ kind: "text" as const, text: "Scanning Settings" }],
    },
    {
      kind: "paragraph" as const,
      children: [
        { kind: "text" as const, text: "Scan PDFs at " },
        { kind: "strong" as const, children: [{ kind: "text" as const, text: "300 DPI" }] },
        { kind: "text" as const, text: " for clear exhibit review." },
      ],
    },
  ],
  toc: [{ id: "scanning-settings", level: 2 as const, text: "Scanning Settings" }],
  attachments: [
    {
      publicId: "01JFFFFFFFFFFFFFFFFFFFFFF1",
      displayName: "Exhibit-Checklist.pdf",
      size: 4096,
      contentType: "application/pdf",
      extension: "pdf",
      createdAt: date,
    },
  ],
  relatedArticles: [],
  myFeedback: null,
  allowFeedbackComments: true,
};

function baseHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "platform.bootstrap": () => ({
      features: { knowledge: true },
      consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
    }),
    "knowledge.status": () => ({ enabled: true, canManage: false, canConfigure: false }),
    "knowledge.help.home": () => ({
      categories: [cat1],
      featuredArticles: [art1Summary],
      popularTags: ["exhibits", "pdf"],
    }),
    "knowledge.help.category": () => ({
      category: cat1,
      parentCategory: null,
      articles: [art1Summary],
    }),
    "knowledge.help.article": () => art1Detail,
    "knowledge.help.search": (raw) => {
      const q = (raw as { q?: string } | undefined)?.q ?? "";
      if (q === "nomatch") {
        return {
          query: q,
          items: [],
          nextCursor: null,
          suggestions: {
            categories: [cat1],
            popularArticles: [art1Summary],
            suggestedTags: ["exhibits"],
          },
        };
      }
      return {
        query: q,
        items: [
          {
            ...art1Summary,
            score: 120,
            titleSegments: [
              { text: "Preparing ", highlight: false },
              { text: "Exhibits", highlight: true },
              { text: " for Your Packet", highlight: false },
            ],
            snippetSegments: [
              { text: "How to scan PDF ", highlight: false },
              { text: "exhibits", highlight: true },
              { text: " before uploading.", highlight: false },
            ],
          },
        ],
        nextCursor: null,
        suggestions: null,
      };
    },
    "knowledge.help.submitFeedback": () => ({
      recorded: true,
      helpfulYesCount: 7,
      helpfulNoCount: 1,
    }),
    ...overrides,
  };
}

function renderHelpAt(
  path: string,
  handlers: Record<string, Handler> = baseHandlers(),
  calls: { path: string; input: unknown }[] = [],
) {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const url = new URL(String(request));
          const data = JSON.parse(
            (typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}",
          ) as Record<string, Parameters<typeof superjson.deserialize>[0]>;
          const paths = url.pathname.slice("/rpc/".length).split(",");
          const result = await Promise.all(
            paths.map(async (p, index) => {
              const respond = handlers[p] ?? SHELL_PROMPT_HANDLERS[p];
              if (!respond) throw new Error(`Unexpected test request: ${p}`);
              const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
              calls.push({ path: p, input });
              const value = await respond(input);
              return { result: { data: superjson.serialize(value) } };
            }),
          );
          return Response.json(result, { status: 200 });
        },
      }),
    ],
  });
  return renderUi(<AppRoutes routes={knowledgeFeature.routes} />, {
    queryClient,
    path,
    api: fakeAuthApi({ me: async () => customerMe() }),
    wrapper: (node) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    ),
  });
}

describe("Customer Help Centre (`/help*`) — WCAG 2.2 AA & behaviour", () => {
  pageA11y("/help home ready", async () => {
    renderHelpAt("/help");
    await screen.findByRole("heading", { level: 1, name: "Knowledge base" });
    await screen.findAllByText("Getting Started");
  });

  pageA11y("/help search results ready", async () => {
    renderHelpAt("/help?q=exhibits");
    await screen.findByRole("heading", { level: 1, name: "Knowledge base" });
    await screen.findByText(/How to scan PDF/i);
  });

  pageA11y("/help/categories/:slug ready", async () => {
    renderHelpAt("/help/categories/getting-started");
    await screen.findByRole("heading", { level: 1, name: "Getting Started" });
    await screen.findByText("Preparing Exhibits for Your Packet");
  });

  pageA11y("/help/articles/:slug ready", async () => {
    renderHelpAt("/help/articles/preparing-exhibits");
    await screen.findByRole("heading", { level: 1, name: "Preparing Exhibits for Your Packet" });
    await screen.findByRole("heading", { level: 2, name: "Scanning Settings" });
  });

  it("renders unavailable empty state when `feature.knowledge` is disabled", async () => {
    renderHelpAt(
      "/help",
      baseHandlers({
        "knowledge.status": () => ({ enabled: false, canManage: false, canConfigure: false }),
      }),
    );
    expect(await screen.findByText(/Knowledge base is not turned on/i)).toBeTruthy();
  });

  it("shows zero-result suggestions and records helpful feedback with optional comment", async () => {
    const user = userEvent.setup();
    const calls: { path: string; input: unknown }[] = [];

    const first = renderHelpAt("/help?q=nomatch", baseHandlers(), calls);
    expect(await screen.findByText(/No matching articles found/i)).toBeTruthy();
    expect(await screen.findByText("Preparing Exhibits for Your Packet")).toBeTruthy();
    first.unmount();

    renderHelpAt("/help/articles/preparing-exhibits", baseHandlers(), calls);
    await screen.findByRole("heading", { level: 1, name: "Preparing Exhibits for Your Packet" });

    const yesBtn = await screen.findByRole("button", { name: /^Yes/i });
    await user.click(yesBtn);

    const commentBox = await screen.findByLabelText(/Optional note for our documentation team/i);
    await user.type(commentBox, "Very clear DPI guidance.");
    await user.click(screen.getByRole("button", { name: /Send note/i }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.path === "knowledge.help.submitFeedback" &&
            (c.input as { comment?: string })?.comment === "Very clear DPI guidance.",
        ),
      ).toBe(true);
    });
  });
});
