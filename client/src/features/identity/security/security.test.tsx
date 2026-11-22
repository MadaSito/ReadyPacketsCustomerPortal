import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import { pageA11y } from "@/test/a11y";
import { identityFeature } from "../routes";
import { renderWithTrpc, type Fixtures } from "../testkit";
import ActiveSessionsCard from "./ActiveSessionsCard";
import ChangePasswordCard from "./ChangePasswordCard";
import SignInActivityCard from "./SignInActivityCard";

const date = new Date("2026-11-20T12:00:00.000Z");
const ids = { a: "01JD0000000000000000000101", b: "01JD0000000000000000000102", user: "01JD0000000000000000000010" };

const overview: Fixtures = {
  "identity.security.overview": () => ({
    sessions: [
      { sessionId: ids.a, current: true, createdAt: date, lastSeenAt: date, expiresAt: date, deviceSummary: "Firefox on Linux", authMethod: "local", country: "US", ipAddress: "203.0.113.7" },
      { sessionId: ids.b, current: false, createdAt: date, lastSeenAt: date, expiresAt: date, deviceSummary: "Safari on iOS", authMethod: "entra", country: null, ipAddress: null },
    ],
    activity: [
      { id: "01JD0000000000000000000201", occurredAt: date, kind: "success", authMethod: "local", country: "US", deviceSummary: "Firefox on Linux", ipAddress: "203.0.113.7", current: true },
      { id: "01JD0000000000000000000202", occurredAt: date, kind: "failure", authMethod: null, country: "GB", deviceSummary: null, ipAddress: "198.51.100.4", current: false },
    ],
  }),
};

const sessionRow = {
  sessionId: ids.b, createdAt: date, lastSeenAt: date, expiresAt: date, authMethod: "local", deviceSummary: "Chrome on Windows", ipAddress: "198.51.100.9", country: "CA", current: false,
  user: { publicId: ids.user, name: "Cara Customer", email: "cara@example.test", role: "customer", customerRef: "RP-ABC1234" },
};
const adminSessions: Fixtures = {
  "identity.admin.sessions.list": () => ({ items: [sessionRow], nextCursor: null }),
  "identity.admin.sessions.end": () => ({ ok: true }),
  "identity.admin.sessions.endForUser": () => ({ ended: 2 }),
  "identity.admin.sessions.endAllCustomers": () => ({ ended: 7 }),
};
const logRow = {
  id: "01JD0000000000000000000301", occurredAt: date, kind: "forced_end", reasonCode: "SECURITY_REVIEW", authMethod: "local", sessionId: ids.b,
  ipAddress: "198.51.100.9", country: "CA", deviceSummary: "Chrome on Windows",
  user: { publicId: ids.user, name: "Cara Customer", role: "customer" }, actor: { publicId: "01JD0000000000000000000001", name: "Avery Example" },
};
const signInLog: Fixtures = {
  "identity.admin.signInLog.list": () => ({ items: [logRow], nextCursor: null }),
  "identity.admin.signInLog.export": () => ({ csv: "a,b\r\n1,2", rows: 1, truncated: false }),
};
const restrictionsView = {
  enabled: false, maxConcurrentPerUser: null, idleMinutes: { customer: null, staff: null, admin: null }, absoluteHours: { customer: null, staff: null, admin: null },
  consoleIpAllowList: ["203.0.113.0/24"], countryMode: "off", countryScope: "all", countries: [], allowUnknownCountry: true, version: 1, updatedBy: null, updatedAt: null,
  breakGlassActive: false, yourAddress: "203.0.113.7", yourCountry: "US", yourAdmission: null,
};
const restrictions: Fixtures = {
  "identity.admin.restrictions.get": () => restrictionsView,
  "identity.admin.restrictions.update": (input) => ({ ...restrictionsView, ...(input as object), version: 2 }),
};

const page = (path: string, fixtures: Fixtures, role: "customer" | "staff" | "admin" = "admin") =>
  renderWithTrpc(<AppRoutes routes={identityFeature.routes} />, fixtures, { path, role });

pageA11y("/admin/sessions ready", async () => {
  page("/admin/sessions", adminSessions);
  await screen.findByRole("heading", { level: 1, name: "Session centre" });
  await screen.findAllByText("Cara Customer");
});
pageA11y("/admin/sign-in-log ready", async () => {
  page("/admin/sign-in-log", signInLog);
  await screen.findByRole("heading", { level: 1, name: "Sign-in log" });
  await screen.findAllByText("Cara Customer");
});
pageA11y("/admin/session-restrictions ready", async () => {
  page("/admin/session-restrictions", restrictions);
  await screen.findByRole("heading", { level: 1, name: "Session restrictions" });
  await screen.findByText("203.0.113.7");
});

