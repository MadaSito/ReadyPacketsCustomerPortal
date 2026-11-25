import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCatalogItem } from "@shared/orderStatusCatalog";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import OrdersPipelineWidget from "./OrdersPipelineWidget";
import AdminOrdersPage from "./pages/AdminOrdersPage";
import AdminWorkflowsPage from "./pages/AdminWorkflowsPage";
import AdminWorkflowStatusesPage from "./pages/workflows/AdminWorkflowStatusesPage";
import { ordersFeature } from "./routes";

const { handlers, calls, session } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
  session: { role: "admin" as string },
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
      queryFn: ({ pageParam }: { pageParam: unknown }) => run({ ...(input as object), cursor: pageParam ?? undefined }),
      initialPageParam: null,
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    mutate: run,
    query: run,
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}

vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));

const BASE_ITEMS: StatusCatalogItem[] = [
  {
    publicId: "01JSTATUS00000000000000001",
    key: "intake_open",
    staffLabel: "Intake open",
    customerLabel: "Upload your materials",
    tone: "warning",
    category: "waiting",
    attention: "customer_response",
    position: 0,
    retired: false,
    retiredAt: null,
    version: 1,
    usage: { activeOrderCount: 2, draftCount: 0, publishedVersionCount: 1 },
  },
  {
    publicId: "01JSTATUS00000000000000002",
    key: "in_review",
    staffLabel: "Intake review",
    customerLabel: "In review",
    tone: "info",
    category: "working",
    attention: "staff_review",
    position: 1,
    retired: false,
    retiredAt: null,
    version: 2,
    usage: { activeOrderCount: 3, draftCount: 1, publishedVersionCount: 1 },
  },
  {
    publicId: "01JSTATUS00000000000000003",
    key: "legacy_hold",
    staffLabel: "Legacy hold",
    customerLabel: "On hold",
    tone: "neutral",
    category: "waiting",
    attention: "none",
    position: 2,
    retired: true,
    retiredAt: "2026-11-20T09:00:00.000Z",
    version: 4,
    usage: { activeOrderCount: 0, draftCount: 0, publishedVersionCount: 1 },
  },
];

/** DataTable renders a desktop table and mobile cards; scope row queries to the desktop table region. */
const table = () => within(screen.getByRole("region", { name: "Order status catalogue table" }));
const findTable = async () => within(await screen.findByRole("region", { name: "Order status catalogue table" }));

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  session.role = "admin";
  handlers.set("orders.statusCatalog.list", () => structuredClone(BASE_ITEMS));
  handlers.set("orders.statusCatalog.attentionCounts", () => ({ staffReview: 3, customerResponse: 2 }));
});

describe("D2 status catalogue route and workflow header navigation", () => {
  it("registers /admin/workflows/statuses gated to admin with orders.statuses.manage and links from /admin/workflows", async () => {
    const route = ordersFeature.routes.find((candidate) => candidate.path === "/admin/workflows/statuses");
    expect(route).toMatchObject({
      path: "/admin/workflows/statuses",
      access: "admin",
      title: "Order statuses",
      capability: "orders.statuses.manage",
    });

    handlers.set("orders.admin.workflows.list", () => []);
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    const link = await screen.findByRole("link", { name: "Statuses" });
    expect(link).toHaveAttribute("href", "/admin/workflows/statuses");
  });
});

