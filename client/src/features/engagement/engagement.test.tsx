import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import type { SafeErrorData } from "@server/trpc/trpc";
import { fakeAuthApi, createTestQueryClient, expectNoAxeViolations, renderUi } from "@/ui/testing";
import { dropInfiniteDirectionLink, TRPCProvider } from "@/lib/trpc";
import { GlobalSearchBox, NotificationBellPopover } from "./shell";
import OrderMessagesTab, { OrderMessagesUnreadBadge } from "./OrderMessagesTab";
import CustomerMessagesPage from "./pages/CustomerMessagesPage";
import SupportTicketsPage from "./pages/SupportTicketsPage";
import NewSupportTicketPage from "./pages/NewSupportTicketPage";
import SupportTicketDetailPage from "./pages/SupportTicketDetailPage";
import NotificationsPage from "./pages/NotificationsPage";
import SearchPage from "./pages/SearchPage";
import AdminTicketsPage from "./pages/AdminTicketsPage";
import AdminTicketDetailPage from "./pages/AdminTicketDetailPage";
import AdminMessagesPage from "./pages/AdminMessagesPage";
import CustomerEngagementWidget from "./widgets/CustomerEngagementWidget";
import ConsoleQueueWidget from "./widgets/ConsoleQueueWidget";

const ORDER_ID = "01JENG00000000000000000001";
const TICKET_ID = "01JENG00000000000000000002";
const NOTIF_ID = "01JENG00000000000000000003";
const STAFF_ID = "01JENG00000000000000000004";
const CUSTOMER_ID = "01JENG00000000000000000005";
const FIXED_DATE = new Date("2026-11-20T12:00:00.000Z");

class MockRpcError extends Error {
  readonly safe: SafeErrorData;
  readonly httpStatus: number;
  readonly trpcCode: string;

  constructor(opts: {
    safeMessage: string;
    requestId: string;
    domainCode?: SafeErrorData["domainCode"];
    reasonCode?: string;
    httpStatus?: number;
    trpcCode?: string;
  }) {
    super(opts.safeMessage);
    this.httpStatus = opts.httpStatus ?? 400;
    this.trpcCode = opts.trpcCode ?? "BAD_REQUEST";
    this.safe = {
      domainCode: opts.domainCode ?? "BAD_INPUT",
      reasonCode: opts.reasonCode ?? "INVALID_INPUT",
      safeMessage: opts.safeMessage,
      requestId: opts.requestId,
    };
  }
}

function renderEngagement(
  ui: ReactElement,
  handlers: Record<string, (input: unknown) => unknown>,
  options: { path?: string; role?: "customer" | "staff" | "admin" } = {},
) {
  const queryClient = createTestQueryClient();
  const role = options.role ?? "customer";
  const api = fakeAuthApi({
    me: () =>
      Promise.resolve({
        user: {
          publicId: role === "customer" ? CUSTOMER_ID : STAFF_ID,
          role,
          name: role === "customer" ? "Alice Customer" : "Sam Staff",
          email: "user@example.test",
          status: "active",
        },
        state: "full",
        pendingSteps: [],
        nextStep: null,
      }),
  });

  const client = createTRPCClient<AppRouter>({
    links: [
      dropInfiniteDirectionLink,
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const url = new URL(String(request));
          const rawInput =
            typeof init?.body === "string"
              ? init.body
              : url.searchParams.get("input") ?? "{}";
          const data = JSON.parse(rawInput || "{}") as Record<
            string,
            Parameters<typeof superjson.deserialize>[0]
          >;
          const paths = url.pathname.slice("/rpc/".length).split(",");
          const batch = await Promise.all(
            paths.map(async (procPath, idx) => {
              const handler = handlers[procPath];
              if (!handler) {
                throw new Error(`Unhandled tRPC procedure in test: ${procPath}`);
              }
              const input = data[idx] === undefined ? undefined : superjson.deserialize(data[idx]!);
              try {
                const resolved = await handler(input);
                return { result: { data: superjson.serialize(resolved) } };
              } catch (err) {
                if (err instanceof MockRpcError) {
                  return {
                    error: superjson.serialize({
                      code: -32600,
                      message: err.safe.safeMessage,
                      data: {
                        code: err.trpcCode,
                        httpStatus: err.httpStatus,
                        safe: err.safe,
                      },
                    }),
                  };
                }
                throw err;
              }
            }),
          );
          return Response.json(batch);
        },
      }),
    ],
  });

  return renderUi(ui, {
    api,
    queryClient,
    path: options.path ?? "/",
    wrapper: (children) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });
}

