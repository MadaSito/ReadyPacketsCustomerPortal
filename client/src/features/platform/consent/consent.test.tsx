import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { AppRoutes } from "@/app/AppRouter";
import type { MeResult } from "@/lib/authApi";
import { CONSENT_STORAGE_KEY, __resetConsentForTests, __setConsentForTests, __storageForTests, consent } from "@/lib/consent";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, fakeAuthApi, renderUi } from "@/ui/testing";
import { platformFeature } from "../routes";
import { CookieConsent } from "./CookieConsent";

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
  constructor(readonly code: string, readonly httpStatus: number, readonly safe?: Record<string, unknown>) {}
}
const date = new Date("2026-11-20T12:00:00.000Z");
const RECEIPT = `${"B".repeat(22)}.${"a".repeat(32)}`;
const NONE = { preferences: false, analytics: false, session_replay: false };

const inventory = {
  enabled: true,
  policyVersion: 1,
  renewMonths: 12,
  categories: [
    { key: "necessary", label: "Necessary", description: "Sign-in and security." },
    { key: "preferences", label: "Preferences", description: "Remembers choices." },
    { key: "analytics", label: "Analytics", description: "Measures use with PostHog." },
    { key: "session_replay", label: "Session replay", description: "Microsoft Clarity recordings." },
  ],
  items: [
    { id: "session", name: "__Host-rp_session", provider: "ReadyPackets", category: "necessary", storage: "cookie", firstParty: true, purpose: "Keeps you signed in.", duration: "Session" },
    { id: "clck", name: "_clck", provider: "Microsoft Clarity", category: "session_replay", storage: "cookie", firstParty: true, purpose: "Clarity user id.", duration: "1 year" },
  ],
};

function me(role: "customer" | "admin"): MeResult {
  return { user: { publicId: "usr_1", role, name: "Avery Example", email: "a@example.test", status: "active" }, state: "full", pendingSteps: [], nextStep: null };
}

function renderWith(ui: ReactElement, records: Record<string, Handler>, options: { path?: string; role?: "customer" | "admin"; calls?: { path: string; input: unknown }[] } = {}) {
  const calls = options.calls ?? [];
  const queryClient = createTestQueryClient();
  const handlers: Record<string, Handler> = {
    "platform.bootstrap": () => ({ features: { "privacy.consent": true }, consent: { enabled: true, policyVersion: 1, renewMonths: 12 } }),
    "platform.consent.inventory": () => inventory,
    ...records,
  };
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "https://portal.example.test/rpc",
        transformer: superjson,
        fetch: async (request, init) => {
          const url = new URL(String(request));
          const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as Record<string, Parameters<typeof superjson.deserialize>[0]>;
          const paths = url.pathname.slice("/rpc/".length).split(",");
          const result = await Promise.all(paths.map(async (path, index) => {
            const respond = handlers[path];
            if (!respond) throw new Error(`Unexpected test request: ${path}`);
            const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
            calls.push({ path, input });
            const value = await respond(input);
            if (value instanceof Refuse) return { error: superjson.serialize({ message: "Refused", code: -32603, data: { code: value.code, httpStatus: value.httpStatus, ...(value.safe ? { safe: value.safe } : {}) } }) };
            return { result: { data: superjson.serialize(value) } };
          }));
          return Response.json(result, { status: result.some((r) => "error" in r) ? 207 : 200 });
        },
      }),
    ],
  });
  const role = options.role;
  return renderUi(ui, {
    queryClient,
    ...(options.path ? { path: options.path } : {}),
    ...(role ? { api: fakeAuthApi({ me: async () => me(role) }) } : {}),
    wrapper: (node) => (
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {node}
      </TRPCProvider>
    ),
  });
}

const recorded = () => ({ consentId: "B".repeat(22), receipt: RECEIPT, recordedAt: date, policyVersion: 1 });

beforeEach(() => __resetConsentForTests());
afterEach(() => {
  __resetConsentForTests();
  vi.unstubAllGlobals();
});

