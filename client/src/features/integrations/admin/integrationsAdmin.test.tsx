import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { ALL_ROUTES } from "@/app/registry";
import { RouteFocus } from "@/app/RouteFocus";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { integrationsAdminNav, integrationsAdminRoutes } from "./index";
import AnalyticsPage, { ENABLE_CONFIRM_TEXT } from "./pages/AnalyticsPage";
import EgressPage from "./pages/EgressPage";
import GraphMailPage from "./pages/GraphMailPage";
import IntegrationsOverviewPage from "./pages/IntegrationsOverviewPage";
import SmtpPage from "./pages/SmtpPage";
import { providerStatus } from "./shared";

const date = new Date("2026-11-20T12:00:00.000Z");

function me(): MeResult {
  return {
    user: {
      publicId: "01JD0000000000000000000001",
      role: "admin",
      capabilities: ["integrations.manage"],
      name: "Avery Example",
      email: "avery@example.test",
      customerRef: null,
      status: "active",
    },
    state: "full", pendingSteps: [], nextStep: null,
  } as MeResult;
}

function renderPage(
  page: ReactElement,
  records: Record<string, (input: unknown) => unknown>,
  path?: string,
) {
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
        const result = paths.map((p, index) => {
          const respond = records[p];
          if (!respond) throw new Error(`Unexpected test request: ${p}`);
          const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
          calls.push({ path: p, input });
          return { result: { data: superjson.serialize(respond(input)) } };
        });
        return Response.json(result);
      },
    })],
  });
  const rendered = renderUi(page, {
    ...(path ? { path } : {}),
    api: fakeAuthApi({ me: async () => me() }), queryClient,
    wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider>,
  });
  return { ...rendered, calls };
}

