import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type { UserRole } from "@shared/domain";
import { RouteFocus } from "@/app/RouteFocus";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { PageHeader } from "@/ui";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";
import type { AppRouter } from "@server/trpc/root";
import {
  OrderFileSyncTab,
  OrderFileSyncTabLabel,
  type OrderFileSyncItem,
  type OrderFileSyncPage,
} from "./OrderFileSyncTab";
import { storageFeature } from "./routes";

const orderId = "01JD0000000000000000000010";
const pagePath = `/admin/orders/${orderId}/sync`;
const spConnId = "01JD0000000000000000000021";
const s3ConnId = "01JD0000000000000000000022";
const verifiedTransferId = "01JD0000000000000000000031";
const copyingTransferId = "01JD0000000000000000000032";
const retryableFailedId = "01JD0000000000000000000033";
const missingSourceFailedId = "01JD0000000000000000000034";
const cursorPageTwo = "01JD0000000000000000000088";
const fixedTime = new Date("2026-11-21T15:30:00.000Z");

const sampleItems: OrderFileSyncItem[] = [
  {
    publicId: verifiedTransferId,
    filePublicId: "01JD0000000000000000000041",
    fileName: "intake-summary.pdf",
    phase: "Intake review",
    state: "verified",
    connectionPublicId: spConnId,
    connectionName: "Operations SharePoint Library",
    provider: "sharepoint",
    targetPath:
      "customers/CUST-1042/orders/ORD-2026-0091/phase-01-intake/intake-summary-very-long-archived-document-name.pdf",
    updatedAt: fixedTime,
    canRetry: false,
  },
  {
    publicId: copyingTransferId,
    filePublicId: "01JD0000000000000000000042",
    fileName: "walkthrough-recording.m4a",
    phase: "Consultation",
    state: "copying",
    connectionPublicId: spConnId,
    connectionName: "Operations SharePoint Library",
    provider: "sharepoint",
    targetPath: "customers/CUST-1042/orders/ORD-2026-0091/phase-02-consultation/walkthrough-recording.m4a",
    updatedAt: fixedTime,
    canRetry: false,
  },
  {
    publicId: retryableFailedId,
    filePublicId: "01JD0000000000000000000043",
    fileName: "signed-schedule.pdf",
    phase: "Final packet",
    state: "failed",
    connectionPublicId: spConnId,
    connectionName: "Operations SharePoint Library",
    provider: "sharepoint",
    targetPath: "customers/CUST-1042/orders/ORD-2026-0091/phase-03-final/signed-schedule.pdf",
    updatedAt: fixedTime,
    canRetry: true,
  },
  {
    publicId: missingSourceFailedId,
    filePublicId: "01JD0000000000000000000044",
    fileName: "purged-upload.bin",
    phase: "Intake review",
    state: "failed",
    connectionPublicId: s3ConnId,
    connectionName: "Offsite Archive Bucket",
    provider: "s3",
    targetPath: null,
    updatedAt: fixedTime,
    canRetry: false,
  },
];

function defaultPage(overrides: Partial<OrderFileSyncPage> = {}): OrderFileSyncPage {
  return {
    items: sampleItems,
    nextCursor: null,
    totals: {
      total: 4,
      synced: 1,
      inProgress: 1,
      failed: 2,
    },
    hasSharePoint: true,
    hasAssignedConnection: true,
    ...overrides,
  };
}

interface RenderSyncOptions {
  role?: UserRole;
  area?: "customer" | "console";
  includeLabel?: boolean;
  onForOrder?: (input: { orderPublicId: string; cursor?: string; limit?: number }) => OrderFileSyncPage;
  onRetry?: (input: { orderPublicId: string; publicId: string }) => { queued: boolean };
}

function renderOrderSync({
  role = "admin",
  area = "console",
  includeLabel = false,
  onForOrder = () => defaultPage(),
  onRetry = () => ({ queued: true }),
}: RenderSyncOptions = {}) {
  const queryClient = createTestQueryClient();
  const requests: Array<{ route: string; input: unknown }> = [];
  const api = fakeAuthApi({
    me: async () => ({
      state: "full",
      user: {
        publicId: "01JD0000000000000000000001",
        role,
        name: role === "admin" ? "Portal Admin" : role === "staff" ? "Order Specialist" : "Portal Customer",
        email: `${role}@example.test`,
        status: "active",
      },
      pendingSteps: [],
      nextStep: null,
    }),
  });

  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const rawUrl =
            typeof request === "string"
              ? request
              : request instanceof URL
                ? request.toString()
                : request.url;
          const url = new URL(rawUrl);
          const rawInput =
            typeof init?.body === "string" ? init.body : (url.searchParams.get("input") ?? "{}");
          const batch = JSON.parse(rawInput) as Record<
            string,
            Parameters<typeof superjson.deserialize>[0]
          >;
          const routes = url.pathname.slice("/rpc/".length).split(",");
          return Response.json(
            routes.map((route, index) => {
              const envelope = batch[String(index)];
              const input = envelope ? superjson.deserialize(envelope) : null;
              requests.push({ route, input });
              if (route === "storage.copies.forOrder") {
                const page = onForOrder(
                  input as { orderPublicId: string; cursor?: string; limit?: number },
                );
                return { result: { data: superjson.serialize(page) } };
              }
              if (route === "storage.copies.retryOrderFile") {
                const outcome = onRetry(input as { orderPublicId: string; publicId: string });
                return { result: { data: superjson.serialize(outcome) } };
              }
              throw new Error(`Unexpected synthetic tRPC request: ${route}`);
            }),
          );
        },
      }),
    ],
  });

  const rendered = renderUi(
    <main>
      <RouteFocus title="Order ORD-2026-0091" path={pagePath} />
      <PageHeader title="Synthetic Governance Rollout" description="Order ORD-2026-0091" />
      {includeLabel ? (
        <div data-testid="sync-tab-label">
          <OrderFileSyncTabLabel orderId={orderId} area={area} />
        </div>
      ) : null}
      <OrderFileSyncTab orderId={orderId} area={area} />
    </main>,
    {
      api,
      path: pagePath,
      queryClient,
      wrapper: (tree) => (
        <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
          {tree}
        </TRPCProvider>
      ),
    },
  );

  return { ...rendered, requests };
}

