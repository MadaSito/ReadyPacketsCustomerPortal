import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeResult, MeUser } from "@/lib/authApi";
import type { RouteDef } from "@/lib/routes";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { pageA11y } from "@/test/a11y";
import { AppRoutes } from "./AppRouter";
import { ConsoleShell } from "./shell/ConsoleShell";
import { CustomerShell } from "./shell/CustomerShell";
import { currentNavHref, customerNavLayout, customerNavSections, initials, LEGAL_NAME, navPlacement, PUBLIC_SITE_URL } from "./shell/common";
import { ALL_NAV } from "./registry";
import type { NavItem } from "@/lib/routes";

vi.mock("./slots", () => ({ NotificationSlot: () => null, GlobalSearchSlot: () => null, AnalyticsConsentSlot: () => null, CookieConsentSlot: () => null, CustomerMaintenanceSlot: () => null, CartBadgeSlot: () => null, SsoSignInSlot: () => null }));

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

  it("real registry: sidebar sections, one current entry, enabledBy hides switched-off entries, account menu", async () => {
    const api = fakeAuthApi({ bootstrap: () => Promise.resolve({ features: {} }) });
    renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Page</h1>
      </CustomerShell>,
      { path: "/orders/new", api },
    );
    const side = screen.getByRole("navigation", { name: "Customer" });
    const labels = [...side.querySelectorAll("a")].map((a) => a.textContent);
    for (const banned of ["Notifications"]) expect(labels).not.toContain(banned);
    expect(labels).toEqual(expect.arrayContaining(["Dashboard"]));
    const current = side.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBeLessThanOrEqual(1);
    for (const item of ALL_NAV.filter((n) => n.area === "customer" && n.enabledBy)) expect(labels).not.toContain(item.label);
    const quick = screen.getByRole("navigation", { name: "Quick navigation" });
    expect(within(quick).getAllByRole("link").length).toBeLessThanOrEqual(4);
    expect(within(quick).getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.getAllByRole("radiogroup", { name: "Theme" }).length).toBeGreaterThan(0);
    const trigger = screen.getByRole("button", { name: /account menu for avery example/i });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("sections, phone bar and longest-match current entry (unit)", () => {
    const icon = () => null;
    const mk = (label: string, href: string, order: number, extra: Partial<NavItem> = {}): NavItem => ({ label, href, icon, area: "customer", access: "customer", order, ...extra });
    const items = [
      mk("Dashboard", "/", 0),
      mk("My orders", "/orders", 10),
      mk("Create an order", "/orders/new", 12),
      mk("Invoices", "/invoices", 40),
      mk("Messages", "/messages", 20),
      mk("Support", "/support", 100, { group: "Support" }),
      mk("Settings", "/account", 200, { group: "Account" }),
      mk("Security", "/account/security", 220, { group: "Account" }),
      mk("Policies", "/policies", 230),
      mk("Notifications", "/notifications", 30),
    ];
    const s = customerNavSections(items);
    expect(s.main.map((i) => i.label)).toEqual(["Dashboard", "My orders", "Create an order", "Messages", "Invoices"]);
    expect(s.Support.map((i) => i.label)).toEqual(["Support"]);
    expect(s.Account.map((i) => i.label)).toEqual(["Settings", "Security", "Policies"]);
    expect(s.phone.map((i) => i.label)).toEqual(["Dashboard", "My orders", "Create an order", "Messages"]);
    const hrefs = items.map((i) => i.href);
    expect(currentNavHref("/orders/new", hrefs)).toBe("/orders/new");
    expect(currentNavHref("/orders/abc", hrefs)).toBe("/orders");
    expect(currentNavHref("/account/security", hrefs)).toBe("/account/security");
    expect(currentNavHref("/", hrefs)).toBe("/");
    expect(currentNavHref("/elsewhere", hrefs)).toBeNull();
  });
});

describe("avatar initials (D4)", () => {
  it("uses only letter/number word starts, max two, Unicode-aware", () => {
    expect(initials("Demo (synthetic admin)")).toBe("DA");
    expect(initials("Avery Example")).toBe("AE");
    expect(initials("  Zoë  ")).toBe("Z");
    expect(initials("Élodie de la Cruz")).toBe("ÉC");
    expect(initials("李 小龙")).toBe("李小");
    expect(initials("(admin)")).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(initials("3M Ops")).toBe("3O");
  });
});

describe("console header search (D5)", () => {
  it("inline search only from md up; a single 44px Search link to /admin/search below md", () => {
    renderUi(
      <ConsoleShell user={user("admin")}>
        <h1>Page</h1>
      </ConsoleShell>,
      { path: "/admin" },
    );
    const inline = screen.getByTestId("console-search-inline");
    expect(inline.className).toMatch(/(^| )hidden( |$)/);
    expect(inline.className).toContain("md:block");
    expect(inline.className).toContain("min-w-[20rem]");
    const links = screen.getAllByRole("link", { name: "Search" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/admin/search");
    expect(links[0]?.className).toContain("size-11");
    expect(links[0]?.className).toContain("md:hidden");
  });
});

describe("customer shell page a11y (package N)", () => {
  pageA11y("customer shell", async () => {
    document.title = "Dashboard · ReadyPackets";
    renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Dashboard</h1>
      </CustomerShell>,
      { path: "/", api: fakeAuthApi({ bootstrap: () => Promise.resolve({ features: {} }) }) },
    );
    await screen.findByRole("navigation", { name: "Customer" });
  });
});