describe("D2 AdminWorkflowStatusesPage", () => {
  it("lists active statuses, toggles retired statuses, and shows explicit non-colour attention and draft usage badges", async () => {
    const user = userEvent.setup();
    renderUi(<AdminWorkflowStatusesPage />, { path: "/admin/workflows/statuses" });

    const t = await findTable();
    expect(await t.findByText("Intake open")).toBeInTheDocument();
    expect(t.getByText("Intake review")).toBeInTheDocument();
    expect(t.getByText("Awaiting customer response")).toBeInTheDocument();
    expect(t.getByText("Awaiting staff review")).toBeInTheDocument();
    expect(t.getByText("In 1 draft")).toBeInTheDocument();
    expect(t.queryByText("Legacy hold")).not.toBeInTheDocument();

    // Draft-referenced status cannot be retired while an open draft references it.
    expect(t.getByRole("button", { name: "Retire Intake review" })).toBeDisabled();
    expect(t.getByRole("button", { name: "Retire Intake open" })).toBeEnabled();

    await user.click(screen.getByRole("switch", { name: "Show retired statuses" }));
    expect(await table().findByText("Legacy hold")).toBeInTheDocument();
    expect(table().getByText("Retired")).toBeInTheDocument();
    expect(table().getByRole("button", { name: "Restore Legacy hold" })).toBeEnabled();
  });

  it("creates a status, enforces the bidirectional cancel category rule, and locks the key when editing", async () => {
    const user = userEvent.setup();
    handlers.set("orders.statusCatalog.create", (input) => ({
      ...(input as Omit<StatusCatalogItem, "publicId" | "position" | "retired" | "retiredAt" | "version">),
      publicId: "01JSTATUS00000000000000099",
      position: 3,
      retired: false,
      retiredAt: null,
      version: 1,
    }));
    handlers.set("orders.statusCatalog.update", (input) => ({
      ...BASE_ITEMS[0]!,
      ...(input as Partial<StatusCatalogItem>),
      version: 2,
    }));

    renderUi(<AdminWorkflowStatusesPage />, { path: "/admin/workflows/statuses" });
    await (await findTable()).findByText("Intake open");

    await user.click(screen.getByRole("button", { name: "Add status" }));
    let dialog = await screen.findByRole("dialog", { name: "Add order status" });
    await expectNoAxeViolations(dialog);

    const staffInput = within(dialog).getByLabelText(/Staff label/);
    const keyInput = within(dialog).getByLabelText(/Status key/);
    const categorySelect = within(dialog).getByLabelText("Category");

    // Non-cancel key with 'canceled' category is blocked before submitting.
    await user.type(staffInput, "Peer QA");
    expect(keyInput).toHaveValue("peer_qa");
    await user.selectOptions(categorySelect, "canceled");
    expect(within(dialog).getByText("A status in the 'Canceled' category must include 'cancel' in its key.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add status" }));
    expect(calls.some((call) => call.path === "orders.statusCatalog.create")).toBe(false);

    // Selecting 'working' and 'staff_review' succeeds.
    await user.selectOptions(categorySelect, "working");
    await user.selectOptions(within(dialog).getByLabelText("Default attention"), "staff_review");
    await user.click(within(dialog).getByRole("button", { name: "Add status" }));

    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.statusCatalog.create")?.input).toEqual({
        key: "peer_qa",
        staffLabel: "Peer QA",
        customerLabel: "Peer QA",
        tone: "info",
        category: "working",
        attention: "staff_review",
      }),
    );

    // Editing an existing status keeps the key immutable and sends expectedVersion.
    await user.click(table().getByRole("button", { name: "Edit Intake open" }));
    dialog = await screen.findByRole("dialog", { name: 'Edit "Intake open"' });
    expect(within(dialog).getByLabelText(/Status key/)).toBeDisabled();
    const editCustomer = within(dialog).getByLabelText(/Customer label/);
    await user.clear(editCustomer);
    await user.type(editCustomer, "Provide your documents");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.statusCatalog.update")?.input).toEqual({
        key: "intake_open",
        expectedVersion: 1,
        staffLabel: "Intake open",
        customerLabel: "Provide your documents",
        tone: "warning",
        category: "waiting",
        attention: "customer_response",
      }),
    );
  });

  it("reorders active statuses with keyboard-accessible buttons and retires/restores entries", async () => {
    const user = userEvent.setup();
    handlers.set("orders.statusCatalog.reorder", () => structuredClone(BASE_ITEMS));
    handlers.set("orders.statusCatalog.retire", () => ({ ...BASE_ITEMS[0]!, retired: true, version: 2 }));
    handlers.set("orders.statusCatalog.restore", () => ({ ...BASE_ITEMS[2]!, retired: false, version: 5 }));

    renderUi(<AdminWorkflowStatusesPage />, { path: "/admin/workflows/statuses" });
    await (await findTable()).findByText("Intake open");

    expect(table().getByRole("button", { name: "Move Intake open up" })).toBeDisabled();
    expect(table().getByRole("button", { name: "Move Intake review down" })).toBeDisabled();

    const moveDown = table().getByRole("button", { name: "Move Intake open down" });
    moveDown.focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.statusCatalog.reorder")?.input).toEqual({
        orderedKeys: ["in_review", "intake_open"],
      }),
    );

    // Retire active status via accessible ConfirmDialog (includes Cancel button).
    await user.click(table().getByRole("button", { name: "Retire Intake open" }));
    const confirmDialog = await screen.findByRole("alertdialog", { name: 'Retire "Intake open"?' });
    expect(within(confirmDialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(within(confirmDialog).getByRole("button", { name: "Retire status" }));

    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.statusCatalog.retire")?.input).toEqual({
        key: "intake_open",
        expectedVersion: 1,
      }),
    );

    // Restore retired status.
    await user.click(screen.getByRole("switch", { name: "Show retired statuses" }));
    await user.click(await table().findByRole("button", { name: "Restore Legacy hold" }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.statusCatalog.restore")?.input).toEqual({
        key: "legacy_hold",
        expectedVersion: 4,
      }),
    );
  });
});

