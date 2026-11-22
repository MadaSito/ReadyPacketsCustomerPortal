import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import CategoryPage from "./CategoryPage";
import CommunityHomePage from "./CommunityHomePage";
import SearchPage, { searchTerm } from "./SearchPage";
import TopicPage from "./TopicPage";
import { displayNameProblem } from "./shared";

const { handlers, calls } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
}));
function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`no handler for ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({ queryKey: [key, input], queryFn: () => run(input), ...opts }),
    infiniteQueryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input, "infinite"],
      queryFn: ({ pageParam }: { pageParam: unknown }) => run({ ...(input as object), ...(pageParam ? { cursor: pageParam } : {}) }),
      initialPageParam: null,
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]) }));

/* Synthetic fixtures only. */
const NOW = "2026-11-20T12:00:00.000Z";
const ID = (c: string) => `01JQA${c.repeat(21)}`;
const status = (extra: Record<string, unknown> = {}) => ({ enabled: true, profile: { publicId: ID("M"), displayName: "Member A" }, suspended: false, suspendedUntil: null, canModerate: false, canManage: false, ...extra });
const category = { publicId: ID("C"), slug: "general", name: "General", description: "Synthetic category", sortOrder: 0, staffOnlyPosting: false, archived: false, topicCount: 1, version: 1 };
const topic = { publicId: ID("T"), categoryPublicId: ID("C"), title: "Synthetic topic title", author: { publicId: ID("M"), displayName: "Member A", staff: false }, pinned: true, locked: false, state: "open", visible: true, replyCount: 2, lastPostAt: NOW, createdAt: NOW };
const post = (id: string, extra: Record<string, unknown> = {}) => ({
  publicId: ID(id), author: { publicId: ID("S"), displayName: "Helper B", staff: true }, isOpening: false, body: "Hello https://example.test/a", state: "published",
  quote: null, createdAt: NOW, editedAt: null, helpfulCount: 1, reactedByMe: false, mine: false, canEdit: false, version: 1, ...extra,
});
const detail = (posts: unknown[], extra: Record<string, unknown> = {}) => ({ topic, category: { publicId: ID("C"), slug: "general", name: "General" }, subscribed: false, posts, nextCursor: null, ...extra });

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("community.status", () => status());
  handlers.set("community.categories.list", () => [category]);
  handlers.set("community.topics.list", () => ({ items: [topic], nextCursor: null }));
});

const at = (path: string, pattern: string, page: React.ReactNode) => renderUi(<main><Route path={pattern}>{page}</Route></main>, { path });

describe("community customer pages", () => {
  it("home lists categories and recent topics with a staff-safe author line", async () => {
    at("/community", "/community", <CommunityHomePage />);
    expect(await screen.findByRole("link", { name: "General" })).toHaveAttribute("href", "/community/c/general");
    expect(await screen.findByRole("link", { name: "Synthetic topic title" })).toHaveAttribute("href", `/community/t/${ID("T")}`);
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
  });

  it("asks for a display name first and validates it", async () => {
    handlers.set("community.status", () => status({ profile: null }));
    handlers.set("community.profile.save", () => ({ ok: true }));
    at("/community", "/community", <CommunityHomePage />);
    const input = await screen.findByLabelText(/Display name/);
    expect(displayNameProblem("a@b.c")).not.toBeNull();
    expect(displayNameProblem("ab")).not.toBeNull();
    expect(displayNameProblem("Synthetic Member")).toBeNull();
    await userEvent.type(input, "Synthetic Member");
    await userEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await waitFor(() => expect(calls.find((c) => c.path === "community.profile.save")?.input).toEqual({ displayName: "Synthetic Member" }));
  });

  it("shows the unavailable state when the forum is off", async () => {
    handlers.set("community.status", () => status({ enabled: false }));
    at("/community", "/community", <CommunityHomePage />);
    expect(await screen.findByText("This page is not available")).toBeInTheDocument();
  });

  it("category page creates a topic with an idempotency key and hides the form when archived", async () => {
    handlers.set("community.topics.create", () => ({ postPublicId: ID("P"), topicPublicId: ID("T"), state: "published" }));
    const { location } = at("/community/c/general", "/community/c/:slug", <CategoryPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Title/), "A synthetic question");
    await userEvent.type(screen.getByLabelText(/^Post/), "Body text");
    await userEvent.click(screen.getByRole("button", { name: "Post topic" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/community/t/${ID("T")}`));
    const input = calls.find((c) => c.path === "community.topics.create")?.input as Record<string, string>;
    expect(input).toMatchObject({ categoryPublicId: ID("C"), title: "A synthetic question", body: "Body text" });
    expect(input.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("archived category is read-only", async () => {
    handlers.set("community.categories.list", () => [{ ...category, archived: true }]);
    at("/community/c/general", "/community/c/:slug", <CategoryPage />);
    expect(await screen.findByText(/This category is archived/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post topic" })).not.toBeInTheDocument();
  });

  it("topic page: placeholder for hidden posts, staff badge text, safe links, helpful, follow, quote reply", async () => {
    handlers.set("community.topics.get", () => detail([post("A", { isOpening: true }), post("B", { body: null, state: "hidden", author: { publicId: ID("X"), displayName: "Member C", staff: false } })]));
    handlers.set("community.posts.react", () => ({ helpfulCount: 2, reactedByMe: true }));
    handlers.set("community.subscriptions.set", () => ({ subscribed: true }));
    handlers.set("community.posts.reply", () => ({ postPublicId: ID("R"), topicPublicId: ID("T"), state: "pending", notified: 0 }));
    at(`/community/t/${ID("T")}`, "/community/t/:topicPublicId", <TopicPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Synthetic topic title" })).toBeInTheDocument();
    expect(screen.getByText("This post was hidden by a moderator.")).toBeInTheDocument();
    expect(screen.getAllByText("ReadyPackets staff").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "https://example.test/a" })).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    await userEvent.click(screen.getByRole("button", { name: "Helpful (1)" }));
    await waitFor(() => expect(calls.find((c) => c.path === "community.posts.react")?.input).toEqual({ postPublicId: ID("A"), helpful: true }));
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(await screen.findByText(/You are following this topic/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(screen.getByText(/Quoting/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Your reply/), "Thanks");
    await userEvent.click(screen.getByRole("button", { name: "Post reply" }));
    expect(await screen.findByText(/after a moderator reviews it/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "community.posts.reply")?.input).toMatchObject({ topicPublicId: ID("T"), body: "Thanks", quotePostPublicId: ID("A") });
  });

  it("own post: delete with confirmation; others' posts: report dialog with a reason", async () => {
    handlers.set("community.topics.get", () => detail([post("A", { mine: true, canEdit: true }), post("B")]));
    handlers.set("community.posts.delete", () => ({ postPublicId: ID("A"), topicPublicId: ID("T"), state: "deleted" }));
    handlers.set("community.posts.report", () => ({ reportPublicId: ID("Q"), postHidden: false }));
    at(`/community/t/${ID("T")}`, "/community/t/:topicPublicId", <TopicPage />);
    await screen.findByRole("heading", { level: 1, name: "Synthetic topic title" });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete post" }));
    await waitFor(() => expect(calls.some((c) => c.path === "community.posts.delete")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Report" }));
    const dialog = await screen.findByRole("dialog", { name: "Report this post" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Spam or advertising" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(calls.find((c) => c.path === "community.posts.report")?.input).toEqual({ postPublicId: ID("B"), reason: "spam", note: undefined }));
  });

  it("search reads q from the URL", async () => {
    expect(searchTerm("?q=%20hello%20%20world ")).toBe("hello world");
    handlers.set("community.search", () => ({ items: [{ ...topic, matchedPostPublicId: null }], nextCursor: null }));
    at("/community/search?q=synthetic", "/community/search", <SearchPage />);
    expect(await screen.findByRole("link", { name: "Synthetic topic title" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "community.search")?.input).toEqual({ q: "synthetic" });
  });
});

describe("community page a11y", () => {
  pageA11y("community home", async () => {
    document.title = "Community · ReadyPackets";
    at("/community", "/community", <CommunityHomePage />);
    await screen.findByRole("link", { name: "Synthetic topic title" });
  });
  pageA11y("community topic", async () => {
    document.title = "Community topic · ReadyPackets";
    handlers.set("community.topics.get", () => detail([post("A", { isOpening: true }), post("B", { mine: true, canEdit: true })]));
    at(`/community/t/${ID("T")}`, "/community/t/:topicPublicId", <TopicPage />);
    await screen.findByRole("heading", { level: 1, name: "Synthetic topic title" });
  });
  pageA11y("community category", async () => {
    document.title = "Community category · ReadyPackets";
    at("/community/c/general", "/community/c/:slug", <CategoryPage />);
    await screen.findByRole("link", { name: "Synthetic topic title" });
  });
});
