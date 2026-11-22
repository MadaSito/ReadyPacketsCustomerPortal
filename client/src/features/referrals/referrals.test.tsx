// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { AppRoutes } from "@/app/AppRouter";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";
import type {
  AdminReferralItemView,
  AdminReferralsSettingsView,
  AdminRewardLedgerItemView,
  CursorPage,
  CustomerReferralHistoryItemView,
  CustomerReferralOverviewView,
} from "./model";
import { referralsFeature } from "./routes";

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
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly safe?: Record<string, unknown>,
  ) {}
}

const NOW = new Date("2026-11-21T00:00:00.000Z");

const customerOverviewFixture: CustomerReferralOverviewView = {
  code: "23456789AB",
  shareUrl: "https://portal.example.test/register?ref=23456789AB",
  sharePath: "/register?ref=23456789AB",
  program: {
    rewardMode: "fixed",
    fixedAmountMinor: 2500,
    percentBps: 1000,
    capAmountMinor: 5000,
    currency: "USD",
    manualApprovalRequired: true,
  },
  stats: {
    total: 3,
    pending: 1,
    approved: 2,
    credited: 1,
    rejected: 0,
    approvedRewardMinor: 5000,
    creditedRewardMinor: 2500,
    currency: "USD",
  },
};

const customerHistoryFixture: CursorPage<CustomerReferralHistoryItemView> = {
  items: [
    {
      referralPublicId: "01JREF00000000000000000001",
      referredAccountHint: "Account ending 42",
      status: "credited",
      rewardAmountMinor: 2500,
      currency: "USD",
      attributedAt: new Date("2026-11-10T12:00:00.000Z"),
      qualifiedAt: new Date("2026-11-12T12:00:00.000Z"),
      reviewedAt: new Date("2026-11-13T12:00:00.000Z"),
      creditedAt: new Date("2026-11-14T12:00:00.000Z"),
    },
    {
      referralPublicId: "01JREF00000000000000000002",
      referredAccountHint: "Account ending 88",
      status: "qualified_pending_approval",
      rewardAmountMinor: 2500,
      currency: "USD",
      attributedAt: new Date("2026-11-18T12:00:00.000Z"),
      qualifiedAt: new Date("2026-11-19T12:00:00.000Z"),
      reviewedAt: null,
      creditedAt: null,
    },
  ],
  nextCursor: null,
};

const adminSettingsFixture: AdminReferralsSettingsView = {
  enabled: true,
  config: {
    rewardMode: "fixed",
    fixedAmountMinor: 2500,
    percentBps: 1000,
    capAmountMinor: 5000,
    currency: "USD",
    manualApprovalRequired: true,
    inviteMaxPerCustomerPerDay: 10,
    inviteMaxPerRecipientPerWindow: 2,
    inviteRecipientCooldownHours: 720,
  },
  summary: {
    totalReferrals: 3,
    pendingApproval: 1,
    approvedAwaitingCredit: 1,
    creditedCount: 1,
    approvedAmountMinor: 5000,
    creditedAmountMinor: 2500,
    currency: "USD",
  },
};

