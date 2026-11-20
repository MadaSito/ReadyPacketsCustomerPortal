import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeResult, MeUser } from "@/lib/authApi";
import type { RouteDef } from "@/lib/routes";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { AppRoutes } from "./AppRouter";
import { ConsoleShell } from "./shell/ConsoleShell";
import { CustomerShell } from "./shell/CustomerShell";
import { customerNavLayout, LEGAL_NAME, MAX_PRIMARY_NAV, navPlacement, PUBLIC_SITE_URL, visibleNav } from "./shell/common";
import { ALL_NAV } from "./registry";
import type { NavItem } from "@/lib/routes";

vi.mock("./slots", () => ({ NotificationSlot: () => null, GlobalSearchSlot: () => null, AnalyticsConsentSlot: () => null }));

const user = (role: MeUser["role"]): MeUser => ({ publicId: "u1", role, name: "Avery Example", email: "a@example.test", status: "active" });
const full = (role: MeUser["role"]): MeResult => ({ user: user(role), state: "full", pendingSteps: [], nextStep: null });
const unauth = () => Promise.reject(Object.assign(new Error("UNAUTHENTICATED"), { data: { safe: { domainCode: "UNAUTHENTICATED" } } }));

describe("shells", () => {
  for (const [name, Shell, role] of [
    ["customer", CustomerShell, "customer"],
    ["console", ConsoleShell, "admin"],
  ] as const) {
    it(`${name} shell: landmarks, skip link, footer and no axe violations`, async () => {
      const { container } = renderUi(
        <Shell user={user(role)}>
          <h1>Page</h1>
        </Shell>,
        { path: name === "console" ? "/admin" : "/" },
      );
      expect(screen.getByRole("main")).toHaveAttribute("id", "main");
      expect(screen.getByRole("link", { name: /skip to main content/i })).toBeInTheDocument();
      expect(screen.getByRole("contentinfo")).toHaveTextContent(LEGAL_NAME);
      const site = screen.getAllByRole("link").find((a) => a.getAttribute("href") === PUBLIC_SITE_URL);
      expect(site).toHaveAttribute("target", "_blank");
      expect(site).toHaveAttribute("rel", "noopener noreferrer");
      await expectNoAxeViolations(container);
    });
  }

  it("skip link moves focus to main", () => {
    renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Page</h1>
      </CustomerShell>,
    );
    fireEvent.click(screen.getByRole("link", { name: /skip to main content/i }));
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

const Page = (label: string) => () => <h1>{label}</h1>;
const ROUTES: RouteDef[] = [
  { path: "/sign-in", access: "public", title: "Sign in", component: Page("Sign in page") },
  { path: "/mfa", access: "transition", title: "MFA", component: Page("MFA page") },
  { path: "/", access: "customer", title: "Home", component: Page("Home page") },
  { path: "/admin", access: "staff", title: "Overview", component: Page("Console page") },
];

describe("AppRoutes guard integration", () => {
  it("anonymous visitor on a customer route is sent to sign-in with a safe next", async () => {
    const { location } = renderUi(<AppRoutes routes={ROUTES} />, { path: "/", api: fakeAuthApi({ me: unauth }) });
    expect(await screen.findByRole("heading", { name: "Sign in page" })).toBeInTheDocument();
    expect(location.history?.at(-1)).toMatch(/^\/sign-in/);
  });

  it("remediation session is held at its transition step", async () => {
    renderUi(<AppRoutes routes={ROUTES} />, { path: "/", api: fakeAuthApi({ me: async () => ({ ...full("customer"), state: "remediation", pendingSteps: ["mfa_challenge"], nextStep: "mfa_challenge" }) }) });
    expect(await screen.findByRole("heading", { name: "MFA page" })).toBeInTheDocument();
  });

  it("customer cannot open the console (not found, not a redirect leak)", async () => {
    renderUi(<AppRoutes routes={ROUTES} />, { path: "/admin", api: fakeAuthApi({ me: async () => full("customer") }) });
    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Console page" })).not.toBeInTheDocument();
  });

  it("staff reaches the console inside the console shell; signed-in user on sign-in goes home", async () => {
    const a = renderUi(<AppRoutes routes={ROUTES} />, { path: "/admin", api: fakeAuthApi({ me: async () => full("staff") }) });
    expect(await screen.findByRole("heading", { name: "Console page" })).toBeInTheDocument();
    a.unmount();
    const b = renderUi(<AppRoutes routes={ROUTES} />, { path: "/sign-in", api: fakeAuthApi({ me: async () => full("customer") }) });
    await waitFor(() => expect(b.location.history?.at(-1)).toBe("/"));
  });

  it("unknown path renders the 404 page", async () => {
    renderUi(<AppRoutes routes={ROUTES} />, { path: "/nope", api: fakeAuthApi({ me: unauth }) });
    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });
});

describe("customer nav placement (D1: no top-bar collisions)", () => {
  const Icon = () => null;
  const item = (href: string, order: number, extra: Partial<NavItem> = {}): NavItem => ({ label: href, href, icon: Icon, area: "customer", access: "customer", order, ...extra });

  it("derives placement by path, explicit placement wins", () => {
    expect(navPlacement(item("/orders", 1))).toBe("primary");
    expect(navPlacement(item("/notifications", 1))).toBe("hidden");
    expect(navPlacement(item("/account", 1))).toBe("account");
    expect(navPlacement(item("/account/sessions", 1))).toBe("account");
    expect(navPlacement(item("/policies", 1))).toBe("account");
    expect(navPlacement(item("/accounting", 1))).toBe("primary");
    expect(navPlacement(item("/orders", 1, { placement: "account" }))).toBe("account");
  });

  it("caps the inline bar and overflows the rest into More, in order", () => {
    const layout = customerNavLayout(Array.from({ length: 8 }, (_, i) => item(`/p${8 - i}`, 8 - i)));
    expect(layout.primary.map((i) => i.href)).toEqual(["/p1", "/p2", "/p3", "/p4", "/p5"]);
    expect(layout.more.map((i) => i.href)).toEqual(["/p6", "/p7", "/p8"]);
    expect(layout.account.map((i) => i.href)).toEqual(["/account", "/account/security"]);
  });

  it("real registry: top bar holds only primary items; account entries live in the avatar menu", async () => {
    const layout = customerNavLayout(visibleNav(ALL_NAV, "customer", "customer"));
    expect(layout.primary.length).toBeLessThanOrEqual(MAX_PRIMARY_NAV);
    renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Page</h1>
      </CustomerShell>,
    );
    const bar = screen.getByRole("navigation", { name: "Primary" });
    const labels = [...bar.querySelectorAll("a")].map((a) => a.textContent);
    for (const banned of ["Notifications", "Your account", "Sessions", "Account security", "Policies"]) expect(labels).not.toContain(banned);
    expect(bar.querySelectorAll("a").length).toBeLessThanOrEqual(MAX_PRIMARY_NAV);
    expect(labels).toEqual(expect.arrayContaining(["Home", "Orders"]));
    for (const a of bar.querySelectorAll("a")) expect(a.className).toContain("whitespace-nowrap");
    const trigger = screen.getByRole("button", { name: /account menu for avery example/i });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    for (const entry of layout.account) expect(within(menu).getByRole("menuitem", { name: entry.label })).toHaveAttribute("href", entry.href);
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });
});