const pageRecords: Record<string, Handler> = {
  "platform.consent.mine": () => [{ publicId: "r1", consentId: "B".repeat(22), userPublicId: "usr_1", policyVersion: 1, choices: NONE, action: "reject_all", source: "banner", gpc: false, createdAt: date }],
};
const adminRecords: Record<string, Handler> = {
  "platform.admin.consent.stats": () => ({ days: 30, total: 12, byAction: { accept_all: 4, reject_all: 6, save: 2, withdraw: 0 }, bySource: { banner: 10, preferences: 2, account: 0, gpc: 1 }, acceptance: { preferences: 0.5, analytics: 0.4, session_replay: 0.25 }, gpc: 1, byPolicyVersion: [{ policyVersion: 1, total: 12 }] }),
  "platform.admin.settings.list": () => [
    { key: "privacy.consent.policy_version", kind: "value", group: "privacy", owner: "platform", label: "Cookie policy version", description: "Raise it to ask again.", sensitivity: "public", exportable: true, version: 1, updatedAt: date, value: 1, defaultValue: 1, configured: true },
  ],
  "platform.admin.consent.search": () => ({ items: [{ publicId: "r1", consentId: "B".repeat(22), userPublicId: null, policyVersion: 1, choices: NONE, action: "reject_all", source: "gpc", gpc: true, createdAt: date }], nextCursor: null }),
};

pageA11y("/account/privacy ready", async () => {
  renderWith(<AppRoutes routes={platformFeature.routes} />, pageRecords, { path: "/account/privacy", role: "customer" });
  await screen.findByRole("heading", { level: 1, name: "Privacy and cookies" });
  await screen.findByText("Rejected all");
});

pageA11y("/admin/privacy ready", async () => {
  renderWith(<AppRoutes routes={platformFeature.routes} />, adminRecords, { path: "/admin/privacy", role: "admin" });
  await screen.findByRole("heading", { level: 1, name: "Cookies and consent" });
  await screen.findAllByText("v1");
});

/** The banner as mounted by the layouts: first, before the page's main landmark. */
const SignInLike = () => (
  <>
    <CookieConsent />
    <main>
      <h1>Sign in</h1>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" />
    </main>
  </>
);

pageA11y("cookie banner shown", async () => {
  document.title = "Sign in · ReadyPackets";
  renderWith(<SignInLike />, {});
  await screen.findByRole("heading", { name: "Your cookie choices" });
});

pageA11y("cookie preference centre open", async () => {
  document.title = "Sign in · ReadyPackets";
  renderWith(<SignInLike />, {});
  await userEvent.click(await screen.findByRole("button", { name: "Manage choices" }));
  await screen.findByRole("dialog", { name: "Cookie preferences" });
  await screen.findByText("Microsoft Clarity recordings.");
});

