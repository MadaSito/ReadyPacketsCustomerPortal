/** SSO client: sign-in button, refusal and completion pages, admin page. Uses a local fake tRPC fetch (no real IdP). */
import { screen } from "@testing-library/react";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { pageA11y } from "@/test/a11y";
import type { AppRouter } from "@server/trpc/root";
import type { MeResult } from "@/lib/authApi";
import { TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { SsoSignInButton, ssoStartHref } from "./index";
import SsoAdminPage from "./SsoAdminPage";
import SsoCompletePage, { lastSsoTestResult } from "./SsoCompletePage";
import SsoRefusedPage from "./SsoRefusedPage";

const admin = {
  user: { publicId: "01JD0000000000000000000001", role: "admin", name: "Avery Admin", email: "avery@example.test", customerRef: null, status: "active" },
  state: "full", pendingSteps: [], nextStep: null,
} as unknown as MeResult;

function renderPage(page: ReactElement, records: Record<string, (input: unknown) => unknown>, path = "/") {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc",
      transformer: superjson,
      fetch: async (request) => {
        const url = new URL(String(request));
        const paths = url.pathname.slice("/rpc/".length).split(",");
        return Response.json(paths.map((p) => {
          const respond = records[p];
          if (!respond) throw new Error(`Unexpected test request: ${p}`);
          return { result: { data: superjson.serialize(respond(undefined)) } };
        }));
      },
    })],
  });
  const api = fakeAuthApi({ me: async () => admin });
  return renderUi(page, { api, queryClient, path, wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider> });
}

const adminView = {
  enabled: false, tenantId: "11111111-2222-3333-4444-555555555555", clientId: "66666666-7777-8888-9999-000000000000",
  clientSecret: { configured: true, last4: "AbCd" }, buttonLabel: "Sign in with SSO", allowedDomains: ["example.test"],
  trustEntraMfa: false, jitMode: "off", jitStaffAppRole: null, jitDailyLimit: 25,
  redirectUri: "https://portal.example.test/api/identity/sso/callback", version: 2, complete: true,
  availableInThisDeployment: true, linkedAccounts: 0, breakGlass: { localMfaAdministrators: 1, soleLocalMfaAdministratorHasPasskey: false },
  protocol: "oidc", entraMfaMode: "portal", acceptedAuthnContexts: [], allowedRoles: ["admin", "staff"],
  saml: {
    entityId: "https://portal.example.test/api/identity/saml/metadata", entityIdIsDefault: true,
    acsUrl: "https://portal.example.test/api/identity/saml/acs", signOnUrl: "https://portal.example.test/api/identity/saml/start",
    metadataUrl: "https://portal.example.test/api/identity/saml/metadata", idpIssuer: "https://sts.windows.net/11111111-2222-3333-4444-555555555555/",
    requiredClaims: [
      "http://schemas.microsoft.com/identity/claims/objectidentifier", "http://schemas.microsoft.com/identity/claims/tenantid",
      "http://schemas.microsoft.com/claims/authnmethodsreferences",
    ],
    metadataSourceUrl: null, metadataRefreshedAt: null, metadataStatus: null, certificates: [] as unknown[],
  },
  roleMappings: [] as unknown[],
};

const samlView = {
  ...adminView,
  protocol: "saml", entraMfaMode: "claim", jitMode: "staff", jitStaffAppRole: "Portal.Staff",
  saml: {
    ...adminView.saml,
    certificates: [{
      id: "01JD0000000000000000000009", fingerprintSha256: "AB".repeat(32), subject: "CN=Microsoft Azure Federated SSO Certificate",
      notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2029-01-01T00:00:00Z"), source: "metadata", state: "trusted", daysLeft: 800,
    }],
  },
  roleMappings: [{ appRoleValue: "Portal.Customer", role: "customer" }],
};

describe("SSO sign-in button", () => {
  it("only offers safe relative next paths", () => {
    expect(ssoStartHref("/orders?x=1")).toBe("/api/identity/sso/start?next=%2Forders%3Fx%3D1");
    expect(ssoStartHref("https://evil.test/")).toBe("/api/identity/sso/start");
    expect(ssoStartHref("//evil.test")).toBe("/api/identity/sso/start");
  });

  it("is hidden when single sign-on is disabled", async () => {
    renderPage(<div><SsoSignInButton /><p>ready</p></div>, { "identity.sso.publicConfig": () => ({ enabled: false, buttonLabel: "Sign in with SSO", providerName: "Microsoft Entra ID" }) });
    await screen.findByText("ready");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("link", { name: /SSO/ })).toBeNull();
  });

  it("is a real link to the start route when enabled", async () => {
    renderPage(<main><SsoSignInButton next="/orders" /></main>, { "identity.sso.publicConfig": () => ({ enabled: true, buttonLabel: "Sign in with SSO", providerName: "Microsoft Entra ID" }) });
    const link = await screen.findByRole("link", { name: /Sign in with SSO/ });
    expect(link).toHaveAttribute("href", "/api/identity/sso/start?next=%2Forders");
    await expectNoAxeViolations();
  });
});