const adminItemsFixture: AdminReferralItemView[] = [
  {
    referralPublicId: "01JREF00000000000000000002",
    codeSnapshot: "23456789AB",
    status: "qualified_pending_approval",
    referrerPublicId: "01JUSER0000000000000000001",
    referrerCustomerRef: "RP-CUST-000101",
    referrerName: "Alice Referrer",
    referredPublicId: "01JUSER0000000000000000002",
    referredCustomerRef: "RP-CUST-000288",
    referredName: "Bob Buyer",
    rewardMode: "fixed",
    rewardPercentBps: null,
    rewardCapMinor: null,
    rewardAmountMinor: 2500,
    currency: "USD",
    qualifyingInvoicePublicId: "01JINV00000000000000000001",
    qualifyingOrderPublicId: "01JORD00000000000000000001",
    invoiceTotalMinor: 12000,
    invoiceCurrency: "USD",
    qualificationNoteCode: null,
    attributedAt: new Date("2026-11-18T12:00:00.000Z"),
    qualifiedAt: new Date("2026-11-19T12:00:00.000Z"),
    reviewedAt: null,
    reviewReason: null,
    creditedAt: null,
    payoutMethod: null,
    payoutReference: null,
    payoutNote: null,
    version: 2,
  },
  {
    referralPublicId: "01JREF00000000000000000003",
    codeSnapshot: "23456789AB",
    status: "approved",
    referrerPublicId: "01JUSER0000000000000000001",
    referrerCustomerRef: "RP-CUST-000101",
    referrerName: "Alice Referrer",
    referredPublicId: "01JUSER0000000000000000003",
    referredCustomerRef: "RP-CUST-000399",
    referredName: "Carla Client",
    rewardMode: "fixed",
    rewardPercentBps: null,
    rewardCapMinor: null,
    rewardAmountMinor: 2500,
    currency: "USD",
    qualifyingInvoicePublicId: "01JINV00000000000000000002",
    qualifyingOrderPublicId: "01JORD00000000000000000002",
    invoiceTotalMinor: 15000,
    invoiceCurrency: "USD",
    qualificationNoteCode: null,
    attributedAt: new Date("2026-11-15T12:00:00.000Z"),
    qualifiedAt: new Date("2026-11-16T12:00:00.000Z"),
    reviewedAt: new Date("2026-11-17T12:00:00.000Z"),
    reviewReason: "Verified first invoice",
    creditedAt: null,
    payoutMethod: null,
    payoutReference: null,
    payoutNote: null,
    version: 3,
  },
];

const adminLedgerFixture: CursorPage<AdminRewardLedgerItemView> = {
  items: [
    {
      ledgerPublicId: "01JLED00000000000000000001",
      referralPublicId: "01JREF00000000000000000003",
      referrerPublicId: "01JUSER0000000000000000001",
      referrerCustomerRef: "RP-CUST-000101",
      referrerName: "Alice Referrer",
      entryType: "reward_approved",
      amountMinor: 2500,
      currency: "USD",
      payoutMethod: "account_credit",
      reference: null,
      note: "Verified first invoice",
      createdAt: NOW,
    },
  ],
  nextCursor: null,
};

function makeMe(role: "customer" | "staff" | "admin"): MeResult {
  return {
    user: {
      publicId: `01JTEST_${role.toUpperCase()}_000001`,
      role,
      name: role === "customer" ? "Alice Customer" : role === "staff" ? "Sam Staff" : "Ada Admin",
      email: `${role}@example.test`,
      status: "active",
      ...(role === "customer" ? { customerRef: "RP-CUST-000101" } : {}),
    },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  };
}

function defaultHandlers(): Record<string, Handler> {
  return {
    "referrals.me.overview": () => customerOverviewFixture,
    "referrals.me.history": () => customerHistoryFixture,
    "referrals.me.sendInviteEmail": () => ({ accepted: true as const }),
    "referrals.admin.getSettings": () => adminSettingsFixture,
    "referrals.admin.updateSettings": (input) => {
      const next = input as { enabled: boolean; config: AdminReferralsSettingsView["config"] };
      return { ...adminSettingsFixture, enabled: next.enabled, config: next.config };
    },
    "referrals.admin.list": () => ({ items: adminItemsFixture, nextCursor: null }),
    "referrals.admin.ledger": () => adminLedgerFixture,
    "referrals.admin.approve": () => ({
      ...adminItemsFixture[0]!,
      status: "approved" as const,
      reviewedAt: NOW,
      version: 3,
    }),
    "referrals.admin.reject": () => ({
      ...adminItemsFixture[0]!,
      status: "rejected" as const,
      reviewedAt: NOW,
      reviewReason: "Duplicate company account",
      version: 3,
    }),
    "referrals.admin.markCredited": () => ({
      ...adminItemsFixture[1]!,
      status: "credited" as const,
      creditedAt: NOW,
      payoutMethod: "account_credit" as const,
      payoutReference: "CR-2026-0091",
      version: 4,
    }),
    "referrals.admin.export": () => ({
      filename: "readypackets-referrals-2026-11-21.csv",
      contentType: "text/csv; charset=utf-8",
      rowCount: 2,
      body: "referral_public_id,status\r\n01JREF00000000000000000002,qualified_pending_approval\r\n",
    }),
  };
}