describe("D2 console attention chips and pipeline widget", () => {
  it("renders attention filter chips with counts, honours ?attention= deep links, and gives staff catalogue status labels", async () => {
    const user = userEvent.setup();
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [], nextCursor: null }));

    renderUi(<AdminOrdersPage />, { path: "/admin/orders?attention=customer_response" });

    const customerChip = await screen.findByRole("button", { name: "Awaiting customer response (2)" });
    const staffChip = screen.getByRole("button", { name: "Awaiting staff review (3)" });
    expect(customerChip).toHaveAttribute("aria-pressed", "true");
    expect(staffChip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Status")).toBeInTheDocument();

    await waitFor(() =>
      expect(calls.find((call) => call.path === "orders.admin.list")?.input).toMatchObject({
        attention: "customer_response",
      }),
    );

    await user.click(staffChip);
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "orders.admin.list").at(-1)?.input).toMatchObject({
        attention: "staff_review",
      }),
    );
  });

  it("shows attention counts and deep links on OrdersPipelineWidget with no axe violations", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [], nextCursor: null }));

    const { container } = renderUi(<OrdersPipelineWidget />, { path: "/admin" });

    const staffLink = await screen.findByRole("link", { name: "3 orders awaiting staff review" });
    const customerLink = screen.getByRole("link", { name: "2 orders awaiting customer response" });
    expect(staffLink).toHaveAttribute("href", "/admin/orders?attention=staff_review");
    expect(customerLink).toHaveAttribute("href", "/admin/orders?attention=customer_response");
    expect(staffLink).toHaveClass("inline-flex", "min-h-6", "min-w-6");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });
});

describe("D2 pages — WCAG 2.2 AA axe (light & dark)", () => {
  pageA11y("admin workflow statuses page", async () => {
    document.title = "Order statuses · ReadyPackets";
    renderUi(
      <main>
        <AdminWorkflowStatusesPage />
      </main>,
      { path: "/admin/workflows/statuses" },
    );
    await screen.findByRole("heading", { level: 1, name: "Order statuses" });
    await (await findTable()).findByText("Intake open");
  });

  pageA11y("admin workflow statuses page with Add status dialog", async () => {
    document.title = "Order statuses · ReadyPackets";
    renderUi(
      <main>
        <AdminWorkflowStatusesPage />
      </main>,
      { path: "/admin/workflows/statuses" },
    );
    await (await findTable()).findByText("Intake open");
    await userEvent.click(screen.getByRole("button", { name: "Add status" }));
    await screen.findByRole("dialog", { name: "Add order status" });
  });
});