describe("cookie banner", () => {
  it("is not shown while the feature is off", async () => {
    renderWith(<CookieConsent />, { "platform.bootstrap": () => ({ features: {}, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }) });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Your cookie choices" })).not.toBeInTheDocument());
    expect(consent.has("analytics")).toBe(false);
  });

  it("comes first in tab order, does not trap focus, and the page stays usable", async () => {
    renderWith(<SignInLike />, {});
    await screen.findByRole("heading", { name: "Your cookie choices" });
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Reject all" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("offers Reject all and Accept all with the same prominence and records a rejection", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderWith(<CookieConsent />, { "platform.consent.record": recorded }, { calls });
    const reject = await screen.findByRole("button", { name: "Reject all" });
    const accept = screen.getByRole("button", { name: "Accept all" });
    expect(reject.className).toBe(accept.className);
    // Non-modal: not a dialog, nothing else is inert.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(reject);
    await waitFor(() => expect(calls.find((c) => c.path === "platform.consent.record")?.input).toMatchObject({ action: "reject_all", source: "banner", choices: NONE, policyVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Your cookie choices" })).not.toBeInTheDocument());
    expect(await screen.findByText("Cookie preferences saved")).toBeInTheDocument();
    expect(consent.snapshot().consentId).toBe("B".repeat(22));
  });

  it("grants nothing when recording an acceptance fails", async () => {
    renderWith(<CookieConsent />, { "platform.consent.record": () => new Refuse("INTERNAL_SERVER_ERROR", 500) });
    await userEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await screen.findByText(/could not be saved/);
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
  });

  it("applies a withdrawal locally even when the ledger call fails", async () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: { analytics: true, session_replay: true } });
    renderWith(<CookieConsent />, { "platform.consent.record": () => new Refuse("INTERNAL_SERVER_ERROR", 500) });
    await waitFor(() => expect(consent.enabled()).toBe(true));
    consent.openPreferences();
    const dialog = await screen.findByRole("dialog", { name: "Cookie preferences" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject all" }));
    await screen.findByText(/applies on this device/);
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
  });

  it("preference centre starts with every optional category off and saves a partial choice", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderWith(<CookieConsent />, { "platform.consent.record": recorded }, { calls });
    await userEvent.click(await screen.findByRole("button", { name: "Manage choices" }));
    const dialog = await screen.findByRole("dialog", { name: "Cookie preferences" });
    const switches = within(dialog).getAllByRole("switch");
    expect(switches).toHaveLength(3);
    for (const s of switches) expect(s).toHaveAttribute("aria-checked", "false");
    await userEvent.click(within(dialog).getByRole("switch", { name: /analytics/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(calls.find((c) => c.path === "platform.consent.record")?.input).toMatchObject({ action: "save", source: "preferences", choices: { preferences: false, analytics: true, session_replay: false } }));
    await waitFor(() => expect(consent.has("analytics")).toBe(true));
    expect(consent.has("session_replay")).toBe(false);
  });

  it("asks again when the server reports a policy change", async () => {
    renderWith(<CookieConsent />, { "platform.consent.record": () => new Refuse("CONFLICT", 409, { domainCode: "CONFLICT", reasonCode: "CONSENT_POLICY_CHANGED", safeMessage: "Changed" }) });
    await userEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await screen.findByText(/policy has changed/);
    expect(consent.has("analytics")).toBe(false);
  });

  it("treats Global Privacy Control as a rejection without showing the banner", async () => {
    vi.stubGlobal("navigator", { ...navigator, globalPrivacyControl: true });
    const calls: { path: string; input: unknown }[] = [];
    renderWith(<CookieConsent />, { "platform.consent.record": recorded }, { calls });
    await waitFor(() => expect(calls.find((c) => c.path === "platform.consent.record")?.input).toMatchObject({ action: "reject_all", source: "gpc", gpc: true }));
    expect(screen.queryByRole("heading", { name: "Your cookie choices" })).not.toBeInTheDocument();
    expect(consent.snapshot().bySignal).toBe(true);
  });

  it("a delayed acceptance never restores a choice withdrawn meanwhile in another tab", async () => {
    let release: (v: unknown) => void = () => {};
    const calls: { path: string; input: unknown }[] = [];
    renderWith(<CookieConsent />, { "platform.consent.record": () => new Promise((r) => (release = r)) }, { calls });
    await userEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(calls.some((c) => c.path === "platform.consent.record")).toBe(true));
    // Another tab withdraws; its storage event has not arrived yet.
    __storageForTests().setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: 1, receipt: RECEIPT, policyVersion: 1, choices: NONE, decidedAt: new Date().toISOString(), bySignal: false }));
    release(recorded());
    await screen.findByText(/newer cookie choice/);
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
  });

  it("a mixed save that fails removes the withdrawn category and grants nothing new", async () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: { analytics: true } });
    renderWith(<CookieConsent />, { "platform.consent.record": () => new Refuse("INTERNAL_SERVER_ERROR", 500) });
    await waitFor(() => expect(consent.enabled()).toBe(true));
    consent.openPreferences();
    const dialog = await screen.findByRole("dialog", { name: "Cookie preferences" });
    await userEvent.click(within(dialog).getByRole("switch", { name: /analytics/i }));
    await userEvent.click(within(dialog).getByRole("switch", { name: /session replay/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save choices" }));
    await screen.findByText(/applies on this device/);
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
  });
});
