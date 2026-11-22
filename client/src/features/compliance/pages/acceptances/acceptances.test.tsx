/**
 * Package D2 client tests — Policy Acceptance Log Centre (`Log`, `Coverage`, `Policy updates`),
 * step-up CSV export, Evidence Detail Dialog (confidentiality + keyboard/focus), Customer Profile
 * `Policies` tab, Exact Version Text page, 320 px responsive layout, and both-theme axe (`pageA11y`).
 */
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import { pageA11y } from "@/test/a11y";
import { PageHeader, Tabs } from "@/ui";
import { complianceFeature } from "../../routes";
import CustomerPoliciesTab from "./CustomerPoliciesTab";
import { acceptanceLogCustomerTabs, acceptanceLogNav, acceptanceLogRoutes } from "./index";
import { renderWithTrpc, type Fixtures, type Role } from "./testkit";
import type {
  AcceptanceFilterOptionsView,
  AcceptanceLogDetailView,
  AcceptanceLogFilterInput,
  AcceptanceLogItem,
  CustomerPolicyAcceptanceProfileView,
  PolicyCoverageView,
  PolicyUpdateHistoryItem,
  PolicyVersionReadView,
} from "./types";

// Under heavy concurrent shared-tree checks, cold lazy route + auth hydration can exceed 1000 ms.
configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  await Promise.all([import("./PolicyAcceptancesPage"), import("./PolicyVersionTextPage")]);
});

const DOC_TERMS = "01JD0000000000000000000101";
const DOC_PRIVACY = "01JD0000000000000000000102";
const VER_TERMS_V1 = "01JD0000000000000000000201";
const VER_TERMS_V2 = "01JD0000000000000000000202";
const VER_PRIVACY_V1 = "01JD0000000000000000000203";
const CUST_CARA = "01JD0000000000000000000301";
const CUST_OMAR = "01JD0000000000000000000302";
const ORDER_ID = "01JD0000000000000000000401";
const EV_CURRENT = "01JD0000000000000000000501";
const EV_SUPERSEDED = "01JD0000000000000000000502";

const HASH_V2 = "a1b2c3d4e5f6".padEnd(64, "0");
const HASH_V1 = "f6e5d4c3b2a1".padEnd(64, "9");

const ACCEPTED_T1 = "2026-11-21T15:30:00.000Z";
const ACCEPTED_T2 = "2026-10-04T08:05:00.000Z";
const PUBLISHED_V2 = "2026-11-01T12:00:00.000Z";
const PUBLISHED_V1 = "2026-09-01T09:00:00.000Z";

const filterOptionsFixture: AcceptanceFilterOptionsView = {
  policies: [
    {
      documentPublicId: DOC_TERMS,
      slug: "production-terms-and-service-conditions",
      title: "Production terms",
      audience: "customer",
      active: true,
      requiresAcceptance: true,
      versions: [
        {
          versionPublicId: VER_TERMS_V2,
          versionNumber: 2,
          versionLabel: "2.0",
          publishedAt: PUBLISHED_V2,
          isCurrent: true,
        },
        {
          versionPublicId: VER_TERMS_V1,
          versionNumber: 1,
          versionLabel: "1.0",
          publishedAt: PUBLISHED_V1,
          isCurrent: false,
        },
      ],
    },
    {
      documentPublicId: DOC_PRIVACY,
      slug: "privacy-notice",
      title: "Privacy notice",
      audience: "all",
      active: true,
      requiresAcceptance: true,
      versions: [
        {
          versionPublicId: VER_PRIVACY_V1,
          versionNumber: 1,
          versionLabel: "1.0",
          publishedAt: PUBLISHED_V1,
          isCurrent: true,
        },
      ],
    },
  ],
};

