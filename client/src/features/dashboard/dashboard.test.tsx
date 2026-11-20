import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardWidget } from "@/lib/routes";
import type { MeResult } from "@/lib/authApi";
import type * as registryModule from "@/app/registry";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { requiredActionsFor } from "./components/RequiredActions";
import { widgetsFor } from "./components/WidgetGrid";
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