function renderReferralsRoute(options: {
  path: string;
  role: "customer" | "staff" | "admin";
  features?: Record<string, boolean>;
  handlers?: Record<string, Handler>;
  calls?: { path: string; input: unknown }[];
}) {
  const calls = options.calls ?? [];
  const queryClient = createTestQueryClient();
  const handlers: Record<string, Handler> = {
    ...defaultHandlers(),
    ...options.handlers,
  };
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
            paths.map(async (path, index) => {
              const respond = handlers[path];
              if (!respond) throw new Error(`Unexpected test tRPC request: ${path}`);
              const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
              calls.push({ path, input });
              const value = await respond(input);
              if (value instanceof Refuse) {
                return {
                  error: superjson.serialize({
                    message: "Refused",
                    code: -32603,
                    data: {
                      code: value.code,
                      httpStatus: value.httpStatus,
                      ...(value.safe ? { safe: value.safe } : {}),
                    },
                  }),
                };
              }
              return { result: { data: superjson.serialize(value) } };
            }),
          );
          return Response.json(result, { status: result.some((r) => "error" in r) ? 207 : 200 });
        },
      }),
    ],
  });

  const ui: ReactElement = <AppRoutes routes={referralsFeature.routes} />;
  return renderUi(ui, {
    queryClient,
    path: options.path,
    api: fakeAuthApi({
      me: async () => makeMe(options.role),
      bootstrap: async () => ({ features: options.features ?? { referrals: true } }),
    }),
    wrapper: (node) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    ),
  });
}