function logItemCurrent(overrides: Partial<AcceptanceLogItem> = {}): AcceptanceLogItem {
  return {
    publicId: EV_CURRENT,
    evidenceKind: "order_gate",
    acceptedAt: ACCEPTED_T1,
    customer: {
      userPublicId: CUST_CARA,
      name: "Cara Customer",
      email: "cara@example.test",
      customerRef: "RP-CUST01",
    },
    policyDocumentPublicId: DOC_TERMS,
    policySlug: "production-terms-and-service-conditions",
    policyTitle: "Production terms",
    versionPublicId: VER_TERMS_V2,
    versionNumber: 2,
    versionLabel: "2.0",
    contentHash: HASH_V2,
    shortContentHash: HASH_V2.slice(0, 12),
    source: "order_gate",
    method: "typed_signature",
    hasTypedSignature: true,
    freshness: "current",
    supersededByVersionPublicId: null,
    supersededByVersionLabel: null,
    orderPublicId: ORDER_ID,
    orderReference: "RP-1042",
    gateKey: "order_start",
    addressPseudonym: "addr_9f8e7d6c5b4a",
    correlationId: "corr_01jdacceptance99",
    origin: "portal",
    ...overrides,
  };
}

function logItemSuperseded(overrides: Partial<AcceptanceLogItem> = {}): AcceptanceLogItem {
  return {
    publicId: EV_SUPERSEDED,
    evidenceKind: "account",
    acceptedAt: ACCEPTED_T2,
    customer: {
      userPublicId: CUST_OMAR,
      name: "Omar Outstanding",
      email: "omar@example.test",
      customerRef: "RP-CUST02",
    },
    policyDocumentPublicId: DOC_TERMS,
    policySlug: "production-terms-and-service-conditions",
    policyTitle: "Production terms",
    versionPublicId: VER_TERMS_V1,
    versionNumber: 1,
    versionLabel: "1.0",
    contentHash: HASH_V1,
    shortContentHash: HASH_V1.slice(0, 12),
    source: "registration",
    method: "checkbox",
    hasTypedSignature: false,
    freshness: "superseded",
    supersededByVersionPublicId: VER_TERMS_V2,
    supersededByVersionLabel: "2.0",
    orderPublicId: null,
    orderReference: null,
    gateKey: null,
    addressPseudonym: "addr_1a2b3c4d5e6f",
    correlationId: "corr_01jdreg88",
    origin: "portal",
    ...overrides,
  };
}

function detailFixtureForRole(role: Role): AcceptanceLogDetailView {
  return {
    ...logItemCurrent(),
    contentFormat: "safe_markdown",
    bodyText:
      "# Scope of work\n\nCustomer agrees to **immutable** evidence terms.\n\n<script>window.__xss=true</script>",
    effectiveAt: PUBLISHED_V2,
    publishedAt: PUBLISHED_V2,
    typedSignerName: role === "admin" ? "Cara Legal Signer" : null,
    signerNameRedacted: role !== "admin",
  };
}

const coverageFixture: PolicyCoverageView = {
  activeCustomerCount: 2,
  policies: [
    {
      documentPublicId: DOC_TERMS,
      slug: "production-terms-and-service-conditions",
      title: "Production terms",
      audience: "customer",
      currentVersionPublicId: VER_TERMS_V2,
      currentVersionNumber: 2,
      currentVersionLabel: "2.0",
      publishedAt: PUBLISHED_V2,
      effectiveAt: PUBLISHED_V2,
      activeCustomerCount: 2,
      acceptedCurrentCount: 1,
      outstandingCount: 1,
      outstandingCustomers: [
        {
          customer: {
            userPublicId: CUST_OMAR,
            name: "Omar Outstanding",
            email: "omar@example.test",
            customerRef: "RP-CUST02",
          },
          lastAcceptedVersionPublicId: VER_TERMS_V1,
          lastAcceptedVersionNumber: 1,
          lastAcceptedVersionLabel: "1.0",
          lastAcceptedAt: ACCEPTED_T2,
        },
      ],
      outstandingTruncated: false,
    },
  ],
};

const updatesFixture: { items: PolicyUpdateHistoryItem[] } = {
  items: [
    {
      documentPublicId: DOC_TERMS,
      policySlug: "production-terms-and-service-conditions",
      policyTitle: "Production terms",
      audience: "customer",
      versionPublicId: VER_TERMS_V2,
      versionNumber: 2,
      versionLabel: "2.0",
      contentHash: HASH_V2,
      shortContentHash: HASH_V2.slice(0, 12),
      changeSummary: "Clarified order-gate signature verification and refund timelines.",
      publishedAt: PUBLISHED_V2,
      effectiveAt: PUBLISHED_V2,
      publishedBy: {
        userPublicId: "01JD0000000000000000000001",
        name: "Ada Admin",
        email: "admin@example.test",
      },
      isCurrent: true,
      acceptedCustomerCount: 1,
    },
    {
      documentPublicId: DOC_TERMS,
      policySlug: "production-terms-and-service-conditions",
      policyTitle: "Production terms",
      audience: "customer",
      versionPublicId: VER_TERMS_V1,
      versionNumber: 1,
      versionLabel: "1.0",
      contentHash: HASH_V1,
      shortContentHash: HASH_V1.slice(0, 12),
      changeSummary: null,
      publishedAt: PUBLISHED_V1,
      effectiveAt: PUBLISHED_V1,
      publishedBy: null,
      isCurrent: false,
      acceptedCustomerCount: 2,
    },
  ],
};