describe("SSO refusal and completion pages", () => {
  it("explains a refusal in plain language", async () => {
    renderPage(<SsoRefusedPage />, {}, "/sso/refused?reason=SSO_ACCOUNT_EXISTS");
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/never link accounts by e-mail/)).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("falls back to a generic message for unknown codes", async () => {
    renderPage(<SsoRefusedPage />, {}, "/sso/refused?reason=<script>");
    expect(await screen.findByText(/could not be verified/)).toBeInTheDocument();
  });

  it("shows an expired message for a malformed attempt without calling the server", async () => {
    renderPage(<SsoCompletePage />, {}, "/sso/complete?attempt=bad");
    expect(await screen.findByText(/took too long or was already used/)).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});

describe("SSO admin page", () => {
  it("shows the configuration fields, redirect URI and break-glass warning", async () => {
    renderPage(<SsoAdminPage />, { "identity.admin.sso.get": () => adminView }, "/admin/sso");
    expect(await screen.findByRole("heading", { level: 1, name: "Single sign-on" })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Directory \(tenant\) ID/)).toHaveValue(adminView.tenantId);
    expect(screen.getByLabelText(/Application \(client\) ID/)).toHaveValue(adminView.clientId);
    expect(screen.getByText(adminView.redirectUri)).toBeInTheDocument();
    expect(screen.getByText(/AbCd/)).toBeInTheDocument();
    expect(screen.getAllByText(/break-glass|local administrator/i).length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });
});

describe("SSO admin page — SAML (increment 07)", () => {
  it("shows the Entra values to copy, required claims, certificates and mappings", async () => {
    renderPage(<SsoAdminPage />, { "identity.admin.sso.get": () => samlView }, "/admin/sso");
    expect(await screen.findByRole("heading", { level: 1, name: "Single sign-on" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Reply URL (Assertion Consumer Service URL)")).toHaveValue(samlView.saml.acsUrl);
    expect(screen.getByLabelText("Identifier (Entity ID)", { selector: "[readonly]" })).toHaveValue(samlView.saml.entityId);
    expect(screen.getByLabelText("Sign on URL")).toHaveValue(samlView.saml.signOnUrl);
    expect(screen.getByText(/Object ID \(objectidentifier\)/)).toBeInTheDocument();
    const certs = screen.getByRole("list", { name: "Certificates" });
    expect(within(certs).getByText("Trusted")).toBeInTheDocument();
    expect(within(certs).getByRole("button", { name: "Retire" })).toBeInTheDocument();
    expect(screen.getByLabelText("App role value 1")).toHaveValue("Portal.Customer");
    // OIDC-only fields are hidden for SAML.
    expect(screen.queryByLabelText(/Application \(client\) ID/)).not.toBeInTheDocument();
    expect(screen.queryByText(samlView.redirectUri)).not.toBeInTheDocument();
  });

  it("asks for the typed confirmation before letting Entra manage MFA", async () => {
    renderPage(<SsoAdminPage />, { "identity.admin.sso.get": () => samlView }, "/admin/sso");
    fireEvent.click(await screen.findByRole("radio", { name: /Microsoft Entra ID manages MFA/ }));
    expect(screen.getByText("Recommended: require MFA in Entra ID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Let Microsoft Entra ID manage MFA/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("offers allowed roles as checkboxes", async () => {
    renderPage(<SsoAdminPage />, { "identity.admin.sso.get": () => samlView }, "/admin/sso");
    expect(await screen.findByRole("checkbox", { name: "Administrators" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Staff" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Customers" })).not.toBeChecked();
  });

  it("moves focus to the test sign-in result after returning from Entra", async () => {
    lastSsoTestResult.value = { protocol: "saml", signatureVerified: true, tenantMatches: true, audienceMatches: true, roleAllowed: true, claimNames: [] };
    renderPage(<SsoAdminPage />, { "identity.admin.sso.get": () => samlView }, "/admin/sso?test=done");
    const region = await screen.findByRole("region", { name: "Test sign-in result" });
    expect(region).toHaveFocus();
    expect(within(region).getByText("Test sign-in completed")).toBeInTheDocument();
    lastSsoTestResult.value = null;
  });
});

pageA11y("SSO admin page (OpenID Connect)", async () => {
  renderPage(<main><SsoAdminPage /></main>, { "identity.admin.sso.get": () => adminView }, "/admin/sso");
  expect(await screen.findByLabelText(/Directory \(tenant\) ID/)).toBeInTheDocument();
  document.title = "Single sign-on · ReadyPackets";
});

pageA11y("SSO admin page (SAML)", async () => {
  renderPage(<main><SsoAdminPage /></main>, { "identity.admin.sso.get": () => samlView }, "/admin/sso");
  expect(await screen.findByRole("list", { name: "Certificates" })).toBeInTheDocument();
  document.title = "Single sign-on · ReadyPackets";
});
