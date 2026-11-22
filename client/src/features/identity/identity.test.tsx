import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import AccountPage from "./pages/AccountPage";
import CustomerDetailPage from "./pages/CustomerDetailPage";
import CustomersPage from "./pages/CustomersPage";
import StaffPage from "./pages/StaffPage";

vi.mock("@/app/registry", () => ({
  CUSTOMER_TABS: [
    { key: "orders", label: "Orders", access: "customer", order: 10, component: ({ customerId }: { customerId: string }) => <p>Orders for {customerId}</p> },
    { key: "secret", label: "Admin only", access: "admin", order: 20, component: () => <p>Admin tab</p> },
  ],
}));

const date = new Date("2026-11-20T12:00:00.000Z");
const customerId = "01JD0000000000000000000010";
const staffId = "01JD0000000000000000000020";
const selfId = "01JD0000000000000000000001";

function me(role: "customer" | "staff" | "admin"): MeResult {
  return {
    user: { publicId: selfId, role, name: "Avery Example", email: "avery@example.test", customerRef: role === "customer" ? "RP-ABC1234" : null, status: "active" },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  } as MeResult;
}

function renderPage(page: ReactElement, records: Record<string, (input: unknown) => unknown>, options: { path?: string; role?: "customer" | "staff" | "admin" } = {}) {
  const queryClient = createTestQueryClient();
  const calls: { path: string; input: unknown }[] = [];
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc",
      transformer: superjson,
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as
          Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const paths = url.pathname.slice("/rpc/".length).split(",");
        const result = paths.map((path, index) => {
          const respond = records[path];
          if (!respond) throw new Error(`Unexpected test request: ${path}`);
          const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
          calls.push({ path, input });
          return { result: { data: superjson.serialize(respond(input)) } };
        });
        return Response.json(result);
      },
    })],
  });
  const api = fakeAuthApi({ me: async () => me(options.role ?? "admin") });
  const rendered = renderUi(page, {
    api, queryClient, path: options.path, wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider>,
  });
  return { ...rendered, calls };
}

const customerRow = {
  publicId: customerId, customerRef: "RP-ABC1234", name: "Cara Customer", email: "cara@example.test", status: "active",
  role: "customer", emailVerified: true, createdAt: date, version: 3,
};

/** SSO is not configured: the account page's Microsoft card renders nothing. */
const noSso = { "identity.sso.myLink": () => ({ available: false, linked: false, pendingAdministratorBinding: false, linkedAt: null, lastSignInAt: null, hasPassword: true }) };

describe("Account pages", () => {
  it("shows profile and account details, saves the name", async () => {
    const { calls } = renderPage(<AccountPage />, { "identity.profile.update": () => ({ ok: true }), ...noSso }, { role: "customer" });
    expect(await screen.findByRole("heading", { level: 1, name: "Your account" })).toBeInTheDocument();
    expect(await screen.findByText("RP-ABC1234")).toBeInTheDocument();
    const name = screen.getByLabelText(/Full name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Avery New");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(calls.find((c) => c.path === "identity.profile.update")?.input).toEqual({ name: "Avery New" }));
    await expectNoAxeViolations();
  });

  it("points to the Security page for password and sessions", async () => {
    renderPage(<AccountPage />, { ...noSso }, { role: "customer" });
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(await screen.findByRole("link", { name: "Open security settings" })).toHaveAttribute("href", "/account/security");
  });
});

describe("Console customer pages", () => {
  it("lists customers with links to detail and filters by status", async () => {
    const { calls } = renderPage(<CustomersPage />, { "identity.admin.customers.list": () => ({ items: [customerRow], nextCursor: null }) });
    const table = await screen.findByRole("table", { name: "Customer accounts" });
    expect(within(table).getByRole("link", { name: "Cara Customer" })).toHaveAttribute("href", `/admin/customers/${customerId}`);
    expect(within(table).getByText("Active")).toBeInTheDocument();
    await expectNoAxeViolations();
    expect(calls[0]?.path).toBe("identity.admin.customers.list");
  });

  it("creates a customer and shows the preview activation link only when the server returns one", async () => {
    const { calls } = renderPage(<CustomersPage />, {
      "identity.admin.customers.list": () => ({ items: [], nextCursor: null }),
      "identity.admin.customers.create": () => ({ customerId, customerRef: "RP-NEW0001", previewLink: "/activate?token=abc" }),
    });
    await screen.findByText("No customers yet");
    await userEvent.click(screen.getByRole("button", { name: "New customer" }));
    const dialog = await screen.findByRole("dialog", { name: "New customer" });
    await userEvent.type(within(dialog).getByLabelText(/E-mail address/), "new@example.test");
    await userEvent.type(within(dialog).getByLabelText(/Full name/), "New Person");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create and invite" }));
    const done = await screen.findByRole("dialog", { name: "Customer created" });
    expect(within(done).getByRole("link", { name: "Open the activation link" })).toHaveAttribute("href", "/activate?token=abc");
    expect(calls.find((c) => c.path === "identity.admin.customers.create")?.input).toEqual({ email: "new@example.test", name: "New Person" });
    await expectNoAxeViolations();
  });

  it("customer detail hosts CUSTOMER_TABS filtered by viewer role, and offers admin actions", async () => {
    renderPage(<Route path="/admin/customers/:customerId" component={CustomerDetailPage} />, {
      "identity.admin.customers.get": () => ({
        customer: { ...customerRow, mustChangePassword: false, hasPassword: true, statusReasonCode: null, statusChangedAt: date },
        activeSessions: 2,
        referenceHistory: [{ previousReference: null, newReference: "RP-ABC1234", reasonCode: "CREATED", changedAt: date }],
      }),
    }, { path: `/admin/customers/${customerId}`, role: "admin" });
    expect(await screen.findByRole("heading", { level: 1, name: "Cara Customer" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Admin only" })).toBeInTheDocument();
    expect(await screen.findByText(`Orders for ${customerId}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage account" })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("staff viewers see no admin-only tabs and no management actions", async () => {
    renderPage(<Route path="/admin/customers/:customerId" component={CustomerDetailPage} />, {
      "identity.admin.customers.get": () => ({
        customer: { ...customerRow, mustChangePassword: false, hasPassword: true, statusReasonCode: null, statusChangedAt: null },
        activeSessions: 0,
        referenceHistory: [],
      }),
    }, { path: `/admin/customers/${customerId}`, role: "staff" });
    await screen.findByRole("heading", { level: 1, name: "Cara Customer" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Orders" })).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Admin only" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage account" })).toBeNull();
  });
});

describe("Console staff page", () => {
  it("lists staff, marks the current user without actions, and offers actions for others", async () => {
    renderPage(<StaffPage />, {
      "identity.admin.staff.list": () => ({
        items: [
          { ...customerRow, publicId: selfId, name: "Avery Example", role: "admin", customerRef: null },
          { ...customerRow, publicId: staffId, name: "Sam Staff", role: "staff", customerRef: null, status: "pending_activation" },
        ],
        nextCursor: null,
      }),
    });
    const table = await screen.findByRole("table", { name: "Staff accounts" });
    expect(within(table).getByText("You")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Actions for Avery Example" })).toBeNull();
    expect(within(table).getByRole("button", { name: "Actions for Sam Staff" })).toBeInTheDocument();
    expect(within(table).getByText("Invitation pending")).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});