const providers = [
  { key: "smtp", name: "E-mail (SMTP)", state: "configured", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Saved; no test has succeeded yet." },
  { key: "graph", name: "Microsoft Graph Mail & Cloud", state: "not_configured", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Not configured." },
  { key: "clarity", name: "Microsoft Clarity", state: "not_configured", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "No project ID saved." },
  { key: "posthog", name: "PostHog", state: "configured", verified: true, scaffoldOnly: false, lastCheckedAt: date, summary: "Sending page views." },
  { key: "stripe", name: "Stripe Payments", state: "disabled", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Stripe credentials are staged in Payment Setup, with Stripe online checkout switched off." },
  { key: "saml", name: "Enterprise SAML 2.0 SSO", state: "disabled", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Configure SAML 2.0 and Microsoft Entra single sign-on in Single Sign-On settings." },
  { key: "sharepoint", name: "Microsoft 365 / SharePoint Sync", state: "disabled", verified: false, scaffoldOnly: false, lastCheckedAt: null, summary: "Microsoft 365 SharePoint & OneDrive sync is switched off." },
];

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
  it("exports five admin routes guarded by integrations.manage and one Platform nav entry", () => {
    expect(integrationsAdminRoutes.map((r) => r.path)).toEqual([
      "/admin/integrations",
      "/admin/integrations/smtp",
      "/admin/integrations/graph",
      "/admin/integrations/analytics",
      "/admin/integrations/egress",
    ]);
    for (const r of integrationsAdminRoutes) expect(r).toMatchObject({ access: "admin", capability: "integrations.manage" });
    expect(integrationsAdminNav).toHaveLength(1);
    expect(integrationsAdminNav[0]).toMatchObject({ href: "/admin/integrations", area: "console", group: "Platform", access: "admin", capability: "integrations.manage" });
  });

  it("never labels an unverified, failing or scaffold integration as plainly Configured", () => {
    expect(providerStatus({ state: "configured", verified: true }).label).toBe("Configured");
    expect(providerStatus({ state: "configured", verified: false }).label).toBe("Configured — not yet verified");
    expect(providerStatus({ state: "configured", verified: true, scaffoldOnly: true }).label).toBe("Not available in this release");
    expect(providerStatus({ state: "disabled" }).label).toBe("Switched off");
    expect(providerStatus({ state: "not_configured" }).label).toBe("Not configured");
    expect(providerStatus({ state: "failing" }).tone).toBe("danger");
  });
});

describe("Integrations overview", () => {
  pageA11y("/admin/integrations ready", async () => {
    renderPage(
      <main id="main">
        <IntegrationsOverviewPage />
        <RouteFocus title="Integrations" path="/admin/integrations" />
      </main>,
      { "integrations.admin.providers": () => providers },
      "/admin/integrations",
    );
    await screen.findByRole("heading", { level: 1, name: "Integrations" });
    await screen.findByRole("heading", { name: "Microsoft Graph Mail & Cloud" });
  });

  it("shows truthful live status cards and configuration links without dead scaffold banners", async () => {
    const { container } = renderPage(<IntegrationsOverviewPage />, { "integrations.admin.providers": () => providers });
    expect(await screen.findByRole("heading", { level: 1, name: "Integrations" })).toBeInTheDocument();
    const card = async (name: string) => (await screen.findByRole("heading", { level: 2, name })).closest("article") as HTMLElement;
    expect(within(await card("E-mail (SMTP)")).getByText("Configured — not yet verified")).toBeInTheDocument();
    expect(within(await card("Microsoft Clarity")).getByText("Not configured")).toBeInTheDocument();
    expect(within(await card("PostHog")).getByText("Configured")).toBeInTheDocument();

    const stripeCard = await card("Stripe Payments");
    expect(within(stripeCard).queryByText("Not available in this release")).toBeNull();
    expect(within(stripeCard).getByText("Switched off")).toBeInTheDocument();
    expect(within(stripeCard).queryByText("Not configured (switched off)")).toBeNull();
    expect(within(stripeCard).getByRole("link", { name: /Payment setup/ })).toHaveAttribute("href", "/admin/payments/setup");

    const spCard = await card("Microsoft 365 / SharePoint Sync");
    expect(within(spCard).queryByText("Not available in this release")).toBeNull();
    expect(within(spCard).getByRole("link", { name: /Configure storage/ })).toHaveAttribute("href", "/admin/storage");
    expect(within(spCard).getByRole("link", { name: /File sync/ })).toHaveAttribute("href", "/admin/storage/file-sync");

    const samlCard = await card("Enterprise SAML 2.0 SSO");
    expect(within(samlCard).getByRole("link", { name: /Configure single sign-on/ })).toHaveAttribute("href", "/admin/sso");

    expect(screen.getByRole("link", { name: /Configure e-mail/ })).toHaveAttribute("href", "/admin/integrations/smtp");
    expect(screen.getByRole("link", { name: "Manage production pipeline" })).toHaveAttribute("href", "/admin/integrations/production");
    expect(screen.getByRole("link", { name: "Manage webhooks" })).toHaveAttribute("href", "/admin/integrations/webhooks");
    expect(screen.getByRole("link", { name: "Review allowlist" })).toHaveAttribute("href", "/admin/integrations/egress");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it("resolves every href on the Integrations hub to a registered route in the app route table", async () => {
    renderPage(<IntegrationsOverviewPage />, { "integrations.admin.providers": () => providers });
    await screen.findByRole("heading", { level: 1, name: "Integrations" });

    const registeredPaths = new Set(ALL_ROUTES.map((route) => route.path));
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(12);

    for (const link of links) {
      const href = link.getAttribute("href");
      expect(href, `expected link "${link.textContent ?? ""}" to carry an href`).toBeTruthy();
      expect(registeredPaths.has(href!), `hub link "${link.textContent ?? ""}" -> "${href}" is not a registered route`).toBe(true);
    }
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
    expect(screen.getAllByText(/leave these off unless your organisation has accepted this risk/).length).toBeGreaterThan(0);
    expect(screen.getByText(/could make requests — reads and ordinary changes — as that visitor/)).toBeInTheDocument();
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
    expect(screen.getByText(/Visitor consent from the privacy banner controls Microsoft Clarity and PostHog/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save analytics settings" }));

    // Switching a vendor on needs a typed risk acknowledgement before anything reaches the server (INT-01).
    const confirm = await screen.findByRole("alertdialog", { name: "Enable analytics on the portal origin?" });
    expect(within(confirm).getByText(/reads and ordinary changes — as that visitor\. Actions that need re-authentication remain protected\./)).toBeInTheDocument();
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

  const presetCatalog = [
    { key: "stripe", label: "Stripe Checkout & Payments API", purpose: "stripe", parameterized: false, hosts: ["api.stripe.com"], enabled: false, matchingRulePublicIds: [] },
    { key: "microsoft_graph", label: "Microsoft Graph & Entra Token", purpose: "graph", parameterized: false, hosts: ["login.microsoftonline.com", "graph.microsoft.com"], enabled: false, matchingRulePublicIds: [] },
    { key: "microsoft_graph_upload", label: "Microsoft SharePoint & OneDrive Upload Sessions", purpose: "graph_upload", parameterized: false, hosts: ["*.sharepoint.com", "*.files.1drv.com"], enabled: false, matchingRulePublicIds: [] },
    { key: "entra_oidc", label: "Microsoft Entra ID Single Sign-On (OIDC & SAML Metadata)", purpose: "entra_oidc", parameterized: false, hosts: ["login.microsoftonline.com"], enabled: false, matchingRulePublicIds: [] },
    { key: "amazon_s3", label: "Amazon S3 Regional Endpoint", purpose: "storage_s3", parameterized: true, hosts: [], enabled: false, matchingRulePublicIds: [] },
  ];

  it("renders one-click provider preset switches, lists rules, validates new rules and runs a dry-run check", async () => {
    const { container, calls } = renderPage(<EgressPage />, {
      "integrations.admin.egress.presets": () => presetCatalog,
      "integrations.admin.egress.setPreset": (input) => {
        const typed = input as { presetKey: string; enabled: boolean };
        const found = presetCatalog.find((p) => p.key === typed.presetKey) ?? presetCatalog[0]!;
        return { ...found, enabled: typed.enabled };
      },
      "integrations.admin.egress.list": () => [rule],
      "integrations.admin.egress.update": () => ({ ...rule, enabled: false, version: 3 }),
      "integrations.admin.egress.check": () => ({ allowed: false, reasonCode: "EGRESS_METADATA", safeMessage: "Cloud metadata addresses are never reachable." }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Outbound connections" })).toBeInTheDocument();
    expect((await screen.findAllByText("siem.corp.example:6514")).length).toBeGreaterThan(0);
    expect(screen.getByText("Cloud metadata")).toBeInTheDocument();
    expect(screen.getByText(/169\.254\.169\.254/)).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Stripe Checkout & Payments API" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Microsoft Entra ID Single Sign-On (OIDC & SAML Metadata)" })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    // One-click Stripe egress preset switch
    await userEvent.click(screen.getByRole("switch", { name: "Stripe Checkout & Payments API" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "integrations.admin.egress.setPreset")?.input).toEqual({
        presetKey: "stripe",
        enabled: true,
      }),
    );

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

describe("Microsoft Graph & SharePoint readiness, write check, and runbook", () => {
  const graphConfig = {
    enabled: true,
    configured: true,
    verified: false,
    state: "configured" as const,
    summary: "Credentials saved; connection not yet verified.",
    tenantId: "00000000-0000-0000-0000-000000000011",
    clientId: "00000000-0000-0000-0000-000000000022",
    clientSecretConfigured: true,
    clientSecretLast4: "8f3d",
    senderMailbox: "noreply@contoso.example",
    egressPresetEnabled: false,
    uploadEgressPresetEnabled: true,
    egressReady: false,
    lastCheckedAt: null,
    lastOutcome: null,
    sitesSelectedLastCheckedAt: date,
    sitesSelectedLastOutcome: "succeeded" as const,
    mailboxRestrictionNote: "Scope application Mail.Send to this mailbox using an Exchange application access policy.",
  };

  const entraRunbook = {
    requiredApplicationPermission: "Sites.Selected" as const,
    discouragedBroadPermissions: ["Sites.ReadWrite.All", "Files.ReadWrite.All"],
    steps: [
      "Grant Microsoft Graph application permission Sites.Selected in Microsoft Entra ID.",
      "Assign site-scoped write role to the target SharePoint site via Graph /sites/{siteId}/permissions.",
      "Enable both Microsoft Graph & Entra Token and SharePoint Upload Session outbound presets.",
    ],
    siteGrantEndpointTemplate: "POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions",
    siteGrantPayloadExample: '{\n  "roles": ["write"],\n  "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "ReadyPackets" } }]\n}',
    powershellExample: "Grant-PnPAzureADAppSitePermission -AppId <client-id> -DisplayName ReadyPackets -Permissions Write",
    oneDriveNote: "Personal OneDrive drives do not support Sites.Selected; provision a dedicated SharePoint site library.",
  };

  pageA11y("/admin/integrations/graph ready", async () => {
    renderPage(
      <main id="main">
        <GraphMailPage />
        <RouteFocus title="Microsoft Graph & SharePoint" path="/admin/integrations/graph" />
      </main>,
      {
        "integrations.admin.graph.get": () => graphConfig,
        "integrations.admin.graph.entraRunbook": () => entraRunbook,
      },
      "/admin/integrations/graph",
    );
    await screen.findByRole("heading", { level: 1, name: "Microsoft Graph & SharePoint" });
    await screen.findByRole("heading", { name: "Entra Sites.Selected runbook" });
    await screen.findByText("Sites.Selected");
  });

  it("keeps clientSecret write-only, shows egress preset readiness, runs Sites.Selected write check, and renders Entra runbook", async () => {
    const user = userEvent.setup();
    const { container, calls } = renderPage(<GraphMailPage />, {
      "integrations.admin.graph.get": () => graphConfig,
      "integrations.admin.graph.entraRunbook": () => entraRunbook,
      "integrations.admin.graph.update": () => ({ ...graphConfig, egressPresetEnabled: true, egressReady: true }),
      "integrations.admin.graph.testConnection": () => ({
        outcome: "succeeded" as const,
        reasonCode: "GRAPH_OK",
        safeMessage: "OAuth token acquired and Graph endpoint responded.",
        durationMs: 142,
        checkedAt: date,
      }),
      "integrations.admin.graph.sendTest": () => ({
        outcome: "accepted" as const,
        reasonCode: "GRAPH_MAIL_ACCEPTED",
        safeMessage: "Accepted by Exchange Online.",
        recipientAddress: "ops@contoso.example",
        durationMs: 210,
        checkedAt: date,
      }),
      "integrations.admin.graph.verifySitesSelectedWrite": () => ({
        outcome: "succeeded" as const,
        reasonCode: "SITES_SELECTED_WRITE_OK",
        safeMessage: "Upload session created and immediately cancelled with DELETE.",
        graphEgressEnabled: true,
        uploadEgressEnabled: true,
        tokenAcquired: true,
        readVerified: true,
        writeVerified: true,
        durationMs: 318,
        checkedAt: date,
      }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Microsoft Graph & SharePoint" })).toBeInTheDocument();
    expect(await screen.findByText("Switched off")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review outbound presets/ })).toHaveAttribute("href", "/admin/integrations/egress");

    // Client secret is write-only: never prefilled, omitted when unchanged, null when cleared
    const secretInput = screen.getByLabelText(/^Client secret/);
    expect(secretInput).toHaveValue("");
    expect(secretInput).toHaveAttribute("type", "password");
    expect(screen.getByText(/ending ••••8f3d/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Also enable the Microsoft Graph & Entra Token outbound preset/ }));
    await user.click(screen.getByRole("button", { name: "Save Graph settings" }));
    await waitFor(() => expect(calls.some((c) => c.path === "integrations.admin.graph.update")).toBe(true));
    const firstUpdate = calls.find((c) => c.path === "integrations.admin.graph.update")!.input as Record<string, unknown>;
    expect(firstUpdate).not.toHaveProperty("clientSecret");
    expect(firstUpdate).toMatchObject({
      enabled: true,
      tenantId: graphConfig.tenantId,
      clientId: graphConfig.clientId,
      senderMailbox: graphConfig.senderMailbox,
      enableEgressPreset: true,
    });

    await user.click(screen.getByRole("checkbox", { name: "Remove the stored client secret" }));
    await user.click(screen.getByRole("button", { name: "Save Graph settings" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "integrations.admin.graph.update")).toHaveLength(2));
    expect((calls.filter((c) => c.path === "integrations.admin.graph.update")[1]!.input as Record<string, unknown>).clientSecret).toBeNull();

    // Connection check + test mail
    await user.click(screen.getByRole("button", { name: "Test Graph connection" }));
    expect(await screen.findByText("Graph connection verified")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Send test mail to/), "ops@contoso.example");
    await user.click(screen.getByRole("button", { name: "Send test message" }));
    expect(await screen.findByText("Microsoft Graph accepted the test message")).toBeInTheDocument();

    // Sites.Selected write check: blank optional inputs omitted so min(3) schema passes
    await user.click(screen.getByRole("button", { name: "Run Sites.Selected write check" }));
    expect(await screen.findByText("Sites.Selected read and upload-session write verified")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "integrations.admin.graph.verifySitesSelectedWrite")?.input).toEqual({});
    expect(screen.getByText("Upload session + DELETE: passed")).toBeInTheDocument();

    // Explicit site/drive/folder inputs forwarded when provided
    await user.type(screen.getByLabelText(/SharePoint site URL or Graph site ID/), "https://contoso.sharepoint.com/sites/orders");
    await user.type(screen.getByLabelText(/Probe folder path/), ".rp-check");
    await user.click(screen.getByRole("button", { name: "Run Sites.Selected write check" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "integrations.admin.graph.verifySitesSelectedWrite")).toHaveLength(2),
    );
    expect(calls.filter((c) => c.path === "integrations.admin.graph.verifySitesSelectedWrite")[1]!.input).toEqual({
      siteUrlOrId: "https://contoso.sharepoint.com/sites/orders",
      probeFolderPath: ".rp-check",
    });

    // Entra Sites.Selected runbook rendered with discouraged broad permissions and copyable code blocks
    expect(screen.getByText("Sites.Selected")).toBeInTheDocument();
    expect(screen.getByText("Sites.ReadWrite.All")).toBeInTheDocument();
    expect(screen.getByText(/Personal OneDrive drives do not support Sites\.Selected/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Graph site permission endpoint" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("240/320 px reflow: wraps unbroken SharePoint URL templates, hostnames, and runbook steps with min-w-0 containers", async () => {
    const prodLikeRunbook = {
      ...entraRunbook,
      steps: [
        ...entraRunbook.steps,
        "Enable both 'Microsoft Graph' and 'SharePoint Upload Session' outbound presets on /admin/integrations/egress.",
      ],
      oneDriveNote:
        "OneDrive for Business drives live inside personal SharePoint site collections (https://<tenant>-my.sharepoint.com/personal/<user>); grant Sites.Selected 'write' on that personal site collection rather than Files.ReadWrite.All.",
    };
    const { container } = renderPage(<GraphMailPage />, {
      "integrations.admin.graph.get": () => graphConfig,
      "integrations.admin.graph.entraRunbook": () => prodLikeRunbook,
    });

    await screen.findByRole("heading", { name: "Entra Sites.Selected runbook" });

    const noteParagraph = screen.getByText(/https:\/\/<tenant>-my\.sharepoint\.com\/personal\/<user>/);
    expect(noteParagraph.className.split(/\s+/)).toContain("wrap-anywhere");

    const stepItem = screen.getByText(/\/admin\/integrations\/egress/);
    expect(stepItem.className.split(/\s+/)).toContain("wrap-anywhere");

    for (const host of [
      "login.microsoftonline.com",
      "graph.microsoft.com",
      "*.sharepoint.com",
      "*.files.1drv.com",
    ]) {
      const codeEl = screen.getByText(host);
      expect(codeEl.tagName).toBe("CODE");
      expect(codeEl.className.split(/\s+/)).toContain("break-all");
    }

    for (const pre of container.querySelectorAll<HTMLElement>("pre")) {
      const classes = pre.className.split(/\s+/);
      expect(classes).toContain("break-all");
      expect(classes).toContain("whitespace-pre-wrap");
    }
  });
});
