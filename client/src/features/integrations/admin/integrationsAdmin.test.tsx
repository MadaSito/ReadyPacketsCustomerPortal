import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { integrationsAdminNav, integrationsAdminRoutes } from "./index";
import AnalyticsPage, { ENABLE_CONFIRM_TEXT } from "./pages/AnalyticsPage";
import EgressPage from "./pages/EgressPage";
import IntegrationsOverviewPage from "./pages/IntegrationsOverviewPage";
import SmtpPage from "./pages/SmtpPage";
import { providerStatus } from "./shared";

const date = new Date("2026-11-20T12:00:00.000Z");

function me(): MeResult {
  return {
    user: { publicId: "01JD0000000000000000000001", role: "admin", name: "Avery Example", email: "avery@example.test", customerRef: null, status: "active" },
    state: "full", pendingSteps: [], nextStep: null,
  } as MeResult;
}

function renderPage(page: ReactElement, records: Record<string, (input: unknown) => unknown>) {
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
  const rendered = renderUi(page, {
    api: fakeAuthApi({ me: async () => me() }), queryClient,
    wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider>,
  });
  return { ...rendered, calls };
}

const providers = [
  { key: "smtp", name: "E-mail (SMTP)", state: "configured", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Saved; no test has succeeded yet." },
  { key: "clarity", name: "Microsoft Clarity", state: "not_configured", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "No project ID saved." },
  { key: "posthog", name: "PostHog", state: "configured", verified: true, scaffoldOnly: false, lastCheckedAt: date, summary: "Sending page views." },
  { key: "stripe", name: "Stripe", state: "disabled", verified: false, scaffoldOnly: true, lastCheckedAt: null, summary: "Scaffold." },
  { key: "saml", name: "SAML single sign-on", state: "disabled", verified: false, scaffoldOnly: true, lastCheckedAt: null, summary: "Scaffold." },
  { key: "sharepoint", name: "SharePoint", state: "disabled", verified: false, scaffoldOnly: true, lastCheckedAt: null, summary: "Scaffold." },
];

const scaffolds = {
  "integrations.admin.stripe.get": () => ({
    enabled: false, availableInRelease: false, releaseBanner: "Not available in this release — card payments are not taken.", configured: false, verified: false,
    state: "disabled", summary: "Scaffold", publishableKey: "", secretKeyConfigured: false, webhookSecretConfigured: false, webhookToleranceSeconds: 300,
    webhookPath: "/api/integrations/webhooks/stripe", lastCheckedAt: null, verificationNote: "Webhook signatures will be verified.",
  }),
  "integrations.admin.saml.get": () => ({
    state: "disabled", availableInRelease: false, releaseBanner: "Not available in this release — local sign-in with MFA is the only active method",
    metadata: { idpEntityId: "", idpSsoUrl: "", spEntityId: "", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" },
    securityRequirements: ["Signed assertions required"],
  }),
  "integrations.admin.sharepoint.get": () => ({ state: "disabled", availableInRelease: false, summary: "Not available in this release.", targetRequirements: ["Least-privilege Graph scopes"] }),
};

const smtpConfig = {
  enabled: true, configured: true, verified: false, state: "configured", summary: "Saved; no test has succeeded yet.", host: "smtp.example.test", port: 587,
  tlsMode: "starttls", username: "relay-user", passwordConfigured: true, fromAddress: "noreply@example.test", fromName: "ReadyPackets",
  replyToAddress: "", lastCheckedAt: null, lastOutcome: null,
};

const analyticsConfig = {
  clarity: { enabled: false, configured: false, projectId: "" },
  posthog: { enabled: false, configured: false, projectKey: "", host: "", cloudHosts: ["https://us.i.posthog.com", "https://eu.i.posthog.com"], allowedSelfHostedOrigins: [] },
  allowedPaths: ["/privacy", "/terms"], permanentlyExcludedPrefixes: ["/login", "/account", "/admin", "/orders"],
  verificationNote: "Loads only on allowlisted public pages after consent.",
};

describe("integrations console registration", () => {
  it("exports four admin routes guarded by integrations.manage and one Platform nav entry", () => {
    expect(integrationsAdminRoutes.map((r) => r.path)).toEqual(["/admin/integrations", "/admin/integrations/smtp", "/admin/integrations/analytics", "/admin/integrations/egress"]);
    for (const r of integrationsAdminRoutes) expect(r).toMatchObject({ access: "admin", capability: "integrations.manage" });
    expect(integrationsAdminNav).toHaveLength(1);
    expect(integrationsAdminNav[0]).toMatchObject({ href: "/admin/integrations", area: "console", group: "Platform", access: "admin", capability: "integrations.manage" });
  });

  it("never labels an unverified, failing or scaffold integration as plainly Configured", () => {
    expect(providerStatus({ state: "configured", verified: true }).label).toBe("Configured");
    expect(providerStatus({ state: "configured", verified: false }).label).toBe("Configured — not yet verified");
    expect(providerStatus({ state: "configured", verified: true, scaffoldOnly: true }).label).toBe("Not available in this release");
    expect(providerStatus({ state: "not_configured" }).label).toBe("Not configured");
    expect(providerStatus({ state: "failing" }).tone).toBe("danger");
  });
});

describe("Integrations overview", () => {
  it("shows one card per integration with truthful status and the release banners", async () => {
    const { container } = renderPage(<IntegrationsOverviewPage />, { "integrations.admin.providers": () => providers, ...scaffolds });
    expect(await screen.findByRole("heading", { level: 1, name: "Integrations" })).toBeInTheDocument();
    const card = async (name: string) => (await screen.findByRole("heading", { level: 2, name })).closest("article") as HTMLElement;
    expect(within(await card("E-mail (SMTP)")).getByText("Configured — not yet verified")).toBeInTheDocument();
    expect(within(await card("Microsoft Clarity")).getByText("Not configured")).toBeInTheDocument();
    expect(within(await card("PostHog")).getByText("Configured")).toBeInTheDocument();
    for (const name of ["Stripe", "SAML single sign-on", "SharePoint"]) {
      const c = await card(name);
      await waitFor(() => expect(within(c).getAllByText("Not available in this release").length).toBeGreaterThan(0));
      expect(within(c).queryByRole("link")).toBeNull();
    }
    expect(within(await card("SAML single sign-on")).getByText(/local sign-in with MFA is the only active method/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Configure e-mail/ })).toHaveAttribute("href", "/admin/integrations/smtp");
    expect(screen.getByRole("link", { name: "Review allowlist" })).toHaveAttribute("href", "/admin/integrations/egress");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    await expectNoAxeViolations(container);
  });
});

describe("SMTP settings", () => {
  it("keeps the password write-only: never prefilled, omitted when unchanged, null when removed", async () => {
    const { container, calls } = renderPage(<SmtpPage />, {
      "integrations.admin.smtp.get": () => smtpConfig,
      "integrations.admin.providers": () => providers,
      "integrations.admin.smtp.update": () => smtpConfig,
    });
    expect(await screen.findByRole("heading", { level: 1, name: "E-mail (SMTP)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Integrations" })).toHaveAttribute("href", "/admin/integrations");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const password = await screen.findByLabelText(/^Password/);
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByText(/A password is stored\. It is never shown/)).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.some((c) => c.path === "integrations.admin.smtp.update")).toBe(true));
    const first = calls.find((c) => c.path === "integrations.admin.smtp.update")!.input as Record<string, unknown>;
    expect(first).not.toHaveProperty("password");
    expect(first).toMatchObject({ host: "smtp.example.test", port: 587, tlsMode: "starttls" });

    await userEvent.click(await screen.findByRole("checkbox", { name: /Remove the stored password/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "integrations.admin.smtp.update")).toHaveLength(2));
    expect((calls.filter((c) => c.path === "integrations.admin.smtp.update")[1]!.input as Record<string, unknown>).password).toBeNull();
  });

  it("refuses port 25 before calling the server and reports a test-message result honestly", async () => {
    const { calls } = renderPage(<SmtpPage />, {
      "integrations.admin.smtp.get": () => smtpConfig,
      "integrations.admin.smtp.sendTest": () => ({ outcome: "unknown", reasonCode: "SMTP_TIMEOUT", safeMessage: "The relay did not answer in time.", durationMs: 5000, checkedAt: date }),
    });
    const port = await screen.findByLabelText(/^Port/);
    await userEvent.clear(port);
    await userEvent.type(port, "25");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Port 25 is not allowed/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "integrations.admin.smtp.update")).toBe(false);

    await userEvent.type(screen.getByLabelText(/^Send to/), "ops@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(await screen.findByText("Result unknown — the relay did not confirm")).toBeInTheDocument();
    expect(screen.getByText("The relay did not answer in time.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "integrations.admin.smtp.sendTest")?.input).toEqual({ toAddress: "ops@example.test" });
  });
});