describe("Security page cards", () => {
  it("contributes password, sessions and activity cards in order for customers", () => {
    expect(identityFeature.securityCards?.map((c) => [c.key, c.order, c.access])).toEqual([
      ["password", 10, "customer"], ["sessions", 30, "customer"], ["sign-in-activity", 40, "customer"],
    ]);
  });

  it("each card is its own labelled region with an h2", async () => {
    renderWithTrpc(<><ChangePasswordCard /><ActiveSessionsCard /><SignInActivityCard /></>, overview, { role: "customer" });
    for (const name of ["Password", "Where you're signed in", "Recent sign-in activity"]) {
      const region = await screen.findByRole("region", { name });
      expect(within(region).getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("validates the password client-side before calling the server", async () => {
    const { calls } = renderWithTrpc(<ChangePasswordCard />, {}, { role: "customer" });
    await userEvent.type(screen.getByLabelText(/^Current password/), "old passphrase here");
    await userEvent.type(screen.getByLabelText(/^New password/), "too short");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/^Use at least \d+ characters\.$/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("lists sessions with method and place, and signs out all others after confirmation", async () => {
    const { calls } = renderWithTrpc(<ActiveSessionsCard />, { ...overview, "identity.sessions.revokeOthers": () => ({ revoked: 1 }) }, { role: "customer" });
    const list = await screen.findByRole("list", { name: "Active sessions" });
    expect(within(list).getByText("This device")).toBeInTheDocument();
    expect(within(list).getByText(/Password · US · 203\.0\.113\.7/)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Sign out Safari on iOS" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out all others" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign out others" }));
    await waitFor(() => expect(calls.some((c) => c.path === "identity.sessions.revokeOthers")).toBe(true));
  });

  it("shows recent activity in words, not colour alone", async () => {
    renderWithTrpc(<SignInActivityCard />, overview, { role: "customer" });
    const list = await screen.findByRole("list", { name: "Sign-in events, newest first" });
    expect(within(list).getByText("Signed in")).toBeInTheDocument();
    expect(within(list).getByText("Failed sign-in")).toBeInTheDocument();
    expect(within(list).getByText("This session")).toBeInTheDocument();
  });

  it("shows an error state with retry when the overview fails", async () => {
    renderWithTrpc(<SignInActivityCard />, { "identity.security.overview": () => { throw { safe: { domainCode: "INTERNAL", reasonCode: "INTERNAL", safeMessage: "Something went wrong.", requestId: "r1" } }; } }, { role: "customer" });
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
  });
});

describe("Session centre", () => {
  it("ends all customer sessions only after typed confirmation and a reason", async () => {
    const { calls } = page("/admin/sessions", adminSessions);
    await screen.findAllByText("Cara Customer");
    await userEvent.click(screen.getByRole("button", { name: "Sign out all customers" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Sign out all customers" });
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText(/Reason/), "SUSPECTED_COMPROMISE");
    await userEvent.type(within(dialog).getByRole("textbox"), "SIGN OUT CUSTOMERS");
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.path === "identity.admin.sessions.endAllCustomers")?.input).toEqual({ reasonCode: "SUSPECTED_COMPROMISE" }));
  });

  it.each(["customer", "staff"] as const)("%s is refused the console route (admin-only capability)", async (role) => {
    const { calls } = page("/admin/sessions", adminSessions, role);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Session centre" })).toBeNull());
    expect(calls.some((c) => c.path === "identity.admin.sessions.list")).toBe(false);
  });

  it("filters by role and country", async () => {
    const { calls } = page("/admin/sessions", adminSessions);
    await screen.findAllByText("Cara Customer");
    await userEvent.selectOptions(screen.getAllByLabelText(/^Role/)[0]!, "staff");
    await waitFor(() => expect(calls.some((c) => (c.input as { role?: string } | undefined)?.role === "staff")).toBe(true));
  });
});

describe("Sign-in log", () => {
  it("lists events with the reason and who ended the session", async () => {
    page("/admin/sign-in-log", signInLog);
    const table = await screen.findByRole("table", { name: "Sign-in events, newest first" });
    expect(within(table).getAllByText("Session ended").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("SECURITY_REVIEW").length).toBeGreaterThan(0);
  });

  it("searches by full IP address", async () => {
    const { calls } = page("/admin/sign-in-log", signInLog);
    await screen.findAllByText("Cara Customer");
    await userEvent.type(screen.getAllByLabelText(/^IP address/)[0]!, "198.51.100.9{Enter}");
    await waitFor(() => expect(calls.some((c) => (c.input as { ip?: string } | undefined)?.ip === "198.51.100.9")).toBe(true));
  });

  it("exports through step-up and offers the CSV as a download", async () => {
    const { calls } = page("/admin/sign-in-log", signInLog);
    await screen.findAllByText("Cara Customer");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(calls.some((c) => c.path === "identity.admin.signInLog.export")).toBe(true));
  });
});

describe("Session restrictions", () => {
  it("shows the viewer's address and saves with the expected version", async () => {
    const { calls } = page("/admin/session-restrictions", restrictions);
    await screen.findByText("203.0.113.7");
    await userEvent.click(screen.getByRole("switch", { name: /Enforce session restrictions/ }));
    await userEvent.type(screen.getByLabelText(/Maximum sessions per person/), "3");
    await userEvent.click(screen.getByRole("button", { name: "Save restrictions" }));
    await waitFor(() => {
      const input = calls.find((c) => c.path === "identity.admin.restrictions.update")?.input as { expectedVersion: number; enabled: boolean; maxConcurrentPerUser: number } | undefined;
      expect(input).toMatchObject({ expectedVersion: 1, enabled: true, maxConcurrentPerUser: 3 });
    });
  });

  it("refuses out-of-range values before calling the server", async () => {
    const { calls } = page("/admin/session-restrictions", restrictions);
    await screen.findByText("203.0.113.7");
    await userEvent.type(screen.getByLabelText(/Customer idle timeout/), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save restrictions" }));
    expect(await screen.findByText(/Use 5 to 240 minutes/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "identity.admin.restrictions.update")).toBe(false);
  });

  it("explains a lock-out refusal from the server", async () => {
    page("/admin/session-restrictions", {
      ...restrictions,
      "identity.admin.restrictions.update": () => { throw { safe: { domainCode: "CONFLICT", reasonCode: "WOULD_LOCK_OUT", safeMessage: "These settings would block your current address.", requestId: "r2" } }; },
    });
    await screen.findByText("203.0.113.7");
    await userEvent.click(screen.getByRole("button", { name: "Save restrictions" }));
    expect(await screen.findByText("These settings would block your current address.")).toBeInTheDocument();
  });
});
