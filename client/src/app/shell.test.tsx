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
import { clearCustomerPortalChoice, readCustomerPortalChoice, setCustomerPortalChoice } from "@/lib/portal";
import { phoneTabLabel, visibleNav } from "./shell/common";
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

describe("07.1 staff/admin in the customer portal (D1–D4)", () => {
  const openAccountMenu = async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: /account menu for avery example/i }), { button: 0, pointerType: "mouse" });
    return screen.findByRole("menu");
  };

  it("customer nav hides Create an order and Cart for staff and admin, keeps them for customers", () => {
    const hrefs = (role: MeUser["role"]) => visibleNav(ALL_NAV, "customer", role).map((i) => i.href);
    for (const role of ["staff", "admin"] as const) {
      expect(hrefs(role)).not.toContain("/orders/new");
      expect(hrefs(role)).not.toContain("/cart");
      expect(hrefs(role)).toContain("/orders");
    }
    expect(hrefs("customer")).toContain("/orders/new");
    expect(hrefs("customer")).toContain("/cart");
  });

  for (const [role, label] of [["admin", "Admin portal"], ["staff", "Staff portal"]] as const) {
    it(`customer shell as ${role}: notice, visible "${label}" switch in the top bar and drawer, avatar entry renamed`, async () => {
      const { container } = renderUi(
        <CustomerShell user={user(role)}>
          <h1>Page</h1>
        </CustomerShell>,
        { path: "/orders", api: fakeAuthApi({ bootstrap: () => Promise.resolve({ features: {} }) }) },
      );
      const notice = screen.getByTestId("staff-portal-notice");
      expect(notice).toHaveTextContent(`You are viewing the customer portal as ${role === "admin" ? "an administrator" : "a staff member"}.`);
      expect(within(notice).getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
      // The notice repeats the switch only below md, where the top-bar switch is hidden (no duplicate at md+).
      const noticeSwitch = within(notice).getByRole("link", { name: label });
      expect(noticeSwitch).toHaveAttribute("href", "/admin");
      expect(noticeSwitch.className).toContain("md:hidden");
      const header = screen.getByRole("banner");
      const topSwitch = within(header).getByRole("link", { name: label });
      expect(topSwitch).toHaveAttribute("href", "/admin");
      expect(topSwitch.className).toContain("md:inline-flex");
      const side = screen.getByRole("navigation", { name: "Customer" });
      const labels = [...side.querySelectorAll("a")].map((a) => a.textContent);
      expect(labels).not.toContain("Create an order");
      expect(labels).not.toContain("Cart");
      fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
      const drawer = await screen.findByRole("dialog", { name: "Menu" });
      const drawerSwitch = within(drawer).getByRole("link", { name: label });
      expect(drawerSwitch).toHaveAttribute("href", "/admin");
      // First thing in the drawer panel, before the section navigation.
      const firstNav = within(drawer).getAllByRole("navigation")[0];
      expect(drawerSwitch.compareDocumentPosition(firstNav!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.keyDown(drawer, { key: "Escape" });
      const menu = await openAccountMenu();
      expect(within(menu).getByRole("menuitem", { name: label })).toHaveAttribute("href", "/admin");
      expect(within(menu).queryByRole("menuitem", { name: "Console" })).toBeNull();
      await expectNoAxeViolations(container);
    });
  }

  it("customer shell for a customer: no notice and no portal switch", async () => {
    const { container } = renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Page</h1>
      </CustomerShell>,
      { path: "/", api: fakeAuthApi({ bootstrap: () => Promise.resolve({ features: {} }) }) },
    );
    expect(screen.queryByTestId("staff-portal-notice")).toBeNull();
    expect(container.querySelector("[data-portal-switch]")).toBeNull();
    const menu = await openAccountMenu();
    expect(within(menu).queryByRole("menuitem", { name: /portal/i })).toBeNull();
  });

  it("console shell: visible Customer portal switch (top bar and drawer) records the tab choice; avatar entry renamed", async () => {
    clearCustomerPortalChoice();
    const { container } = renderUi(
      <ConsoleShell user={user("admin")}>
        <h1>Page</h1>
      </ConsoleShell>,
      { path: "/admin" },
    );
    const header = screen.getByRole("banner");
    const topSwitch = within(header).getByRole("link", { name: "Customer portal" });
    expect(topSwitch).toHaveAttribute("href", "/");
    fireEvent.click(screen.getByRole("button", { name: "Open console navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Console navigation" });
    const drawerSwitch = within(drawer).getByRole("link", { name: "Customer portal" });
    expect(drawerSwitch).toHaveAttribute("href", "/");
    expect(drawerSwitch.compareDocumentPosition(within(drawer).getAllByRole("navigation")[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(drawer, { key: "Escape" });
    const menu = await openAccountMenu();
    expect(within(menu).getByRole("menuitem", { name: "Customer portal" })).toHaveAttribute("href", "/");
    expect(within(menu).queryByRole("menuitem", { name: "Customer view" })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(topSwitch);
    expect(readCustomerPortalChoice()).toBe(true);
    await expectNoAxeViolations(container);
    clearCustomerPortalChoice();
  });

  it("phone bottom bar uses short labels that fit at 320 px, never an ellipsis", () => {
    const tabs = customerNavSections(visibleNav(ALL_NAV, "customer", "customer")).phone.map(phoneTabLabel);
    expect(tabs.slice(0, 3)).toEqual(["Home", "Orders", "New order"]);
    for (const t of tabs) expect(t.length).toBeLessThanOrEqual(9);
    renderUi(
      <CustomerShell user={user("customer")}>
        <h1>Page</h1>
      </CustomerShell>,
      { path: "/", api: fakeAuthApi({ bootstrap: () => Promise.resolve({ features: {} }) }) },
    );
    const quick = screen.getByRole("navigation", { name: "Quick navigation" });
    const home = within(quick).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(quick.querySelector(".truncate")).toBeNull();
    for (const link of within(quick).getAllByRole("link")) expect(link.className).toContain("min-h-14");
  });

  it("navigation rails use the thin themed scrollbar", () => {
    const { container } = renderUi(
      <ConsoleShell user={user("admin")}>
        <h1>Page</h1>
      </ConsoleShell>,
      { path: "/admin" },
    );
    expect(container.querySelector("aside[aria-label='Console navigation'] .rp-nav-scroll")).not.toBeNull();
  });

  it("router: admin on / lands in the console; after choosing the customer portal it stays; sign-out state clears it", async () => {
    clearCustomerPortalChoice();
    const a = renderUi(<AppRoutes routes={ROUTES} />, { path: "/", api: fakeAuthApi({ me: async () => full("admin") }) });
    expect(await screen.findByRole("heading", { name: "Console page" })).toBeInTheDocument();
    expect(a.location.history?.at(-1)).toBe("/admin");
    a.unmount();
    setCustomerPortalChoice(true);
    renderUi(<AppRoutes routes={ROUTES} />, { path: "/", api: fakeAuthApi({ me: async () => full("admin") }) });
    expect(await screen.findByRole("heading", { name: "Home page" })).toBeInTheDocument();
    clearCustomerPortalChoice();
  });

  it("router: a session that ends clears the customer-portal choice", async () => {
    setCustomerPortalChoice(true);
    renderUi(<AppRoutes routes={ROUTES} />, { path: "/", api: fakeAuthApi({ me: unauth }) });
    expect(await screen.findByRole("heading", { name: "Sign in page" })).toBeInTheDocument();
    await waitFor(() => expect(readCustomerPortalChoice()).toBe(false));
  });
});