const customerProfileFixture: CustomerPolicyAcceptanceProfileView = {
  customer: {
    userPublicId: CUST_CARA,
    name: "Cara Customer",
    email: "cara@example.test",
    customerRef: "RP-CUST01",
  },
  policies: [
    {
      documentPublicId: DOC_TERMS,
      slug: "production-terms-and-service-conditions",
      title: "Production terms",
      requiresAcceptance: true,
      requiresTypedSignature: true,
      currentVersionPublicId: VER_TERMS_V2,
      currentVersionNumber: 2,
      currentVersionLabel: "2.0",
      currentPublishedAt: PUBLISHED_V2,
      currentEffectiveAt: PUBLISHED_V2,
      state: "accepted_current",
      acceptedVersionPublicId: VER_TERMS_V2,
      acceptedVersionNumber: 2,
      acceptedVersionLabel: "2.0",
      acceptedAt: ACCEPTED_T1,
    },
    {
      documentPublicId: DOC_PRIVACY,
      slug: "privacy-notice",
      title: "Privacy notice",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      currentVersionPublicId: VER_PRIVACY_V1,
      currentVersionNumber: 1,
      currentVersionLabel: "1.0",
      currentPublishedAt: PUBLISHED_V1,
      currentEffectiveAt: PUBLISHED_V1,
      state: "update_pending",
      acceptedVersionPublicId: null,
      acceptedVersionNumber: null,
      acceptedVersionLabel: null,
      acceptedAt: null,
    },
  ],
  history: [logItemCurrent(), logItemSuperseded({ customer: logItemCurrent().customer })],
  nextCursor: null,
};

const versionReadFixture: PolicyVersionReadView = {
  documentPublicId: DOC_TERMS,
  policySlug: "production-terms-and-service-conditions",
  policyTitle: "Production terms",
  audience: "customer",
  requiresAcceptance: true,
  requiresTypedSignature: true,
  versionPublicId: VER_TERMS_V2,
  versionNumber: 2,
  versionLabel: "2.0",
  contentFormat: "safe_markdown",
  bodyText: "# Scope of work\n\nCustomer agrees to **immutable** evidence terms.",
  contentHash: HASH_V2,
  shortContentHash: HASH_V2.slice(0, 12),
  changeSummary: "Clarified order-gate signature verification and refund timelines.",
  effectiveAt: PUBLISHED_V2,
  publishedAt: PUBLISHED_V2,
  isCurrent: true,
};

function baseFixtures(role: Role = "admin", overrides: Fixtures = {}): Fixtures {
  return {
    "compliance.policies.admin.acceptanceLog.filterOptions": () => filterOptionsFixture,
    "compliance.policies.admin.acceptanceLog.list": () => ({
      items: [logItemCurrent(), logItemSuperseded()],
      nextCursor: null,
    }),
    "compliance.policies.admin.acceptanceLog.detail": () => detailFixtureForRole(role),
    "compliance.policies.admin.acceptanceLog.coverage": () => coverageFixture,
    "compliance.policies.admin.acceptanceLog.updates": () => updatesFixture,
    "compliance.policies.admin.acceptanceLog.forCustomer": () => customerProfileFixture,
    "compliance.policies.admin.acceptanceLog.versionText": () => versionReadFixture,
    ...overrides,
  };
}

function renderRoutes(path: string, role: Role = "admin", overrides: Fixtures = {}) {
  return renderWithTrpc(<AppRoutes routes={acceptanceLogRoutes} />, baseFixtures(role, overrides), {
    path,
    role,
  });
}

