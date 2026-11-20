import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardWidget } from "@/lib/routes";
import type { MeResult } from "@/lib/authApi";
import type * as registryModule from "@/app/registry";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { requiredActionsFor } from "./components/RequiredActions";
import { gridSpans, packRows, WidgetGrid, widgetsFor } from "./components/WidgetGrid";
import ConsoleOverviewPage from "./pages/ConsoleOverviewPage";
import CustomerHomePage, { greeting } from "./pages/CustomerHomePage";

// Other features now register customer widgets (engagement 683c794); this suite covers the empty first-order guide,
// so the registry's widgets are emptied here. Widget filtering itself is covered by the widgetsFor tests.
vi.mock("@/app/registry", async (original) => ({ ...(await original<typeof registryModule>()), WIDGETS: [] }));

const me = (role: "customer" | "staff" | "admin"): MeResult => ({
  user: { publicId: "u1", role, name: "Avery Example", email: "a@example.test", status: "active" },
  state: "full",
  pendingSteps: [],
  nextStep: null,
});
const stub = () => null;
const w = (key: string, area: "customer" | "console", access: DashboardWidget["access"], order: number): DashboardWidget => ({ key, area, access, order, span: 6, component: stub });

describe("dashboard", () => {
  it("filters widgets by area and role and sorts by order", () => {
    const all = [w("b", "console", "admin", 2), w("a", "console", "staff", 1), w("c", "customer", "customer", 0)];
    expect(widgetsFor(all, "console", "staff").map((x) => x.key)).toEqual(["a"]);
    expect(widgetsFor(all, "console", "admin").map((x) => x.key)).toEqual(["a", "b"]);
    expect(widgetsFor(all, "customer", "customer").map((x) => x.key)).toEqual(["c"]);
  });

  it("derives required actions from assurance state", () => {
    const base = { mfaEnrolled: true, recoveryCodesAcknowledged: true, totpEnrolled: true };
    expect(requiredActionsFor({ ...base, passkeyCount: 1, recoveryCodesRemaining: 10 })).toEqual([]);
    expect(requiredActionsFor({ ...base, passkeyCount: 0, recoveryCodesRemaining: 2 }).map((a) => a.key)).toEqual(["recovery-low", "passkey"]);
  });

  it("greets by time of day", () => {
    expect(greeting(new Date(2026, 0, 1, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
  });

  it("customer home welcomes the user, shows the first-order guide and has no axe violations", async () => {
    const api = fakeAuthApi({ me: async () => me("customer"), assuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, totpEnrolled: true, passkeyCount: 0, recoveryCodesRemaining: 10 }) });
    const { container } = renderUi(<CustomerHomePage />, { api });
    expect(await screen.findByRole("heading", { level: 1, name: /, avery$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /first order/i })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /add a passkey/i })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("console overview renders an empty state and has no axe violations", async () => {
    const { container } = renderUi(<ConsoleOverviewPage />, { api: fakeAuthApi({ me: async () => me("staff") }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("console overview grid layout", () => {
  const cw = (key: string, order: number, span: DashboardWidget["span"], access: DashboardWidget["access"] = "staff"): DashboardWidget => ({ key, area: "console", access, order, span, component: () => <section aria-label={key}>{key}</section> });
  // Mirrors the registered console widgets (orders.pipeline and platform.system_health share order 10).
  const REGISTERED = [cw("orders.pipeline", 10, 8), cw("platform.system_health", 10, 4), cw("engagement.console_queue", 20, 6), cw("audit.integrity", 40, 4, "admin"), cw("backup.status", 41, 4, "admin"), cw("siem.forwarding", 42, 4, "admin")];

  it("orders: system health, pipeline, queue, audit, backups, siem", () => {
    expect(widgetsFor(REGISTERED, "console", "admin").map((x) => x.key)).toEqual(["platform.system_health", "orders.pipeline", "engagement.console_queue", "audit.integrity", "backup.status", "siem.forwarding"]);
  });

  it("packs rows with no ragged gaps at lg (12) and md (2)", () => {
    expect(packRows([4, 8, 6, 4, 4, 4], 12)).toEqual([4, 8, 6, 6, 6, 6]);
    expect(packRows([4, 8, 6], 12)).toEqual([4, 8, 12]);
    expect(packRows([4, 4, 4, 4], 12)).toEqual([4, 4, 4, 12]);
    expect(packRows([12, 8, 4], 12)).toEqual([12, 8, 4]);
    const admin = gridSpans(widgetsFor(REGISTERED, "console", "admin"));
    expect(admin.map((s) => s.lg)).toEqual([4, 8, 6, 6, 6, 6]);
    expect(admin.map((s) => s.md)).toEqual([2, 2, 1, 1, 1, 1]);
    const staff = gridSpans(widgetsFor(REGISTERED, "console", "staff"));
    expect(staff.map((s) => s.lg)).toEqual([4, 8, 12]);
    expect(staff.map((s) => s.md)).toEqual([2, 2, 2]);
  });

  it("renders 1 column on phones, 2 from md, 12 from lg, with stretch-to-row-height cards", () => {
    const { container } = renderUi(<WidgetGrid widgets={widgetsFor(REGISTERED, "console", "admin")} />);
    const grid = container.firstElementChild as HTMLElement;
    for (const c of ["grid-cols-1", "md:grid-cols-2", "lg:grid-cols-12", "items-stretch"]) expect(grid.className).toContain(c);
    const cell = (key: string) => container.querySelector(`[data-widget="${key}"]`)?.className ?? "";
    expect(cell("platform.system_health")).toContain("lg:col-span-4");
    expect(cell("platform.system_health")).toContain("md:col-span-2");
    expect(cell("audit.integrity")).toContain("lg:col-span-6");
    expect(cell("siem.forwarding")).toContain("md:col-span-1");
    expect(cell("siem.forwarding")).toContain("*:flex-1");
    expect(screen.getByLabelText("siem.forwarding")).toBeInTheDocument();
  });
});
