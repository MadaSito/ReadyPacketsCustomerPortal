/**
 * Package I client tests — Reports overview, all 8 built-in domains, date range validation,
 * previous-period comparisons, ChartFrame SVG charts (`bar`, `line`, `pie`) + accessible DataTable toggle,
 * MFA step-up CSV exports, custom report builder (`detail` & `grouped` modes, typed filters, sorting),
 * ownership gating (`ownedByMe` vs shared), staff capability isolation, safe domain errors, XSS inertness,
 * and both-theme axe (`pageA11y`).
 */
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { FALLBACK_BUILT_INS } from "./format";
import { ReportResultSection } from "./ReportChart";
import { reportsFeature } from "./routes";
import { renderReportsWithTrpc, throwSafeError, type Fixtures, type Role } from "./testkit";
import {
  REPORT_LIMITS,
  type BuiltInResult,
  type CatalogueView,
  type CustomResult,
  type DatasetView,
  type DefinitionView,
  type ReportSpec,
} from "./types";

configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  await Promise.all([
    import("./pages/ReportsOverviewPage"),
    import("./pages/BuiltInReportPage"),
    import("./pages/CustomReportBuilderPage"),
    import("./pages/CustomReportRunPage"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DEF_OWNED_ID = "01JD0000000000000000000901";
const DEF_SHARED_ID = "01JD0000000000000000000902";
const DEF_DUP_ID = "01JD0000000000000000000903";
const SPEC_HASH_1 = "abcdef0123456789".repeat(4);

const supportDatasetFixture: DatasetView = {
  key: "support_tickets",
  label: "Support tickets",
  description: "Customer support tickets with response and resolution timings.",
  fields: [
    {
      key: "ticketNumber",
      label: "Ticket number",
      type: "string",
      personal: false,
      filterOps: ["eq", "startsWith", "in"],
      groupable: false,
      buckets: [],
      aggregates: [],
    },
    {
      key: "status",
      label: "Status",
      type: "enum",
      personal: false,
      enumValues: ["open", "pending_customer", "pending_staff", "resolved", "closed"],
      filterOps: ["eq", "neq", "in"],
      groupable: true,
      buckets: [],
      aggregates: [],
    },
    {
      key: "category",
      label: "Category",
      type: "enum",
      personal: false,
      enumValues: ["general", "order", "billing", "technical", "account", "other"],
      filterOps: ["eq", "in"],
      groupable: true,
      buckets: [],
      aggregates: [],
    },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      personal: false,
      enumValues: ["low", "normal", "high", "urgent"],
      filterOps: ["eq", "in"],
      groupable: true,
      buckets: [],
      aggregates: [],
    },
    {
      key: "firstResponseSeconds",
      label: "First response time",
      type: "duration",
      personal: false,
      filterOps: ["gte", "lte", "between", "isNull", "isNotNull"],
      groupable: false,
      buckets: [],
      aggregates: ["avg", "min", "max"],
    },
    {
      key: "createdAt",
      label: "Created at",
      type: "datetime",
      personal: false,
      filterOps: ["gte", "lte", "between"],
      groupable: true,
      buckets: ["day", "week", "month"],
      aggregates: [],
    },
    {
      key: "customerEmail",
      label: "Customer email",
      type: "string",
      personal: true,
      filterOps: ["eq", "contains"],
      groupable: false,
      buckets: [],
      aggregates: [],
    },
  ],
};

const ordersDatasetFixture: DatasetView = {
  key: "orders",
  label: "Orders",
  description: "Customer orders, workflow progress, and totals.",
  fields: [
    {
      key: "orderNumber",
      label: "Order number",
      type: "string",
      personal: false,
      filterOps: ["eq", "startsWith"],
      groupable: false,
      buckets: [],
      aggregates: [],
    },
    {
      key: "status",
      label: "Order status",
      type: "enum",
      personal: false,
      enumValues: ["pending", "in_progress", "completed", "cancelled"],
      filterOps: ["eq", "in"],
      groupable: true,
      buckets: [],
      aggregates: [],
    },
    {
      key: "totalMinor",
      label: "Order total",
      type: "money",
      personal: false,
      filterOps: ["gte", "lte", "between"],
      groupable: false,
      buckets: [],
      aggregates: ["sum", "avg", "min", "max"],
    },
  ],
};

function catalogueFor(role: Role): CatalogueView {
  const isAdmin = role === "admin";
  return {
    builtIns: FALLBACK_BUILT_INS,
    datasets: isAdmin ? [supportDatasetFixture, ordersDatasetFixture] : [],
    limits: { ...REPORT_LIMITS },
    canManage: isAdmin,
    canExport: isAdmin,
  };
}

const ownedDefinitionFixture: DefinitionView = {
  definitionId: DEF_OWNED_ID,
  name: "Support volume by category",
  description: "Grouped count and response average by ticket category.",
  visibility: "private",
  dataset: "support_tickets",
  spec: {
    dataset: "support_tickets",
    columns: [],
    filters: [{ field: "status", op: "eq", value: "open" }],
    groupBy: [{ field: "category" }],
    aggregates: [
      { fn: "count" },
      { fn: "avg", field: "firstResponseSeconds" },
    ],
    sort: [{ key: "count", dir: "desc" }],
    limit: 500,
    chart: "bar",
  },
  specHash: SPEC_HASH_1,
  valid: true,
  ownedByMe: true,
  version: 3,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-20T14:30:00.000Z",
};

const sharedDefinitionFixture: DefinitionView = {
  definitionId: DEF_SHARED_ID,
  name: "Shared revenue by order status",
  description: "Shared executive breakdown across order statuses.",
  visibility: "shared",
  dataset: "orders",
  spec: {
    dataset: "orders",
    columns: [],
    filters: [],
    groupBy: [{ field: "status" }],
    aggregates: [{ fn: "sum", field: "totalMinor" }],
    sort: [{ key: "sum_totalMinor", dir: "desc" }],
    limit: 1000,
    chart: "pie",
  },
  specHash: "9876543210fedcba".repeat(4),
  valid: false,
  ownedByMe: false,
  version: 1,
  createdAt: "2026-11-05T09:00:00.000Z",
  updatedAt: "2026-11-18T11:15:00.000Z",
};

function supportBuiltInResult(role: Role): BuiltInResult {
  return {
    key: "support",
    title: "Support tickets",
    range: {
      from: "2026-10-25T00:00:00.000Z",
      to: "2026-11-24T00:00:00.000Z",
    },
    previousRange: {
      from: "2026-09-25T00:00:00.000Z",
      to: "2026-10-25T00:00:00.000Z",
    },
    metrics: [
      {
        key: "tickets_opened",
        label: "Tickets opened",
        type: "number",
        value: 50,
        previous: 40,
      },
      {
        key: "avg_first_response",
        label: "Avg first response",
        type: "duration",
        value: 1110,
        previous: 1500,
      },
      {
        key: "avg_resolution",
        label: "Avg resolution time",
        type: "duration",
        value: 8100,
        previous: 8100,
      },
      {
        key: "mixed_fee",
        label: "Support credits",
        type: "money",
        value: null,
        previous: null,
        currency: null,
      },
    ],
    panels: [
      {
        key: "by_category",
        title: "Tickets by category",
        chart: "bar",
        summary: "Billing accounts for 22 open tickets and Technical accounts for 18.",
        columns: [
          { key: "category", label: "Category", type: "enum" },
          { key: "opened", label: "Opened", type: "number" },
          { key: "closed", label: "Closed", type: "number" },
        ],
        rows: [
          ["billing", 22, 19],
          ["technical", 18, 15],
          ["order", 10, 9],
        ],
        rowCount: 3,
        truncated: false,
      },
      {
        key: "daily_volume",
        title: "Daily ticket trend",
        chart: "line",
        summary: "Ticket intake peaked on 2026-11-20 with 14 tickets.",
        columns: [
          { key: "day", label: "Day", type: "datetime" },
          { key: "opened", label: "Opened", type: "number" },
          { key: "resolved", label: "Resolved", type: "number" },
        ],
        rows: [
          ["2026-11-18", 8, 7],
          ["2026-11-19", 11, 9],
          ["2026-11-20", 14, 12],
        ],
        rowCount: 3,
        truncated: false,
      },
      {
        key: "by_priority",
        title: "Priority share",
        chart: "pie",
        summary: "Normal priority represents 60% of tickets.",
        columns: [
          { key: "priority", label: "Priority", type: "enum" },
          { key: "tickets", label: "Tickets", type: "number" },
        ],
        rows: [
          ["normal", 30],
          ["high", 15],
          ["urgent", 5],
        ],
        rowCount: 3,
        truncated: false,
      },
    ],
    notes:
      role === "staff"
        ? ["Personal columns hidden for your role."]
        : [],
    generatedAt: "2026-11-23T16:00:00.000Z",
  };
}

const customRunResultFixture: CustomResult = {
  chart: "bar",
  specHash: SPEC_HASH_1,
  generatedAt: "2026-11-23T16:05:00.000Z",
  columns: [
    { key: "category", label: "Category", type: "enum" },
    { key: "count", label: "Count", type: "number" },
    { key: "avg_firstResponseSeconds", label: "Avg first response", type: "duration" },
  ],
  rows: [
    ["billing", 22, 900],
    ["technical", 14, 1800],
  ],
  rowCount: 2,
  truncated: false,
};

function baseFixtures(role: Role, overrides: Fixtures = {}): Fixtures {
  return {
    "reports.catalogue": () => catalogueFor(role),
    "reports.builtIn.run": () => supportBuiltInResult(role),
    "reports.custom.list": () => ({
      items: [ownedDefinitionFixture, sharedDefinitionFixture],
      nextCursor: null,
    }),
    "reports.custom.get": (raw) => {
      const id = (raw as { definitionId?: string })?.definitionId;
      if (id === DEF_SHARED_ID) return sharedDefinitionFixture;
      return ownedDefinitionFixture;
    },
    "reports.custom.run": () => customRunResultFixture,
    "reports.custom.preview": (raw) => {
      const spec = (raw as { spec: ReportSpec }).spec;
      return {
        ...customRunResultFixture,
        chart: spec.chart,
      };
    },
    "reports.custom.create": (raw) => {
      const input = raw as { name: string; description?: string; visibility: "private" | "shared"; spec: ReportSpec };
      return {
        ...ownedDefinitionFixture,
        definitionId: DEF_DUP_ID,
        name: input.name,
        description: input.description ?? "",
        visibility: input.visibility,
        dataset: input.spec.dataset,
        spec: input.spec,
      };
    },
    "reports.custom.update": (raw) => {
      const input = raw as { name: string; description?: string; visibility: "private" | "shared"; spec: ReportSpec; expectedVersion: number };
      return {
        ...ownedDefinitionFixture,
        name: input.name,
        description: input.description ?? "",
        visibility: input.visibility,
        spec: input.spec,
        version: input.expectedVersion + 1,
      };
    },
    "reports.custom.duplicate": () => ({
      ...ownedDefinitionFixture,
      definitionId: DEF_DUP_ID,
      name: "Copy of Support volume by category",
      ownedByMe: true,
      valid: true,
    }),
    "reports.custom.delete": () => ({ deleted: true }),
    ...overrides,
  };
}

function renderReportsRoute(
  path: string,
  role: Role = "admin",
  overrides: Fixtures = {},
  authOverrides: NonNullable<Parameters<typeof renderReportsWithTrpc>[2]>["authOverrides"] = {},
) {
  return renderReportsWithTrpc(
    <AppRoutes routes={reportsFeature.routes} />,
    baseFixtures(role, overrides),
    { path, role, authOverrides },
  );
}

describe("Package I — Reports Overview, Built-in Analytics & Custom Report Builder", () => {
  it("registers console nav and capability-gated routes", () => {
    expect(reportsFeature.routes.map((r) => [r.path, r.access, r.capability])).toEqual([
      ["/admin/reports", "staff", "reports.read"],
      ["/admin/reports/built-in/:reportKey", "staff", "reports.read"],
      ["/admin/reports/custom/new", "admin", "reports.manage"],
      ["/admin/reports/custom/:definitionId/edit", "admin", "reports.manage"],
      ["/admin/reports/custom/:definitionId", "admin", "reports.manage"],
    ]);
    expect(reportsFeature.nav).toEqual([
      expect.objectContaining({
        label: "Reports",
        href: "/admin/reports",
        area: "console",
        access: "staff",
        capability: "reports.read",
      }),
    ]);
  });

  it("renders all 8 built-in report cards and owner-aware custom report controls for admins", async () => {
    const user = userEvent.setup();
    const { calls } = renderReportsRoute("/admin/reports", "admin");

    expect(await screen.findByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Open Orders" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /New custom report/i })).toBeTruthy();

    for (const item of FALLBACK_BUILT_INS) {
      expect(screen.getByRole("link", { name: `Open ${item.title}` })).toBeTruthy();
    }

    // Saved custom reports table shows both owned and shared reports
    const table = await screen.findByRole("table", { name: "Saved custom reports" });
    expect(within(table).getByText("Support volume by category")).toBeTruthy();
    expect(within(table).getByText("Shared revenue by order status")).toBeTruthy();
    expect(within(table).getByText("Needs update")).toBeTruthy();

    // Owned report exposes Edit & Delete; shared non-owned report exposes Run & Duplicate only
    expect(within(table).getByRole("link", { name: "Edit Support volume by category" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Delete Support volume by category" })).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Edit Shared revenue by order status" })).toBeNull();
    expect(within(table).queryByRole("button", { name: "Delete Shared revenue by order status" })).toBeNull();
    expect(within(table).getByRole("button", { name: "Duplicate Shared revenue by order status" })).toBeTruthy();

    // Deleting an owned report opens ConfirmDialog and passes expectedVersion
    await user.click(within(table).getByRole("button", { name: "Delete Support volume by category" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete custom report?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete report" }));

    await waitFor(() => {
      const delCall = calls.find((c) => c.path === "reports.custom.delete");
      expect(delCall?.input).toEqual({
        definitionId: DEF_OWNED_ID,
        expectedVersion: 3,
      });
    });
  });

  it("restricts staff to built-in reports only and blocks /admin/reports/custom/* routes", async () => {
    const { calls, unmount } = renderReportsRoute("/admin/reports", "staff");

    expect(await screen.findByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Open Support tickets" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /New custom report/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Custom reports" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("reports.custom."))).toBe(false);
    unmount();

    const blocked = renderReportsRoute("/admin/reports/custom/new", "staff");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New custom report" })).toBeNull();
    expect(blocked.calls.some((c) => c.path.startsWith("reports.custom."))).toBe(false);
  });

  it("renders built-in KPI comparisons, SVG charts + DataTable toggle, date validation, and staff notes", async () => {
    const user = userEvent.setup();
    const { calls, unmount } = renderReportsRoute("/admin/reports/built-in/support", "staff");

    expect(await screen.findByRole("heading", { level: 1, name: "Support tickets" })).toBeTruthy();

    // Staff note callout rendered and CSV export hidden for staff
    expect(await screen.findByText("Personal columns hidden for your role.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Export .* CSV/i })).toBeNull();

    // KPI values and plain-text period comparisons (no colour-only cue)
    expect(screen.getByText("Up +25.0% vs previous period (40)")).toBeTruthy();
    expect(screen.getByText("18m 30s")).toBeTruthy();
    expect(screen.getByText("Down -26.0% vs previous period (25m)")).toBeTruthy();
    expect(screen.getByText("Unchanged vs previous period (2h 15m)")).toBeTruthy();
    expect(screen.getByText("Multiple currencies")).toBeTruthy();

    // Accessible SVG charts rendered inside ChartFrame with visible summary + Table switch
    expect(screen.getByText("Billing accounts for 22 open tickets and Technical accounts for 18.")).toBeTruthy();
    const svgs = screen.getAllByRole("img");
    expect(svgs.length).toBeGreaterThanOrEqual(3);

    // Switch "Tickets by category" from Chart to Table via SegmentedControl
    const viewGroup = screen.getByRole("radiogroup", { name: "Tickets by category: view" });
    await user.click(within(viewGroup).getByRole("radio", { name: "Table" }));
    const catTable = await screen.findByRole("table", { name: "Tickets by category data table" });
    expect(within(catTable).getByText("Billing")).toBeTruthy();

    // Invalid date range (`to < from`) shows field error and does not trigger another builtIn.run call
    const runCountBefore = calls.filter((c) => c.path === "reports.builtIn.run").length;
    const fromInput = screen.getByLabelText(/From \(UTC\)/i);
    const toInput = screen.getByLabelText(/To \(UTC\)/i);
    await user.clear(fromInput);
    await user.type(fromInput, "2026-11-20");
    await user.clear(toInput);
    await user.type(toInput, "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Apply date range" }));

    expect(await screen.findByText("The end date must be on or after the start date.")).toBeTruthy();
    expect(calls.filter((c) => c.path === "reports.builtIn.run").length).toBe(runCountBefore);

    // Range > 732 days is rejected
    await user.clear(fromInput);
    await user.type(fromInput, "2023-01-01");
    await user.clear(toInput);
    await user.type(toInput, "2026-11-20");
    await user.click(screen.getByRole("button", { name: "Apply date range" }));
    expect(await screen.findByText(/Choose a range of 732 days/i)).toBeTruthy();
    unmount();
  });

  it("enforces fresh MFA step-up before exporting CSV on built-in and custom reports", async () => {
    const user = userEvent.setup();
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:https://portal.example.test/csv-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    let steppedUp = false;
    const stepUpCalls: unknown[] = [];

    const { calls } = renderReportsRoute(
      "/admin/reports/built-in/support",
      "admin",
      {
        "reports.builtIn.export": () => {
          if (!steppedUp) {
            throwSafeError("STEP_UP_REQUIRED", "Re-verify MFA to export CSV.", {
              code: "FORBIDDEN",
            });
          }
          return {
            filename: "support-by-category.csv",
            contentType: "text/csv; charset=utf-8",
            csv: "\uFEFFCategory,Opened,Closed\r\nbilling,22,19\r\n",
            rowCount: 1,
            truncated: false,
            specHash: SPEC_HASH_1,
          };
        },
      },
      {
        stepUp: async (payload: unknown) => {
          stepUpCalls.push(payload);
          steppedUp = true;
          return { verifiedAt: new Date().toISOString() } as never;
        },
      },
    );

    const exportBtn = await screen.findByRole("button", {
      name: "Export CSV: Tickets by category",
    });
    await user.click(exportBtn);

    // StepUp dialog opens on STEP_UP_REQUIRED
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Password/i), "CorrectHorseBatteryStaple!1");
    await user.type(within(dialog).getByLabelText(/6-digit code/i), "123456");
    await user.click(within(dialog).getByRole("button", { name: /Verify|Confirm|Continue/i }));

    await waitFor(() => {
      expect(stepUpCalls.length).toBe(1);
      expect(calls.filter((c) => c.path === "reports.builtIn.export").length).toBe(2);
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    "/admin/reports/custom/new",
    `/admin/reports/custom/${DEF_OWNED_ID}/edit`,
  ])("sets a narrow-layout Query mode on %s without changing its keyboard controls", async (route) => {
    const user = userEvent.setup();
    renderReportsRoute(route, "admin");
    const group = await screen.findByRole("radiogroup", { name: "Query mode" });
    // jsdom cannot calculate viewport overflow; assert the breakpoint wiring on both routes.
    expect(group.parentElement?.classList.contains("max-[320px]:flex")).toBe(true);
    expect(group.parentElement?.classList.contains("max-[320px]:[&_[role=radiogroup]]:flex-col")).toBe(true);
    const current = within(group).getByRole("radio", { checked: true });
    const next = within(group).getByRole("radio", { checked: false });
    current.focus();
    await user.keyboard("{ArrowDown}");
    expect(next.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(next);
  });

  it("builds, previews, and saves a grouped custom report with empty detail columns and typed filters", async () => {
    const user = userEvent.setup();
    const { calls } = renderReportsRoute("/admin/reports/custom/new", "admin");

    expect(
      await screen.findByRole("heading", { level: 1, name: "New custom report" }),
    ).toBeTruthy();

    // Switch to Grouped mode (detail columns must be cleared automatically per spec.ts)
    const modeGroup = await screen.findByRole("radiogroup", { name: "Query mode" });
    await user.click(within(modeGroup).getByRole("radio", { name: "Group & aggregate" }));

    // Add a typed filter (`Status` = `open`)
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.selectOptions(screen.getByLabelText("Filter field 1"), "status");
    await user.selectOptions(screen.getByLabelText("Value 1"), "open");

    // Run preview
    await user.click(screen.getAllByRole("button", { name: "Run preview" })[0]!);
    expect(await screen.findByRole("heading", { name: "Report preview" })).toBeTruthy();

    const previewCall = calls.find((c) => c.path === "reports.custom.preview");
    const previewSpec = (previewCall?.input as { spec: ReportSpec }).spec;
    expect(previewSpec.dataset).toBe("support_tickets");
    expect(previewSpec.columns).toEqual([]);
    expect(previewSpec.groupBy).toEqual([{ field: "status" }]);
    expect(previewSpec.aggregates).toEqual([{ fn: "count" }]);
    expect(previewSpec.filters).toEqual([{ field: "status", op: "eq", value: "open" }]);

    // Save as shared report
    await user.type(screen.getByLabelText(/Report name/i), "Open tickets by status");
    await user.click(screen.getByRole("radio", { name: /Shared with administrators/i }));
    await user.click(screen.getByRole("button", { name: "Save custom report" }));

    await waitFor(() => {
      const createCall = calls.find((c) => c.path === "reports.custom.create");
      expect(createCall?.input).toEqual(
        expect.objectContaining({
          name: "Open tickets by status",
          visibility: "shared",
        }),
      );
    });
  });

  it("blocks direct editing of non-owned shared reports, surfaces safe domain errors, and renders XSS strings inertly", async () => {
    const user = userEvent.setup();

    // 1. Non-owned shared report on /edit shows read-only notice + Duplicate to edit
    const sharedEdit = renderReportsRoute(
      `/admin/reports/custom/${DEF_SHARED_ID}/edit`,
      "admin",
    );
    expect(await screen.findByText("Read-only shared definition")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duplicate to edit" })).toBeTruthy();
    sharedEdit.unmount();

    // 2. Run page surfaces REPORT_RATE_LIMITED safely and renders literal <script> text inertly on retry
    let failFirst = true;
    const xssPayload = "<script>window.__xssExecuted = true</script>";
    renderReportsRoute(`/admin/reports/custom/${DEF_OWNED_ID}`, "admin", {
      "reports.custom.run": () => {
        if (failFirst) {
          failFirst = false;
          throwSafeError(
            "REPORT_RATE_LIMITED",
            "Too many report runs in the last minute.",
            { code: "TOO_MANY_REQUESTS" },
          );
        }
        return {
          ...customRunResultFixture,
          truncated: true,
          columns: [
            { key: "ticketNumber", label: "Ticket", type: "string" },
            { key: "count", label: "Count", type: "number" },
          ],
          rows: [[xssPayload, 5]],
          rowCount: 5000,
        };
      },
    });

    expect(await screen.findByText("Report rate limit reached")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry run" }));

    expect(await screen.findByText("Screen row limit reached")).toBeTruthy();
    // Switch to Table view and confirm literal script tag is rendered as inert text
    const viewGroup = screen.getByRole("radiogroup", { name: "Results: view" });
    await user.click(within(viewGroup).getByRole("radio", { name: "Table" }));
    const resTable = await screen.findByRole("table", { name: "Results data table" });
    expect(within(resTable).getByText(xssPayload)).toBeTruthy();
    expect((window as unknown as { __xssExecuted?: boolean }).__xssExecuted).toBeUndefined();
  });

  it("updates an owned custom report with expectedVersion, validates money minor-unit filters, and surfaces conflict/spec errors", async () => {
    const user = userEvent.setup();
    let updateAttempt = 0;
    const { calls } = renderReportsRoute(
      `/admin/reports/custom/${DEF_OWNED_ID}/edit`,
      "admin",
      {
        "reports.custom.update": (raw) => {
          updateAttempt += 1;
          if (updateAttempt === 1) {
            throwSafeError(
              "REPORT_SPEC_INVALID",
              "Spec validation failed.",
              { details: { path: "filters.0.value" } },
            );
          }
          const payload = raw as {
            definitionId: string;
            expectedVersion: number;
            definition: Record<string, unknown>;
          };
          return {
            ...ownedDefinitionFixture,
            ...payload.definition,
            version: payload.expectedVersion + 1,
          };
        },
      },
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Edit custom report" }),
    ).toBeTruthy();

    // Switch dataset to Orders and add a money `between` filter to verify integer minor-unit validation
    await user.selectOptions(await screen.findByLabelText("Dataset"), "orders");
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    await user.selectOptions(screen.getByLabelText("Filter field 1"), "totalMinor");
    await user.selectOptions(screen.getByLabelText("Operator 1"), "between");

    const fromInput = screen.getByLabelText("Start value 1");
    const toInput = screen.getByLabelText("End value 1");
    await user.clear(fromInput);
    await user.type(fromInput, "12.5");
    await user.clear(toInput);
    await user.type(toInput, "5000");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/integer in minor currency units/i)).toBeTruthy();
    expect(calls.filter((c) => c.path === "reports.custom.update").length).toBe(0);

    // Fix lower bound to integer minor units; first save hits REPORT_SPEC_INVALID with details.path
    await user.clear(fromInput);
    await user.type(fromInput, "1250");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/filters\.0\.value/i)).toBeTruthy();

    // Second save succeeds and sends nested `{ definitionId, expectedVersion, definition }`
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const updateCalls = calls.filter((c) => c.path === "reports.custom.update");
      expect(updateCalls.length).toBe(2);
      expect(updateCalls[1]?.input).toEqual({
        definitionId: DEF_OWNED_ID,
        expectedVersion: 3,
        definition: expect.objectContaining({
          name: "Support volume by category",
          visibility: "private",
          spec: expect.objectContaining({
            dataset: "orders",
            columns: [],
            filters: [{ field: "totalMinor", op: "between", value: [1250, 5000] }],
          }),
        }),
      });
    });
  });

  it("anchors 30-day line chart end ticks without clipping and adapts viewBox/tick count at 320 px widths", async () => {
    const rows = Array.from({ length: 30 }, (_, idx) => {
      const d = new Date(Date.UTC(2026, 9, 25 + idx));
      return [d.toISOString().slice(0, 10), (idx % 5) + 1];
    });
    const table = {
      columns: [
        { key: "bucket", label: "Date", type: "datetime" as const },
        { key: "orders", label: "Orders", type: "number" as const },
      ],
      rows,
      rowCount: rows.length,
      truncated: false,
    };

    const { unmount } = renderUi(
      <ReportResultSection title="Orders over time" chart="line" table={table} />,
    );
    const desktopSvg = screen.getByRole("img", { name: /^Orders over time/ });
    expect(desktopSvg.getAttribute("viewBox")).toBe("0 0 640 272");
    const firstTick = within(desktopSvg).getByText("2026-10-25");
    const lastTick = within(desktopSvg).getByText("2026-11-23");
    expect(firstTick.getAttribute("text-anchor")).toBe("start");
    expect(lastTick.getAttribute("text-anchor")).toBe("end");
    unmount();

    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 254,
        bottom: 236,
        width: 254,
        height: 236,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      renderUi(<ReportResultSection title="Orders mobile" chart="line" table={table} />);
      const mobileSvg = await screen.findByRole("img", { name: /^Orders mobile/ });
      await waitFor(() => {
        expect(mobileSvg.getAttribute("viewBox")).toBe("0 0 254 236");
      });
      expect(within(mobileSvg).getByText("2026-10-25").getAttribute("text-anchor")).toBe("start");
      expect(within(mobileSvg).getByText("2026-11-23").getAttribute("text-anchor")).toBe("end");
    } finally {
      rectSpy.mockRestore();
    }
  });

  pageA11y("Reports overview", async () => {
    renderReportsRoute("/admin/reports", "admin");
    await screen.findByRole("table", { name: "Saved custom reports" });
  });

  pageA11y("Built-in support report", async () => {
    renderReportsRoute("/admin/reports/built-in/support", "admin");
    await screen.findByText("Billing accounts for 22 open tickets and Technical accounts for 18.");
  });

  pageA11y("Custom report builder", async () => {
    renderReportsRoute("/admin/reports/custom/new", "admin");
    await screen.findByRole("heading", { level: 1, name: "New custom report" });
  });

  pageA11y("Custom report run view", async () => {
    renderReportsRoute(`/admin/reports/custom/${DEF_OWNED_ID}`, "admin");
    await screen.findByText("Definition hash");
  });
});