describe("Analytics settings", () => {
  it("validates identifiers, previews the consent banner and saves only public ids", async () => {
    const { container, calls } = renderPage(<AnalyticsPage />, {
      "integrations.admin.analytics.get": () => analyticsConfig,
      "integrations.admin.providers": () => providers,
      "integrations.admin.analytics.update": () => analyticsConfig,
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeInTheDocument();
    expect(await screen.findByText("Optional public-page analytics")).toBeInTheDocument();
    expect(screen.getByText("/privacy")).toBeInTheDocument();
    expect(screen.getByText("/admin")).toBeInTheDocument();
    const warning = screen.getByText("Security risk: analytics runs on the portal's own origin");
    expect(warning.compareDocumentPosition(screen.getByRole("switch", { name: /Enable Microsoft Clarity/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/Leave these off unless your organisation has accepted this risk/).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);

    await userEvent.type(screen.getByLabelText(/Clarity project ID/), "bad id!");
    await userEvent.click(screen.getByRole("switch", { name: /Enable Microsoft Clarity/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save analytics settings" }));
    expect(await screen.findByText(/6–32 letters and digits, as shown in Clarity/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "integrations.admin.analytics.update")).toBe(false);

    await userEvent.clear(screen.getByLabelText(/Clarity project ID/));
    await userEvent.type(screen.getByLabelText(/Clarity project ID/), "abc123xyz");
    await userEvent.type(screen.getByLabelText(/Project API key/), "phx_personal");
    await userEvent.click(screen.getByRole("switch", { name: /Enable PostHog/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save analytics settings" }));
    expect(await screen.findByText(/starts with phc_/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/Project API key/));
    await userEvent.type(screen.getByLabelText(/Project API key/), "phc_abcdefghijkl1234");
    expect(screen.getByText(/May we enable Microsoft Clarity and PostHog/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save analytics settings" }));

    // Switching a vendor on needs a typed risk acknowledgement before anything reaches the server (INT-01).
    const confirm = await screen.findByRole("alertdialog", { name: "Enable analytics on the portal origin?" });
    expect(within(confirm).getByText(/could make requests with a visitor's session/)).toBeInTheDocument();
    const accept = within(confirm).getByRole("button", { name: "Accept risk and enable" });
    expect(accept).toBeDisabled();
    await expectNoAxeViolations(document.body);
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), "enable");
    expect(accept).toBeDisabled();
    expect(calls.some((c) => c.path === "integrations.admin.analytics.update")).toBe(false);
    await userEvent.clear(within(confirm).getByLabelText(/to confirm/));
    await userEvent.type(within(confirm).getByLabelText(/to confirm/), ENABLE_CONFIRM_TEXT);
    await userEvent.click(accept);
    await waitFor(() => expect(calls.some((c) => c.path === "integrations.admin.analytics.update")).toBe(true));
    expect(calls.find((c) => c.path === "integrations.admin.analytics.update")!.input).toEqual({
      clarityEnabled: true, clarityProjectId: "abc123xyz", posthogEnabled: true, posthogProjectKey: "phc_abcdefghijkl1234", posthogHost: "https://us.i.posthog.com",
    });
  });
});

describe("Analytics risk acknowledgement", () => {
  it("does not ask again when vendors are already on or being switched off", async () => {
    const enabled = { ...analyticsConfig, clarity: { enabled: true, configured: true, projectId: "abc123xyz" } };
    const { calls } = renderPage(<AnalyticsPage />, {
      "integrations.admin.analytics.get": () => enabled,
      "integrations.admin.providers": () => providers,
      "integrations.admin.analytics.update": () => analyticsConfig,
    });
    await userEvent.click(await screen.findByRole("switch", { name: /Enable Microsoft Clarity/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save analytics settings" }));
    await waitFor(() => expect(calls.find((c) => c.path === "integrations.admin.analytics.update")?.input).toMatchObject({ clarityEnabled: false }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Outbound connections", () => {
  const rule = {
    publicId: "01JD0000000000000000000090", purpose: "siem", matchType: "host", pattern: "siem.corp.example", port: 6514, protocol: "tls:",
    allowPrivateAddress: true, enabled: true, justification: "Internal SIEM collector", version: 2, createdAt: date, updatedAt: date,
  };

  it("lists rules, reads out blocked ranges, validates new rules and runs a dry-run check", async () => {
    const { container, calls } = renderPage(<EgressPage />, {
      "integrations.admin.egress.list": () => [rule],
      "integrations.admin.egress.update": () => ({ ...rule, enabled: false, version: 3 }),
      "integrations.admin.egress.check": () => ({ allowed: false, reasonCode: "EGRESS_METADATA", safeMessage: "Cloud metadata addresses are never reachable." }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Outbound connections" })).toBeInTheDocument();
    expect((await screen.findAllByText("siem.corp.example:6514")).length).toBeGreaterThan(0);
    expect(screen.getByText("Cloud metadata")).toBeInTheDocument();
    expect(screen.getByText(/169\.254\.169\.254/)).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getAllByRole("button", { name: "Actions for siem.corp.example" })[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Switch off" }));
    await waitFor(() => expect(calls.find((c) => c.path === "integrations.admin.egress.update")?.input).toEqual({ publicId: rule.publicId, expectedVersion: 2, enabled: false }));

    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add rule" }));
    expect(await within(dialog).findByText(/Explain why this connection is needed/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "integrations.admin.egress.create")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.type(screen.getByLabelText(/^Destination/), "http://169.254.169.254/latest");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Connection would be refused")).toBeInTheDocument();
    expect(screen.getByText("Cloud metadata addresses are never reachable.")).toBeInTheDocument();
  });
});