pageA11y(`${pagePath} (populated transfers)`, async () => {
  renderOrderSync({ role: "admin", includeLabel: true });
  await screen.findByRole("heading", { level: 2, name: "SharePoint sync" });
  await screen.findByRole("table", { name: "Order file transfers" });
});

pageA11y(`${pagePath} (no storage connection assigned)`, async () => {
  renderOrderSync({
    role: "admin",
    onForOrder: () =>
      defaultPage({
        items: [],
        totals: { total: 0, synced: 0, inProgress: 0, failed: 0 },
        hasSharePoint: false,
        hasAssignedConnection: false,
      }),
  });
  await screen.findByRole("heading", { level: 3, name: "No storage connection is assigned" });
});

describe("OrderFileSyncTab (Package W client / Decision B7)", () => {
  it("registers orderTabs slot 60 (key 'sync', access 'staff') with dynamic labelComponent", () => {
    const syncTab = storageFeature.orderTabs?.find((tab) => tab.key === "sync");
    expect(syncTab).toBeDefined();
    expect(syncTab).toMatchObject({
      key: "sync",
      label: "File sync",
      access: "staff",
      order: 60,
      labelComponent: OrderFileSyncTabLabel,
      component: OrderFileSyncTab,
    });
  });

  it("never renders or queries storage.copies.forOrder for customer area or customer sessions", async () => {
    const customerArea = renderOrderSync({ role: "admin", area: "customer", includeLabel: true });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { level: 2, name: /sync/i })).toBeNull();
    });
    expect(screen.getByTestId("sync-tab-label")).toBeEmptyDOMElement();
    expect(customerArea.requests).toHaveLength(0);
    customerArea.unmount();

    const customerRole = renderOrderSync({ role: "customer", area: "console", includeLabel: true });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { level: 2, name: /sync/i })).toBeNull();
    });
    expect(screen.getByTestId("sync-tab-label")).toBeEmptyDOMElement();
    expect(customerRole.requests).toHaveLength(0);
  });

  it("renders 'SharePoint sync (n)' when SharePoint/OneDrive is assigned and 'File sync (n)' otherwise", async () => {
    const spRender = renderOrderSync({ role: "staff", includeLabel: true });
    await waitFor(() => {
      expect(screen.getByTestId("sync-tab-label")).toHaveTextContent("SharePoint sync (4)");
    });
    expect(screen.getByRole("heading", { level: 2, name: "SharePoint sync" })).toBeInTheDocument();
    // Shared query key means label + tab body reuse one initial fetch.
    expect(spRender.requests.filter((r) => r.route === "storage.copies.forOrder")).toHaveLength(1);
    spRender.unmount();

    renderOrderSync({
      role: "staff",
      includeLabel: true,
      onForOrder: () =>
        defaultPage({
          items: [sampleItems[3]!],
          totals: { total: 1, synced: 0, inProgress: 0, failed: 1 },
          hasSharePoint: false,
          hasAssignedConnection: true,
        }),
    });
    await waitFor(() => {
      expect(screen.getByTestId("sync-tab-label")).toHaveTextContent("File sync (1)");
    });
    expect(screen.getByRole("heading", { level: 2, name: "File sync" })).toBeInTheDocument();
  });

  it("renders totals, desktop transfer table (>= 640 px), stacked cards (< 640 px), status text badges, and wrapping monospace targetPath", async () => {
    renderOrderSync({ role: "admin" });

    const totalsRegion = await screen.findByRole("region", { name: "SharePoint sync totals" });
    expect(within(totalsRegion).getByText("Total")).toBeInTheDocument();
    expect(within(totalsRegion).getByText("4")).toBeInTheDocument();
    expect(within(totalsRegion).getByText("Synced")).toBeInTheDocument();
    expect(within(totalsRegion).getByText("In progress")).toBeInTheDocument();
    expect(within(totalsRegion).getByText("Failed")).toBeInTheDocument();
    expect(within(totalsRegion).getByText("2")).toBeInTheDocument();

    // >= 640 px table (`sm:block`)
    const tableScrollRegion = screen.getByRole("region", { name: "Order file transfers table" });
    expect(tableScrollRegion.className).toContain("hidden");
    expect(tableScrollRegion.className).toContain("sm:block");
    const table = within(tableScrollRegion).getByRole("table", { name: "Order file transfers" });
    expect(within(table).getByText("intake-summary.pdf")).toBeInTheDocument();
    expect(within(table).getByText("Verified")).toBeInTheDocument();
    expect(within(table).getByText("Copying")).toBeInTheDocument();
    expect(within(table).getAllByText("Failed")).toHaveLength(2);

    const pathCode = within(table).getByText(
      "customers/CUST-1042/orders/ORD-2026-0091/phase-01-intake/intake-summary-very-long-archived-document-name.pdf",
    );
    expect(pathCode.tagName).toBe("CODE");
    expect(pathCode.className).toContain("font-mono");
    expect(pathCode.className).toContain("break-all");
    expect(pathCode.className).toContain("whitespace-normal");

    // < 640 px stacked cards (`sm:hidden`)
    const cardList = screen.getByRole("list", { name: "Order file transfers" });
    expect(cardList.className).toContain("sm:hidden");
    const cards = within(cardList).getAllByRole("listitem");
    expect(cards).toHaveLength(4);
    expect(within(cards[0]!).getByText("Target path")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Verified")).toBeInTheDocument();
  });

  it("offers Retry only for failed transfers whose local source exists and queues retry without step-up", async () => {
    const user = userEvent.setup();
    const { requests } = renderOrderSync({ role: "staff" });

    const table = await screen.findByRole("table", { name: "Order file transfers" });
    const retryButtons = within(table).getAllByRole("button", { name: /retry sync for/i });
    expect(retryButtons).toHaveLength(1);
    expect(retryButtons[0]).toHaveAccessibleName("Retry sync for signed-schedule.pdf");
    expect(within(table).getByText("Source unavailable")).toBeInTheDocument();

    await user.click(retryButtons[0]!);

    await waitFor(() => {
      expect(requests).toContainEqual({
        route: "storage.copies.retryOrderFile",
        input: { orderPublicId: orderId, publicId: retryableFailedId },
      });
    });
    expect(await screen.findByText("Retry queued for signed-schedule.pdf.")).toBeInTheDocument();
  });

  it("scopes 'Open Copy log' and '/admin/storage' links to admin capabilities and hides them from staff", async () => {
    const adminView = renderOrderSync({
      role: "admin",
      onForOrder: () =>
        defaultPage({
          items: [],
          totals: { total: 0, synced: 0, inProgress: 0, failed: 0 },
          hasSharePoint: false,
          hasAssignedConnection: false,
        }),
    });

    await screen.findByRole("heading", { level: 3, name: "No storage connection is assigned" });
    const copyLogLink = screen.getByRole("link", { name: "Open Copy log" });
    expect(copyLogLink).toHaveAttribute(
      "href",
      `/admin/storage/copies?orderPublicId=${encodeURIComponent(orderId)}`,
    );
    const storageAdminLink = screen.getByRole("link", { name: "Configure storage connections" });
    expect(storageAdminLink).toHaveAttribute("href", "/admin/storage");
    adminView.unmount();

    renderOrderSync({
      role: "staff",
      onForOrder: () =>
        defaultPage({
          items: [],
          totals: { total: 0, synced: 0, inProgress: 0, failed: 0 },
          hasSharePoint: false,
          hasAssignedConnection: false,
        }),
    });
    await screen.findByRole("heading", { level: 3, name: "No storage connection is assigned" });
    expect(screen.queryByRole("link", { name: "Open Copy log" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Configure storage connections" })).toBeNull();
  });

  it("loads additional cursor pages when nextCursor is returned", async () => {
    const user = userEvent.setup();
    const pageTwoItem: OrderFileSyncItem = {
      publicId: "01JD0000000000000000000099",
      filePublicId: "01JD0000000000000000000098",
      fileName: "second-page-addendum.pdf",
      phase: "Archive",
      state: "written",
      connectionPublicId: spConnId,
      connectionName: "Operations SharePoint Library",
      provider: "sharepoint",
      targetPath: "customers/CUST-1042/orders/ORD-2026-0091/archive/second-page-addendum.pdf",
      updatedAt: fixedTime,
      canRetry: false,
    };

    const { requests } = renderOrderSync({
      role: "admin",
      onForOrder: (input) =>
        input.cursor === cursorPageTwo
          ? defaultPage({ items: [pageTwoItem], nextCursor: null })
          : defaultPage({ items: [sampleItems[0]!], nextCursor: cursorPageTwo }),
    });

    const table = await screen.findByRole("table", { name: "Order file transfers" });
    expect(within(table).queryByText("second-page-addendum.pdf")).toBeNull();

    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await within(table).findByText("second-page-addendum.pdf")).toBeInTheDocument();
    expect(requests).toContainEqual({
      route: "storage.copies.forOrder",
      input: expect.objectContaining({ orderPublicId: orderId, cursor: cursorPageTwo }),
    });
  });
});
