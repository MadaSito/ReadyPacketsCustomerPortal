import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import type { CategoryView, CommunityConfig, CommunityStatusView, ModerationLogView, QueueView } from "../api";
import { CommunityBody, LINK_REL, parseInline } from "../text";
import CommunitySettingsPage from "./CommunitySettingsPage";
import ModerationPage from "./ModerationPage";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` (same pattern as automations.test.tsx) ---- */
const { handlers, calls } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  calls: [] as { path: string; input: unknown }[],
}));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    calls.push({ path, input });
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

/* Synthetic fixtures only — no real names, e-mails or content. */
const NOW = "2026-11-20T12:00:00.000Z";
const status = (enabled: boolean): CommunityStatusView =>
  ({ enabled, profile: null, suspended: false, suspendedUntil: null, canModerate: true, canManage: true }) as CommunityStatusView;
const config: CommunityConfig = {
  editWindowMinutes: 30, newMemberDays: 7, newMemberDailyPosts: 5, newMemberReviewPosts: 2, maxPostsPerHour: 20, autoHideReportCount: 3, blockedWords: [], heldWords: ["refund"],
};
const cat = (n: number, extra: Partial<CategoryView> = {}): CategoryView => ({
  publicId: `cc_synthetic_000${n}`, slug: `cat-${n}`, name: `Category ${n}`, description: "", sortOrder: n, staffOnlyPosting: false, archived: false, topicCount: n, version: 1, ...extra,
});
const queue = (): QueueView => ({
  pending: [{
    publicId: "cp_synthetic_0001", topicPublicId: "ct_synthetic_0001", topicTitle: "Synthetic topic", heldReason: "new_member", state: "pending",
    body: "Hello see https://example.test/a and javascript:alert(1)", author: { publicId: "cm_synthetic_0001", displayName: "Member A", staff: false },
    createdAt: NOW, editedAt: null, quote: null, canEdit: false, helpfulCount: 0, version: 1,
  }] as unknown as QueueView["pending"],
  reports: [{ publicId: "cr_synthetic_0001", postPublicId: "cp_synthetic_0002", topicPublicId: "ct_synthetic_0001", reason: "spam", note: "Looks automated", createdAt: NOW, openReportsOnPost: 2 }],
});
const log: { items: ModerationLogView[]; nextCursor: null } = {
  items: [{ publicId: "cl_synthetic_0001", action: "approve" as ModerationLogView["action"], targetType: "post", targetPublicId: "cp_synthetic_0003", reason: null, actor: "Moderator", createdAt: NOW }],
  nextCursor: null,
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers["community.status"] = () => status(true);
  handlers["community.mod.queue"] = () => queue();
  handlers["community.mod.log"] = () => log;
  handlers["community.mod.post"] = () => ({ ok: true });
  handlers["community.mod.reports.resolve"] = () => ({ ok: true });
  handlers["community.admin.settings.get"] = () => ({ enabled: true, config, categories: [cat(1), cat(2, { archived: true })] });
  handlers["community.admin.setEnabled"] = (i) => i;
  handlers["community.admin.settings.update"] = (i) => i;
  handlers["community.admin.categories.reorder"] = () => ({ ok: true });
  handlers["community.admin.categories.update"] = () => ({ ok: true });
  handlers["community.admin.categories.create"] = () => cat(3);
});
afterEach(() => vi.clearAllMocks());

/* Rendered directly (not via AppRoutes, whose customer routes are owned elsewhere); the route title is set as AppRoutes would. */
const page = (ui: React.ReactElement, path: string) => {
  document.title = path.endsWith("settings") ? "Community settings" : "Community moderation";
  return renderUi(<main id="main">{ui}</main>, { path });
};

describe("community text rendering (escape on render, safe links)", () => {
  it("links only https URLs with the UGC rel and never injects HTML", () => {
    const { container } = render(<CommunityBody text={'<img src=x onerror="alert(1)"> https://example.test/x http://plain.test javascript:alert(1)'} />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.test/x");
    expect(links[0]!.getAttribute("rel")).toBe(LINK_REL);
    expect(LINK_REL).toBe("noopener noreferrer nofollow ugc");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
  it("does not turn javascript: or data: into links", () => {
    const parts = parseInline("javascript:alert(1) data:text/html,x");
    expect(JSON.stringify(parts)).not.toContain("href");
  });
});

describe("ModerationPage", () => {
  it("shows an off callout and makes no moderator calls when the forum is off", async () => {
    handlers["community.status"] = () => status(false);
    page(<ModerationPage />, "/admin/community");
    expect(await screen.findByText("The community forum is switched off")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "community.mod.queue")).toBe(false);
  });

  it("approves a held post and renders its body without linking javascript:", async () => {
    const user = userEvent.setup();
    page(<ModerationPage />, "/admin/community");
    const list = await screen.findByRole("list", { name: "Posts waiting for review" });
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).not.toContain("javascript:alert(1)");
    await user.click(within(list).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "community.mod.post", input: { postPublicId: "cp_synthetic_0001", action: "approve" } }));
  });

  it("asks for confirmation before removing", async () => {
    const user = userEvent.setup();
    page(<ModerationPage />, "/admin/community");
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.path === "community.mod.post")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove post" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "community.mod.post", input: { postPublicId: "cp_synthetic_0001", action: "remove" } }));
  });

  it("dismisses a report", async () => {
    const user = userEvent.setup();
    page(<ModerationPage />, "/admin/community");
    await user.click(await screen.findByRole("tab", { name: /Reports/u }));
    await user.click((await screen.findAllByRole("button", { name: "Dismiss" }))[0]!);
    await waitFor(() => expect(calls).toContainEqual({ path: "community.mod.reports.resolve", input: { reportPublicId: "cr_synthetic_0001", outcome: "dismissed" } }));
  });

  pageA11y("/admin/community queue", async () => {
    page(<ModerationPage />, "/admin/community");
    await screen.findByRole("list", { name: "Posts waiting for review" });
  });
  pageA11y("/admin/community remove dialog open", async () => {
    const user = userEvent.setup();
    page(<ModerationPage />, "/admin/community");
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await screen.findByRole("alertdialog");
  });
});

describe("CommunitySettingsPage", () => {
  it("switches the forum off through step-up", async () => {
    const user = userEvent.setup();
    page(<CommunitySettingsPage />, "/admin/community/settings");
    await user.click(await screen.findByRole("switch", { name: /Community forum switched on/u }));
    await waitFor(() => expect(calls).toContainEqual({ path: "community.admin.setEnabled", input: { enabled: false } }));
  });

  it("refuses an out-of-range number without calling the server", async () => {
    const user = userEvent.setup();
    page(<CommunitySettingsPage />, "/admin/community/settings");
    const input = await screen.findByRole("spinbutton", { name: /Posts per hour per member/u });
    await user.clear(input);
    await user.type(input, "999");
    await user.click(screen.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByText("Enter a whole number from 1 to 200.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "community.admin.settings.update")).toBe(false);
  });

  it("moves a category down with a button (non-drag alternative)", async () => {
    const user = userEvent.setup();
    page(<CommunitySettingsPage />, "/admin/community/settings");
    await user.click(await screen.findByRole("button", { name: "Move Category 1 down" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "community.admin.categories.reorder", input: { orderedPublicIds: ["cc_synthetic_0002", "cc_synthetic_0001"] } }));
    expect(screen.getByRole("button", { name: "Move Category 1 up" })).toBeDisabled();
  });

  it("validates the category web address", async () => {
    const user = userEvent.setup();
    page(<CommunitySettingsPage />, "/admin/community/settings");
    await user.type(await screen.findByRole("textbox", { name: /^Name/u }), "Billing");
    await user.type(screen.getByRole("textbox", { name: /^Web address/u }), "Bad Slug!");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByText(/Use lower-case letters/u)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "community.admin.categories.create")).toBe(false);
  });

  pageA11y("/admin/community/settings ready", async () => {
    page(<CommunitySettingsPage />, "/admin/community/settings");
    await screen.findByRole("heading", { name: "Categories" });
  });
});