describe("engagement feature UI — accessibility, plain-text XSS inertness, customer & console flows", () => {
  it("renders shell notification bell & global search box, opens drawer, marks read, and passes axe", async () => {
    const user = userEvent.setup();
    const markAllSpy = vi.fn(() => ({ markedCount: 2 }));

    const { container, location } = renderEngagement(
      <div>
        <GlobalSearchBox />
        <NotificationBellPopover area="customer" />
      </div>,
      {
        "engagement.notifications.unreadCount": () => ({ unreadCount: 2 }),
        "engagement.notifications.list": () => ({
          items: [
            {
              publicId: NOTIF_ID,
              kind: "order.message_received",
              category: "message",
              title: "New message on RP-2026-0001",
              body: "A new message is waiting in your order workspace.",
              link: `/orders/${ORDER_ID}/messages`,
              readAt: null,
              createdAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        }),
        "engagement.notifications.markAllRead": markAllSpy,
      },
    );

    const bellButton = await screen.findByRole("button", { name: "Notifications (2 unread)" });
    expect(bellButton).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(bellButton);
    expect(await screen.findByText("New message on RP-2026-0001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Mark all read/i }));
    expect(markAllSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close panel" }));
    const searchInput = screen.getByRole("searchbox", { name: "Global search" });
    await user.type(searchInput, "RP-2026");
    await user.click(screen.getByRole("button", { name: "Run search" }));
    expect(location.history.at(-1)).toBe("/search?q=RP-2026");
  });

  it("renders OrderMessagesTab with XSS payload strictly as inert plain text, sends messages, and passes axe", async () => {
    const user = userEvent.setup();
    const sendSpy = vi.fn((input: unknown) => ({
      publicId: "01JENG00000000000000000099",
      orderPublicId: ORDER_ID,
      orderReference: "RP-2026-0001",
      authorUserPublicId: CUSTOMER_ID,
      authorRole: "customer",
      authorDisplayLabel: "You",
      isOwnMessage: true,
      visibility: "customer",
      body: (input as { body: string }).body,
      attachments: [],
      unread: false,
      readAt: FIXED_DATE,
      readReceiptsCount: 1,
      createdAt: FIXED_DATE,
    }));

    const xssPayload = `<script>window.__xss = true;</script><img src="x" onerror="alert(1)">`;
    const { container } = renderEngagement(
      <div>
        <OrderMessagesUnreadBadge orderId={ORDER_ID} area="customer" />
        <OrderMessagesTab orderId={ORDER_ID} area="customer" />
      </div>,
      {
        "engagement.messages.unreadSummary": () => ({ totalUnread: 1 }),
        "engagement.messages.listByOrder": () => ({
          items: [
            {
              publicId: "01JENG00000000000000000010",
              orderPublicId: ORDER_ID,
              orderReference: "RP-2026-0001",
              authorUserPublicId: STAFF_ID,
              authorRole: "staff",
              authorDisplayLabel: "ReadyPackets Support",
              isOwnMessage: false,
              visibility: "customer",
              body: xssPayload,
              attachments: [
                {
                  filePublicId: "01JENG00000000000000000088",
                  displayName: "checklist.pdf",
                  size: 1024,
                  contentType: "application/pdf",
                  available: true,
                },
              ],
              unread: true,
              readAt: null,
              readReceiptsCount: 0,
              createdAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        }),
        "engagement.messages.send": sendSpy,
      },
    );

    expect(await screen.findByText(xssPayload)).toBeInTheDocument();
    // Prove zero script or img injection occurred in the DOM
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("checklist.pdf")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();

    await expectNoAxeViolations(container);

    await user.type(
      screen.getByRole("textbox", { name: /Message/i }),
      "Confirmed receipt of checklist.",
    );
    await user.click(screen.getByRole("button", { name: /Send message/i }));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        body: "Confirmed receipt of checklist.",
        visibility: "customer",
      }),
    );
  });

  it("renders customer messages, support list/new/detail (with paginated replies), notifications & search cleanly with zero axe violations", async () => {
    const user = userEvent.setup();

    // 1. Customer messages page
    const msgView = renderEngagement(
      <CustomerMessagesPage />,
      {
        "engagement.messages.threads": () => ({
          items: [
            {
              orderPublicId: ORDER_ID,
              orderReference: "RP-2026-0001",
              projectName: "Delaware Formation Packet",
              statusLabel: "In Review",
              locked: false,
              lastMessageAt: FIXED_DATE,
              lastMessagePreview: "Please verify exhibit B.",
              lastAuthorRole: "staff",
              unreadCount: 2,
            },
          ],
          nextCursor: null,
        }),
      },
      { path: "/messages" },
    );
    expect((await screen.findAllByText("RP-2026-0001")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(msgView.container);
    msgView.unmount();

    // 2. Support tickets list + New ticket creation
    const createSpy = vi.fn(() => ({
      ticket: {
        publicId: TICKET_ID,
        ticketNumber: "TKT-20261120-ABCD23",
        subject: "Exhibit B formatting question",
        category: "order",
        status: "open",
        priority: "normal",
        relatedOrderPublicId: ORDER_ID,
        relatedOrderReference: "RP-2026-0001",
        requesterUserPublicId: CUSTOMER_ID,
        assigneeUserPublicId: null,
        lastMessageAt: FIXED_DATE,
        resolvedAt: null,
        closedAt: null,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      },
      replies: [],
      repliesNextCursor: null,
      statusHistory: [],
      statusHistoryHasMore: false,
      canReply: true,
      canReopen: false,
      canClose: true,
    }));

    const newTicketView = renderEngagement(
      <NewSupportTicketPage />,
      { "engagement.tickets.create": createSpy },
      { path: "/support/new" },
    );
    await expectNoAxeViolations(newTicketView.container);
    await user.type(screen.getByLabelText(/Subject/i), "Exhibit B formatting question");
    await user.type(
      screen.getByLabelText(/Details/i),
      "Should exhibit B include notarized cover pages?",
    );
    await user.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(createSpy).toHaveBeenCalledTimes(1);
    newTicketView.unmount();

    // 3. Support ticket detail page with paginated replies LoadMore
    const getSpy = vi.fn((input: unknown) => {
      const { replyCursor } = (input ?? {}) as { replyCursor?: string };
      return {
        ticket: {
          publicId: TICKET_ID,
          ticketNumber: "TKT-20261120-ABCD23",
          subject: "Exhibit B formatting question",
          category: "order",
          status: "pending_customer",
          priority: "normal",
          relatedOrderPublicId: ORDER_ID,
          relatedOrderReference: "RP-2026-0001",
          requesterUserPublicId: CUSTOMER_ID,
          assigneeUserPublicId: null,
          lastMessageAt: FIXED_DATE,
          resolvedAt: null,
          closedAt: null,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
        replies: replyCursor
          ? [
              {
                publicId: "01JENG00000000000000000021",
                authorUserPublicId: STAFF_ID,
                authorRole: "staff",
                authorDisplayLabel: "Support team",
                isOwnMessage: false,
                internalOnly: false,
                body: "Second page reply from support.",
                createdAt: FIXED_DATE,
              },
            ]
          : [
              {
                publicId: "01JENG00000000000000000020",
                authorUserPublicId: CUSTOMER_ID,
                authorRole: "customer",
                authorDisplayLabel: "You",
                isOwnMessage: true,
                internalOnly: false,
                body: "First page initial question.",
                createdAt: FIXED_DATE,
              },
            ],
        repliesNextCursor: replyCursor ? null : "cursor_page_2",
        statusHistory: [
          {
            publicId: "01JENG00000000000000000030",
            fromStatus: null,
            toStatus: "open",
            actorRole: "customer",
            reasonCode: "TICKET_CREATED",
            occurredAt: FIXED_DATE,
          },
        ],
        statusHistoryHasMore: false,
        canReply: true,
        canReopen: false,
        canClose: true,
      };
    });

    const detailView = renderEngagement(
      <Route path="/support/:ticketId">
        <SupportTicketDetailPage />
      </Route>,
      { "engagement.tickets.get": getSpy },
      { path: `/support/${TICKET_ID}` },
    );
    expect(await screen.findByText("First page initial question.")).toBeInTheDocument();
    await expectNoAxeViolations(detailView.container);
    await user.click(screen.getByRole("button", { name: /Load more/i }));
    expect(await screen.findByText("Second page reply from support.")).toBeInTheDocument();
    detailView.unmount();

    // 4. Notifications & preferences page (security in-app switch locked)
    const notifView = renderEngagement(
      <NotificationsPage />,
      {
        "engagement.notifications.unreadCount": () => ({ unreadCount: 1 }),
        "engagement.notifications.list": () => ({
          items: [
            {
              publicId: NOTIF_ID,
              kind: "ticket.replied",
              category: "ticket",
              title: "Update on TKT-20261120-ABCD23",
              body: "Support replied to your ticket.",
              link: `/support/${TICKET_ID}`,
              readAt: null,
              createdAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        }),
        "engagement.notifications.preferences.get": () => ({
          items: [
            { category: "security", inApp: true, email: true, inAppLocked: true },
            { category: "message", inApp: true, email: false, inAppLocked: false },
          ],
        }),
      },
      { path: "/notifications" },
    );
    expect(await screen.findByText("Update on TKT-20261120-ABCD23")).toBeInTheDocument();
    await expectNoAxeViolations(notifView.container);
    await user.click(screen.getByRole("tab", { name: /Preferences/i }));
    const secInApp = await screen.findByRole("switch", {
      name: "In-app (Security & sign-in alerts)",
    });
    expect(secInApp).toBeDisabled();
    notifView.unmount();

    // 5. Bounded search page + Support list page
    const searchView = renderEngagement(
      <SearchPage />,
      {
        "engagement.search.query": () => ({
          orders: [
            {
              publicId: ORDER_ID,
              reference: "RP-2026-0001",
              projectName: "Delaware Formation Packet",
              statusLabel: "In Review",
              updatedAt: FIXED_DATE,
            },
          ],
          tickets: [],
          messages: [],
          customers: [],
          meta: { globalScope: false, timedOut: false, durationMs: 12 },
        }),
      },
      { path: "/search?q=RP-2026" },
    );
    expect(await screen.findByText(/RP-2026-0001 — Delaware Formation Packet/)).toBeInTheDocument();
    await expectNoAxeViolations(searchView.container);
    searchView.unmount();

    const listView = renderEngagement(
      <SupportTicketsPage />,
      { "engagement.tickets.list": () => ({ items: [], nextCursor: null }) },
      { path: "/support" },
    );
    expect(await screen.findByText("No support tickets yet")).toBeInTheDocument();
    await expectNoAxeViolations(listView.container);
    listView.unmount();
  });

  it("renders console queue, staff ticket detail (internal notes & triage), staff message inbox, and dashboard widgets with zero axe violations", async () => {
    const user = userEvent.setup();
    const adminReplySpy = vi.fn(() => ({
      ticket: {
        publicId: TICKET_ID,
        ticketNumber: "TKT-20261120-ABCD23",
        subject: "Urgent filing deadline",
        category: "order",
        status: "open",
        priority: "high",
        relatedOrderPublicId: ORDER_ID,
        relatedOrderReference: "RP-2026-0001",
        requesterUserPublicId: CUSTOMER_ID,
        assigneeUserPublicId: STAFF_ID,
        lastMessageAt: FIXED_DATE,
        resolvedAt: null,
        closedAt: null,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      },
      replies: [],
      repliesNextCursor: null,
      statusHistory: [],
      statusHistoryHasMore: false,
      canReply: true,
      canReopen: false,
      canClose: true,
    }));

    const queueView = renderEngagement(
      <AdminTicketsPage />,
      {
        "engagement.tickets.admin.queueSummary": () => ({
          openCount: 3,
          unassignedCount: 1,
          assignedToMeCount: 2,
        }),
        "engagement.tickets.admin.list": () => ({
          items: [
            {
              publicId: TICKET_ID,
              ticketNumber: "TKT-20261120-ABCD23",
              subject: "Urgent filing deadline",
              category: "order",
              status: "open",
              priority: "high",
              relatedOrderPublicId: ORDER_ID,
              relatedOrderReference: "RP-2026-0001",
              requesterUserPublicId: CUSTOMER_ID,
              assigneeUserPublicId: null,
              lastMessageAt: FIXED_DATE,
              resolvedAt: null,
              closedAt: null,
              createdAt: FIXED_DATE,
              updatedAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        }),
      },
      { path: "/admin/tickets", role: "staff" },
    );
    expect(
      (await screen.findAllByText(/TKT-20261120-ABCD23 — Urgent filing deadline/)).length,
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(queueView.container);
    queueView.unmount();

    const adminDetail = renderEngagement(
      <Route path="/admin/tickets/:ticketId">
        <AdminTicketDetailPage />
      </Route>,
      {
        "engagement.tickets.admin.get": () => ({
          ticket: {
            publicId: TICKET_ID,
            ticketNumber: "TKT-20261120-ABCD23",
            subject: "Urgent filing deadline",
            category: "order",
            status: "open",
            priority: "high",
            relatedOrderPublicId: ORDER_ID,
            relatedOrderReference: "RP-2026-0001",
            requesterUserPublicId: CUSTOMER_ID,
            assigneeUserPublicId: null,
            lastMessageAt: FIXED_DATE,
            resolvedAt: null,
            closedAt: null,
            createdAt: FIXED_DATE,
            updatedAt: FIXED_DATE,
          },
          replies: [
            {
              publicId: "01JENG00000000000000000040",
              authorUserPublicId: STAFF_ID,
              authorRole: "staff",
              authorDisplayLabel: "Sam Staff",
              isOwnMessage: true,
              internalOnly: true,
              body: "INTERNAL: verified Delaware secretary of state queue.",
              createdAt: FIXED_DATE,
            },
          ],
          repliesNextCursor: null,
          statusHistory: [],
          statusHistoryHasMore: false,
          canReply: true,
          canReopen: false,
          canClose: true,
        }),
        "engagement.tickets.admin.reply": adminReplySpy,
      },
      { path: `/admin/tickets/${TICKET_ID}`, role: "staff" },
    );
    expect(
      await screen.findByText("INTERNAL: verified Delaware secretary of state queue."),
    ).toBeInTheDocument();
    await expectNoAxeViolations(adminDetail.container);

    await user.click(screen.getByRole("radio", { name: /Internal staff note/i }));
    await user.type(screen.getByLabelText(/Internal note/i), "Second internal note.");
    await user.click(screen.getByRole("button", { name: /Save internal note/i }));
    expect(adminReplySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        body: "Second internal note.",
        internalOnly: true,
      }),
    );
    adminDetail.unmount();

    const adminInbox = renderEngagement(
      <AdminMessagesPage />,
      {
        "engagement.messages.adminInbox": () => ({
          items: [
            {
              publicId: "01JENG00000000000000000050",
              orderPublicId: ORDER_ID,
              orderReference: "RP-2026-0001",
              authorUserPublicId: CUSTOMER_ID,
              authorRole: "customer",
              authorDisplayLabel: "Alice Customer",
              isOwnMessage: false,
              visibility: "customer",
              body: "Uploaded notarized exhibit.",
              attachments: [],
              unread: true,
              readAt: null,
              readReceiptsCount: 0,
              createdAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        }),
      },
      { path: "/admin/messages", role: "staff" },
    );
    expect((await screen.findAllByText("Uploaded notarized exhibit.")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(adminInbox.container);
    adminInbox.unmount();

    const widgetsView = renderEngagement(
      <div>
        <CustomerEngagementWidget />
        <ConsoleQueueWidget />
      </div>,
      {
        "engagement.messages.unreadSummary": () => ({ totalUnread: 3 }),
        "engagement.tickets.openSummary": () => ({ openCount: 2, awaitingCustomerCount: 1 }),
        "engagement.tickets.admin.queueSummary": () => ({
          openCount: 4,
          unassignedCount: 1,
          assignedToMeCount: 2,
        }),
        "engagement.messages.adminInbox": () => ({ items: [], nextCursor: null }),
      },
      { role: "staff" },
    );
    expect(await screen.findByText("3 unread")).toBeInTheDocument();
    expect(await screen.findByText("4 active in queue")).toBeInTheDocument();
    await expectNoAxeViolations(widgetsView.container);
    widgetsView.unmount();
  });

  it("renders ErrorState (safeMessage, requestId, retry) on query failure and never renders EmptyState until a successful empty result on SupportTicketsPage, CustomerMessagesPage, NotificationsPage, and AdminTicketsPage", async () => {
    const user = userEvent.setup();

    // 1. SupportTicketsPage: pending -> error (no empty state!) -> retry -> empty state
    let resolveTicketsGate!: () => void;
    const ticketsGate = new Promise<void>((res) => {
      resolveTicketsGate = res;
    });
    let ticketsAttempt = 0;
    const ticketsHandler = vi.fn(async () => {
      ticketsAttempt += 1;
      if (ticketsAttempt === 1) {
        await ticketsGate;
        throw new MockRpcError({
          safeMessage: "Some of the information provided is not valid.",
          requestId: "req_tickets_400",
        });
      }
      return { items: [], nextCursor: null };
    });

    const supportView = renderEngagement(
      <SupportTicketsPage />,
      { "engagement.tickets.list": ticketsHandler },
      { path: "/support" },
    );
    // While pending, false empty state must NOT appear
    expect(screen.queryByText("No support tickets yet")).not.toBeInTheDocument();

    resolveTicketsGate();
    expect(
      await screen.findByText("Some of the information provided is not valid."),
    ).toBeInTheDocument();
    expect(screen.getByText("req_tickets_400")).toBeInTheDocument();
    expect(screen.queryByText("No support tickets yet")).not.toBeInTheDocument();
    await expectNoAxeViolations(supportView.container);

    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(await screen.findByText("No support tickets yet")).toBeInTheDocument();
    expect(
      screen.queryByText("Some of the information provided is not valid."),
    ).not.toBeInTheDocument();
    expect(ticketsHandler).toHaveBeenCalledTimes(2);
    supportView.unmount();

    // 2. CustomerMessagesPage: pending -> error (no empty state!) -> retry -> empty state
    let resolveMessagesGate!: () => void;
    const messagesGate = new Promise<void>((res) => {
      resolveMessagesGate = res;
    });
    let messagesAttempt = 0;
    const messagesHandler = vi.fn(async () => {
      messagesAttempt += 1;
      if (messagesAttempt === 1) {
        await messagesGate;
        throw new MockRpcError({
          safeMessage: "Unable to load order conversations right now.",
          requestId: "req_messages_503",
          domainCode: "UNAVAILABLE",
          httpStatus: 503,
          trpcCode: "SERVICE_UNAVAILABLE",
        });
      }
      return { items: [], nextCursor: null };
    });

    const messagesView = renderEngagement(
      <CustomerMessagesPage />,
      { "engagement.messages.threads": messagesHandler },
      { path: "/messages" },
    );
    expect(screen.queryByText("No order conversations yet")).not.toBeInTheDocument();

    resolveMessagesGate();
    expect(
      await screen.findByText("Unable to load order conversations right now."),
    ).toBeInTheDocument();
    expect(screen.getByText("req_messages_503")).toBeInTheDocument();
    expect(screen.queryByText("No order conversations yet")).not.toBeInTheDocument();
    await expectNoAxeViolations(messagesView.container);

    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(await screen.findByText("No order conversations yet")).toBeInTheDocument();
    expect(messagesHandler).toHaveBeenCalledTimes(2);
    messagesView.unmount();

    // 3. NotificationsPage: pending -> error (no empty state!) -> retry -> empty state
    let resolveNotifsGate!: () => void;
    const notifsGate = new Promise<void>((res) => {
      resolveNotifsGate = res;
    });
    let notifsAttempt = 0;
    const notifsHandler = vi.fn(async () => {
      notifsAttempt += 1;
      if (notifsAttempt === 1) {
        await notifsGate;
        throw new MockRpcError({
          safeMessage: "Notifications feed is temporarily unavailable.",
          requestId: "req_notifs_503",
          domainCode: "UNAVAILABLE",
          httpStatus: 503,
          trpcCode: "SERVICE_UNAVAILABLE",
        });
      }
      return { items: [], nextCursor: null };
    });

    const notifsView = renderEngagement(
      <NotificationsPage />,
      {
        "engagement.notifications.list": notifsHandler,
        "engagement.notifications.unreadCount": () => ({ unreadCount: 0 }),
        "engagement.notifications.preferences.get": () => ({ items: [] }),
      },
      { path: "/notifications" },
    );
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();

    resolveNotifsGate();
    expect(
      await screen.findByText("Notifications feed is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("req_notifs_503")).toBeInTheDocument();
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
    await expectNoAxeViolations(notifsView.container);

    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(notifsHandler).toHaveBeenCalledTimes(2);
    notifsView.unmount();

    // 4. AdminTicketsPage: pending -> error (no empty state!) -> retry -> empty state
    let resolveAdminGate!: () => void;
    const adminGate = new Promise<void>((res) => {
      resolveAdminGate = res;
    });
    let adminAttempt = 0;
    const adminListHandler = vi.fn(async () => {
      adminAttempt += 1;
      if (adminAttempt === 1) {
        await adminGate;
        throw new MockRpcError({
          safeMessage: "Support queue query failed.",
          requestId: "req_admin_queue_500",
          domainCode: "INTERNAL",
          httpStatus: 500,
          trpcCode: "INTERNAL_SERVER_ERROR",
        });
      }
      return { items: [], nextCursor: null };
    });

    const adminView = renderEngagement(
      <AdminTicketsPage />,
      {
        "engagement.tickets.admin.queueSummary": () => ({
          openCount: 0,
          unassignedCount: 0,
          assignedToMeCount: 0,
        }),
        "engagement.tickets.admin.list": adminListHandler,
      },
      { path: "/admin/tickets", role: "staff" },
    );
    expect(screen.queryByText("No tickets match the current filters")).not.toBeInTheDocument();

    resolveAdminGate();
    expect(await screen.findByText("Support queue query failed.")).toBeInTheDocument();
    expect(screen.getByText("req_admin_queue_500")).toBeInTheDocument();
    expect(screen.queryByText("No tickets match the current filters")).not.toBeInTheDocument();
    await expectNoAxeViolations(adminView.container);

    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(await screen.findByText("No tickets match the current filters")).toBeInTheDocument();
    expect(adminListHandler).toHaveBeenCalledTimes(2);
    adminView.unmount();

    // 5. Detail page & Widget error states + retry
    let detailAttempt = 0;
    const detailView = renderEngagement(
      <Route path="/support/:ticketId">
        <SupportTicketDetailPage />
      </Route>,
      {
        "engagement.tickets.get": () => {
          detailAttempt += 1;
          throw new MockRpcError({
            safeMessage: "Ticket could not be loaded.",
            requestId: "req_detail_500",
          });
        },
      },
      { path: `/support/${TICKET_ID}` },
    );
    expect(await screen.findByText("Ticket could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("req_detail_500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Try again/i }));
    expect(detailAttempt).toBe(2);
    detailView.unmount();

    const widgetErrorView = renderEngagement(
      <CustomerEngagementWidget />,
      {
        "engagement.messages.unreadSummary": () => {
          throw new MockRpcError({
            safeMessage: "Dashboard summary unavailable.",
            requestId: "req_widget_503",
          });
        },
        "engagement.tickets.openSummary": () => ({ openCount: 0, awaitingCustomerCount: 0 }),
      },
    );
    expect(await screen.findByText("Dashboard summary unavailable.")).toBeInTheDocument();
    expect(screen.getByText("req_widget_503")).toBeInTheDocument();
    expect(screen.queryByText("0 unread")).not.toBeInTheDocument();
    widgetErrorView.unmount();
  });
});