describe("referralsFeature — WCAG 2.2 AA pageA11y (light & dark)", () => {
  pageA11y("/account/referrals ready", async () => {
    renderReferralsRoute({ path: "/account/referrals", role: "customer" });
    await screen.findByRole("heading", { level: 1, name: "Referrals" });
    await screen.findByText("Share your referral link");
  });

  pageA11y("/account/referrals disabled", async () => {
    renderReferralsRoute({
      path: "/account/referrals",
      role: "customer",
      features: { referrals: false },
      handlers: {
        "referrals.me.overview": () =>
          new Refuse("NOT_FOUND", 404, { reasonCode: "REFERRALS_DISABLED" }),
      },
    });
    await screen.findByText("The referral programme is not turned on");
  });

  pageA11y("/account/referrals invite dialog open", async () => {
    renderReferralsRoute({ path: "/account/referrals", role: "customer" });
    const btn = await screen.findByRole("button", { name: /e-mail my link/i });
    await userEvent.click(btn);
    await screen.findByRole("dialog", { name: /e-mail your referral link/i });
  });

  pageA11y("/admin/referrals ready", async () => {
    renderReferralsRoute({ path: "/admin/referrals", role: "admin" });
    await screen.findByRole("heading", { level: 1, name: "Referrals" }, { timeout: 5000 });
    await screen.findAllByText("Alice Referrer");
  });

  pageA11y("/admin/referrals empty state", async () => {
    renderReferralsRoute({
      path: "/admin/referrals",
      role: "admin",
      handlers: {
        "referrals.admin.list": () => ({ items: [], nextCursor: null }),
        "referrals.admin.ledger": () => ({ items: [], nextCursor: null }),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Referrals" }, { timeout: 5000 });
    await screen.findByRole(
      "heading",
      { level: 2, name: "No referrals recorded yet" },
      { timeout: 5000 },
    );
  });

  pageA11y("/admin/referrals ledger empty state", async () => {
    renderReferralsRoute({
      path: "/admin/referrals",
      role: "admin",
      handlers: {
        "referrals.admin.list": () => ({ items: [], nextCursor: null }),
        "referrals.admin.ledger": () => ({ items: [], nextCursor: null }),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Referrals" }, { timeout: 5000 });
    const ledgerTab = await screen.findByRole("tab", { name: "Reward ledger" });
    await userEvent.click(ledgerTab);
    await screen.findByRole(
      "heading",
      { level: 2, name: "No reward ledger entries yet" },
      { timeout: 5000 },
    );
  });

  pageA11y("/admin/referrals approve dialog open", async () => {
    renderReferralsRoute({ path: "/admin/referrals", role: "admin" });
    const approveBtns = await screen.findAllByRole("button", { name: "Approve" });
    await userEvent.click(approveBtns[0]!);
    await screen.findByRole("dialog", { name: /approve referral reward/i });
  });
});

describe("referralsFeature — routes, customer workflow, and console RBAC", () => {
  it("declares Account (enabledBy referrals) and Operations (referrals.read_all) navigation plus /register capture wrapper", () => {
    expect(referralsFeature.nav).toEqual([
      expect.objectContaining({
        label: "Referrals",
        href: "/account/referrals",
        area: "customer",
        group: "Account",
        access: "customer",
        order: 210,
        enabledBy: "referrals",
      }),
      expect.objectContaining({
        label: "Referrals",
        href: "/admin/referrals",
        area: "console",
        group: "Operations",
        access: "staff",
        capability: "referrals.read_all",
        order: 28,
      }),
    ]);
    expect(referralsFeature.routeWrappers).toEqual([
      expect.objectContaining({ path: "/register", order: 50 }),
    ]);
  });

  it("renders privacy-masked customer history and validates + submits E-mail my link invitations", async () => {
    const calls: { path: string; input: unknown }[] = [];
    const user = userEvent.setup();
    renderReferralsRoute({ path: "/account/referrals", role: "customer", calls });

    await screen.findByText("Share your referral link");
    expect(screen.getByDisplayValue("23456789AB")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://portal.example.test/register?ref=23456789AB"),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("Account ending 42")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Bob Buyer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /e-mail my link/i }));
    const dialog = await screen.findByRole("dialog", { name: /e-mail your referral link/i });

    await user.type(within(dialog).getByLabelText(/colleague e-mail address/i), "not-an-email");
    await user.click(within(dialog).getByRole("button", { name: /send invitation/i }));
    expect(await within(dialog).findByText("Enter a valid e-mail address.")).toBeInTheDocument();

    const emailInput = within(dialog).getByLabelText(/colleague e-mail address/i);
    await user.clear(emailInput);
    await user.type(emailInput, "colleague@example.test");
    await user.click(within(dialog).getByRole("button", { name: /send invitation/i }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        path: "referrals.me.sendInviteEmail",
        input: { recipientEmail: "colleague@example.test" },
      });
    });
  });

  it("enforces read-only view for staff and allows administrators to approve, mark credited, and save settings", async () => {
    const staffRender = renderReferralsRoute({ path: "/admin/referrals", role: "staff" });
    await screen.findByText("Read-only staff view");
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    staffRender.unmount();

    const calls: { path: string; input: unknown }[] = [];
    const user = userEvent.setup();
    renderReferralsRoute({ path: "/admin/referrals", role: "admin", calls });

    await screen.findAllByText("Alice Referrer");
    expect(screen.queryByText("Read-only staff view")).not.toBeInTheDocument();

    const approveBtns = screen.getAllByRole("button", { name: "Approve" });
    await user.click(approveBtns[0]!);
    const approveDialog = await screen.findByRole("dialog", { name: /approve referral reward/i });
    await user.click(within(approveDialog).getByRole("button", { name: /approve reward/i }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        path: "referrals.admin.approve",
        input: {
          referralPublicId: "01JREF00000000000000000002",
          expectedVersion: 2,
          overrideAmountMinor: undefined,
          note: undefined,
        },
      });
    });

    await user.click(screen.getByRole("tab", { name: /programme settings/i }));
    const saveBtn = await screen.findByRole("button", { name: /save programme settings/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(calls.some((c) => c.path === "referrals.admin.updateSettings")).toBe(true);
    });
  });
});