function CustomerDetailHost({ customerId }: { customerId: string }) {
  useEffect(() => {
    document.title = "Cara Customer · ReadyPackets";
  }, []);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Cara Customer" />
      <Tabs
        label="Customer sections"
        defaultValue="policies"
        items={[
          {
            value: "policies",
            label: "Policies",
            content: <CustomerPoliciesTab customerId={customerId} />,
          },
        ]}
      />
    </main>
  );
}

describe("Package D2 — Policy Acceptance Log Centre & Customer Policies Tab", () => {
  it("registers compliance routes, console nav, and the customer profile Policies tab", () => {
    expect(acceptanceLogRoutes.map((r) => [r.path, r.access, r.capability])).toEqual([
      ["/admin/policy-acceptances", "staff", "policies.acceptances.read"],
      ["/admin/policy-acceptances/coverage", "staff", "policies.acceptances.read"],
      ["/admin/policy-acceptances/updates", "staff", "policies.acceptances.read"],
      ["/admin/policy-acceptances/versions/:versionId", "staff", "policies.acceptances.read"],
    ]);
    expect(acceptanceLogNav[0]).toMatchObject({
      label: "Policy acceptances",
      href: "/admin/policy-acceptances",
      area: "console",
      group: "Billing & compliance",
      access: "staff",
      capability: "policies.acceptances.read",
      order: 47,
    });
    expect(acceptanceLogCustomerTabs.map((t) => [t.key, t.label, t.access, t.order])).toEqual([
      ["policies", "Policies", "staff", 40],
    ]);
    expect(complianceFeature.customerTabs?.some((t) => t.key === "policies")).toBe(true);
  });

  it("renders Log tab with local + UTC times, freshness, trace fields, stacked <md cards, filters, and cursor LoadMore focus", async () => {
    const { calls } = renderRoutes("/admin/policy-acceptances", "admin", {
      "compliance.policies.admin.acceptanceLog.list": (rawInput) => {
        const input = (rawInput ?? {}) as AcceptanceLogFilterInput & { cursor?: string };
        if (input.source === "imported_historical") {
          return { items: [], nextCursor: null };
        }
        if (input.cursor === "cursor_page_2") {
          return { items: [logItemSuperseded()], nextCursor: null };
        }
        return { items: [logItemCurrent()], nextCursor: "cursor_page_2" };
      },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Policy acceptances" })).toBeInTheDocument();
    expect((await screen.findAllByText("Cara Customer")).length).toBeGreaterThan(0);
    // Explicit UTC timestamp alongside local <time>
    expect(screen.getAllByText("2026-11-21 15:30 UTC").length).toBeGreaterThan(0);
    expect(document.querySelector('time[datetime="2026-11-21T15:30:00.000Z"]')).not.toBeNull();
    // Order reference link, pseudonym, correlation ID, and specific version link name
    expect(screen.getAllByRole("link", { name: "RP-1042" })[0]).toHaveAttribute(
      "href",
      `/admin/orders/${ORDER_ID}`,
    );
    expect(screen.getAllByRole("link", { name: "View v2.0 of Production terms" })[0]).toHaveAttribute(
      "href",
      `/admin/policy-acceptances/versions/${VER_TERMS_V2}`,
    );
    expect(screen.getAllByText("addr_9f8e7d6c5b4a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("corr_01jdacceptance99").length).toBeGreaterThan(0);

    // Stacked card list (<md, covering all viewports below 640 px and 320 px)
    const cardList = screen.getByRole("list", { name: "Policy acceptance log" });
    expect(cardList.className).toContain("md:hidden");

    // Cursor pagination via LoadMore moves focus to polite summary on final page
    const loadMoreBtn = screen.getByRole("button", { name: "Load more records" });
    loadMoreBtn.focus();
    await userEvent.click(loadMoreBtn);
    await waitFor(() =>
      expect(screen.getAllByText("Omar Outstanding").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("by version 2.0").length).toBeGreaterThan(0);
    await waitFor(() => {
      const summary = screen.getByText("Showing 2 acceptance records");
      expect(summary).toHaveAttribute("role", "status");
      expect(document.activeElement).toBe(summary);
    });

    // Filtering to zero results updates status region politely and offers Clear filters
    await userEvent.selectOptions(screen.getAllByLabelText("Source")[0]!, "imported_historical");
    expect(await screen.findByText("No matching acceptance records")).toBeInTheDocument();
    const zeroStatus = screen.getByText("0 matching acceptance records.");
    expect(zeroStatus).toHaveAttribute("role", "status");
    expect(
      calls.some(
        (c) =>
          c.path === "compliance.policies.admin.acceptanceLog.list" &&
          (c.input as AcceptanceLogFilterInput)?.source === "imported_historical",
      ),
    ).toBe(true);

    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect((await screen.findAllByText("Cara Customer")).length).toBeGreaterThan(0);
  });

  it("enforces Evidence dialog typed-signer confidentiality by capability, inert plain/markdown rendering, keyboard scroll focus, and Escape focus restore", async () => {
    // 1. Staff viewer (`policies.acceptances.read`, lacks `policies.manage` and `policies.acceptances.export`)
    const staffRender = renderRoutes("/admin/policy-acceptances", "staff");
    expect(await screen.findByRole("heading", { level: 1, name: "Policy acceptances" })).toBeInTheDocument();
    // Staff cannot see Export CSV
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();

    const launcher = (
      await screen.findAllByRole("button", {
        name: "View evidence for Cara Customer on Production terms v2.0 (RP-1042), accepted 2026-11-21 15:30 UTC",
      })
    )[0]!;
    launcher.focus();
    await userEvent.click(launcher);

    const dialog = await screen.findByRole("dialog", { name: "Acceptance evidence record" });
    expect(await within(dialog).findByText("Encrypted")).toBeInTheDocument();
    expect(within(dialog).getByText("Requires policy management permission")).toBeInTheDocument();
    expect(within(dialog).queryByText("Cara Legal Signer")).toBeNull();
    // Script payload in policy body stays strictly inert text
    expect(within(dialog).getByText(/window\.__xss=true/)).toBeInTheDocument();
    expect(dialog.querySelector("script")).toBeNull();

    // Scrollable exact-text region is keyboard reachable via Tab inside the dialog
    const textRegion = within(dialog).getByRole("region", {
      name: "Production terms version 2.0, exact text",
    });
    expect(textRegion).toHaveAttribute("tabindex", "0");
    for (let step = 0; step < 10 && document.activeElement !== textRegion; step += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(textRegion);

    // Pressing Escape closes the dialog and restores focus to the launcher button
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(launcher);
    staffRender.unmount();

    // 2. Admin viewer (`policies.manage` + `policies.acceptances.export`) sees decrypted typed signer name
    renderRoutes("/admin/policy-acceptances", "admin");
    const adminLauncher = (
      await screen.findAllByRole("button", {
        name: "View evidence for Cara Customer on Production terms v2.0 (RP-1042), accepted 2026-11-21 15:30 UTC",
      })
    )[0]!;
    await userEvent.click(adminLauncher);
    const adminDialog = await screen.findByRole("dialog", { name: "Acceptance evidence record" });
    expect(await within(adminDialog).findByText("Cara Legal Signer")).toBeInTheDocument();
  });

  it("challenges with Step-Up MFA before exporting CSV and passes active filters to acceptanceLog.export", async () => {
    let steppedUp = false;
    const stepUpSpy = vi.fn(async () => {
      steppedUp = true;
      return { verifiedAt: new Date().toISOString() };
    });
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-csv");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const { calls } = renderWithTrpc(
        <AppRoutes routes={acceptanceLogRoutes} />,
        baseFixtures("admin", {
          "compliance.policies.admin.acceptanceLog.export": () => {
            if (!steppedUp) {
              throw {
                safe: {
                  code: "FORBIDDEN",
                  domainCode: "STEP_UP_REQUIRED",
                  reasonCode: "STEP_UP_REQUIRED",
                  safeMessage: "Fresh verification required.",
                },
              };
            }
            return {
              filename: "policy-acceptances-2026-11-22.csv",
              contentType: "text/csv; charset=utf-8",
              csv: "accepted_at_utc,customer_ref\n2026-11-21T15:30:00.000Z,'=SAFE\n",
              rowCount: 1,
              truncated: false,
              maxRows: 5000,
            };
          },
        }),
        {
          path: "/admin/policy-acceptances",
          role: "admin",
          authOverrides: {
            assuranceState: async () => ({
              mfaEnrolled: true,
              totpEnrolled: true,
              passkeyCount: 0,
              recoveryCodesRemaining: 8,
              recoveryCodesAcknowledged: true,
            }),
            stepUp: stepUpSpy as never,
          },
        },
      );

      await screen.findByRole("heading", { level: 1, name: "Policy acceptances" });
      await userEvent.type(screen.getAllByLabelText("Order reference")[0]!, "RP-1042");
      await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));

      // Step-up dialog opens because server answered STEP_UP_REQUIRED
      const stepDialog = await screen.findByRole("dialog", { name: /Confirm|Verify/i });
      await userEvent.type(within(stepDialog).getByLabelText(/Password/i), "correct-horse-battery");
      await userEvent.type(within(stepDialog).getByLabelText(/^6-digit code/i), "123456");
      await userEvent.click(within(stepDialog).getByRole("button", { name: /Confirm|Verify/i }));

      await waitFor(() => expect(stepUpSpy).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledTimes(1));
      expect(
        calls.filter((c) => c.path === "compliance.policies.admin.acceptanceLog.export").at(-1)?.input,
      ).toEqual({ orderReference: "RP-1042" });
      expect(await screen.findByText("Exported 1 acceptance record")).toBeInTheDocument();
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it("renders Coverage tab, Policy updates tab, keyboard RouteTabs navigation, Customer Policies tab, and Exact Version Text page", async () => {
    // Start on Log tab and exercise Home/End + ArrowRight + Space keyboard navigation on RouteTabs
    const view = renderRoutes("/admin/policy-acceptances", "staff");
    const logTab = await screen.findByRole("tab", { name: "Log" });
    logTab.focus();
    await userEvent.keyboard("{End}");
    const updatesTab = screen.getByRole("tab", { name: "Policy updates" });
    expect(document.activeElement).toBe(updatesTab);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(logTab);
    await userEvent.keyboard("{ArrowRight}");
    const coverageTab = screen.getByRole("tab", { name: "Coverage" });
    expect(document.activeElement).toBe(coverageTab);
    await userEvent.keyboard(" ");

    // Coverage tab content
    expect(await screen.findByText("1 of 2 active customers")).toBeInTheDocument();
    expect(screen.getAllByText("Omar Outstanding").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: "Version 1.0 of Production terms" })[0],
    ).toHaveAttribute("href", `/admin/policy-acceptances/versions/${VER_TERMS_V1}`);

    // Navigate to Policy updates tab
    await userEvent.click(screen.getByRole("tab", { name: "Policy updates" }));
    expect(
      await screen.findAllByText(
        "Clarified order-gate signature verification and refund timelines.",
      ),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("Ada Admin").length).not.toBe(0);
    const updatesSummary = screen.getByText("Showing 2 published versions");
    expect(updatesSummary).toHaveAttribute("role", "status");
    view.unmount();

    // Customer profile Policies tab + clicking through to Exact Version Text page
    const custView = renderWithTrpc(<CustomerDetailHost customerId={CUST_CARA} />, baseFixtures("staff"), {
      path: `/admin/customers/${CUST_CARA}`,
      role: "staff",
    });
    expect(await screen.findByText("Status per policy")).toBeInTheDocument();
    expect(screen.getAllByText("Current version").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Update not yet accepted").length).toBeGreaterThan(0);
    const exactLinks = screen.getAllByRole("link", {
      name: "View version 2.0 text for Production terms",
    });
    expect(exactLinks[0]).toHaveAttribute(
      "href",
      `/admin/policy-acceptances/versions/${VER_TERMS_V2}`,
    );
    custView.unmount();

    // Standalone Exact Version Text page
    renderRoutes(`/admin/policy-acceptances/versions/${VER_TERMS_V2}`, "staff");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Production terms — Version 2.0" }),
    ).toBeInTheDocument();
    expect(screen.getByText(HASH_V2)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
  });

  it("renders safe ErrorState (never EmptyState) when server refuses unauthorized or unknown access", async () => {
    renderRoutes("/admin/policy-acceptances", "staff", {
      "compliance.policies.admin.acceptanceLog.list": () => {
        throw {
          safe: {
            code: "FORBIDDEN",
            reasonCode: "CAPABILITY_NOT_GRANTED",
            safeMessage: "You do not have permission to view policy acceptance records.",
            requestId: "req_denied_01",
          },
        };
      },
    });
    expect(
      await screen.findByText("You do not have permission to view policy acceptance records."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No policy acceptances recorded yet")).toBeNull();
  });

  it("keeps LoadMore active when bounded scan returns 0 rows with a non-null nextCursor (Log & Customer Policies tabs)", async () => {
    // 1. AcceptanceLogTab: sparse page 1 (`items: [], nextCursor: "cursor_sparse_2"`) -> page 2 match
    const logView = renderRoutes("/admin/policy-acceptances", "staff", {
      "compliance.policies.admin.acceptanceLog.list": (rawInput) => {
        const input = (rawInput ?? {}) as AcceptanceLogFilterInput & { cursor?: string };
        if (input.cursor === "cursor_sparse_2") {
          return { items: [logItemCurrent()], nextCursor: null };
        }
        return { items: [], nextCursor: "cursor_sparse_2" };
      },
    });

    const sparseSummary = await screen.findByText(
      "No matches on this page yet. Load more to keep searching.",
    );
    expect(sparseSummary).toHaveAttribute("role", "status");
    // Final empty state is NOT prematurely rendered while nextCursor exists
    expect(screen.queryByText("No policy acceptances recorded yet")).toBeNull();
    expect(screen.queryByText("No matching acceptance records")).toBeNull();

    const loadMoreBtn = screen.getByRole("button", { name: "Load more records" });
    loadMoreBtn.focus();
    await userEvent.click(loadMoreBtn);

    expect((await screen.findAllByText("Cara Customer")).length).toBeGreaterThan(0);
    await waitFor(() => {
      const finalSummary = screen.getByText("Showing 1 acceptance record");
      expect(finalSummary).toHaveAttribute("role", "status");
      expect(document.activeElement).toBe(finalSummary);
    });
    logView.unmount();

    // 2. CustomerPoliciesTab: sparse page 1 (`history: [], nextCursor: "cust_sparse_2"`) -> page 2 match
    renderWithTrpc(
      <CustomerDetailHost customerId={CUST_CARA} />,
      baseFixtures("staff", {
        "compliance.policies.admin.acceptanceLog.forCustomer": (rawInput) => {
          const input = (rawInput ?? {}) as { cursor?: string };
          if (input.cursor === "cust_sparse_2") {
            return {
              ...customerProfileFixture,
              history: [logItemCurrent()],
              nextCursor: null,
            };
          }
          return {
            ...customerProfileFixture,
            history: [],
            nextCursor: "cust_sparse_2",
          };
        },
      }),
      {
        path: `/admin/customers/${CUST_CARA}`,
        role: "staff",
      },
    );

    expect(
      await screen.findByText("No matches on this page yet. Load more to keep searching."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByText("No acceptances recorded for this customer")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(
      await screen.findByText("Showing 1 acceptance record"),
    ).toHaveAttribute("role", "status");
  });
});

pageA11y("/admin/policy-acceptances (Log tab) ready", async () => {
  renderRoutes("/admin/policy-acceptances", "admin");
  await screen.findAllByText("Cara Customer");
});

pageA11y("/admin/policy-acceptances (Evidence dialog open) ready", async () => {
  renderRoutes("/admin/policy-acceptances", "admin");
  const btn = (
    await screen.findAllByRole("button", {
      name: "View evidence for Cara Customer on Production terms v2.0 (RP-1042), accepted 2026-11-21 15:30 UTC",
    })
  )[0]!;
  await userEvent.click(btn);
  await screen.findByText("Cara Legal Signer");
});

pageA11y("/admin/policy-acceptances/coverage ready", async () => {
  renderRoutes("/admin/policy-acceptances/coverage", "admin");
  await screen.findByText("1 of 2 active customers");
});

pageA11y("/admin/policy-acceptances/updates ready", async () => {
  renderRoutes("/admin/policy-acceptances/updates", "admin");
  await screen.findAllByText("Clarified order-gate signature verification and refund timelines.");
});

pageA11y("Customer profile Policies tab ready", async () => {
  renderWithTrpc(<CustomerDetailHost customerId={CUST_CARA} />, baseFixtures("staff"), {
    path: `/admin/customers/${CUST_CARA}`,
    role: "staff",
  });
  await screen.findByText("Status per policy");
});

pageA11y("/admin/policy-acceptances/versions/:versionId ready", async () => {
  renderRoutes(`/admin/policy-acceptances/versions/${VER_TERMS_V2}`, "staff");
  await screen.findByRole("heading", { level: 1, name: "Production terms — Version 2.0" });
});
