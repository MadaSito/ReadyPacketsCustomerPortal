// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import type { MeResult } from "@/lib/authApi";
import type { RouteDef } from "@/lib/routes";
import { pageA11y } from "@/test/a11y";
import { PageHeader } from "@/ui";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import {
  productionAdminNav,
  productionAdminRoutes,
  productionOrderTabs,
} from "./index";
import type {
  ProductionDestinationTestResult,
  ProductionDispatchItem,
  ProductionLaterPhasePreview,
  ProductionOrderPreview,
  ProductionSettingsView,
} from "./model";
import OrderProductionTab from "./OrderProductionTab";
import ProductionPipelinePage from "./ProductionPipelinePage";

vi.mock("@/app/slots", () => ({
  NotificationSlot: () => null,
  GlobalSearchSlot: () => null,
  AnalyticsConsentSlot: () => null,
  CookieConsentSlot: () => null,
  CustomerMaintenanceSlot: () => null,
  CartBadgeSlot: () => null,
  SsoSignInSlot: () => null,
}));

const {
  orderPublicId,
  correlationId,
  deliveredDispatchId,
  failedDispatchId,
  redeliveredDispatchId,
  mockState,
  updateSettings,
  testDestination,
  requestP101,
  requestP201,
  requestP301,
  requestP401,
  retryDispatch,
  redeliverDispatch,
  resendDispatch,
  listDispatchesSpy,
} = vi.hoisted(() => ({
  orderPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZME",
  correlationId: "01JAFJ8VEGZ9GPVRR2S9KTYZMF",
  deliveredDispatchId: "01JAFJ8VEGZ9GPVRR2S9KTYZMG",
  failedDispatchId: "01JAFJ8VEGZ9GPVRR2S9KTYZMX",
  redeliveredDispatchId: "01JAFJ8VEGZ9GPVRR2S9KTYZMR",
  mockState: {
    broken: false,
    emptyDispatches: false,
    p101Delivered: false,
    p101Failed: false,
    p101Unknown: false,
    p201Delivered: false,
    p201Failed: false,
    p301Configured: false,
    p301Delivered: false,
    p401Configured: false,
    p401Delivered: false,
    hasRedeliveryRow: false,
    ineligibleOrder: false,
    staffViewer: true,
    unconfigured: false,
    pipelineOff: false,
  },
  updateSettings: vi.fn(),
  testDestination: vi.fn(),
  requestP101: vi.fn(),
  requestP201: vi.fn(),
  requestP301: vi.fn(),
  requestP401: vi.fn(),
  retryDispatch: vi.fn(),
  redeliverDispatch: vi.fn(),
  resendDispatch: vi.fn(),
  listDispatchesSpy: vi.fn(),
}));

vi.mock("@/lib/trpc", () => {
  const occurredAt = new Date("2026-11-20T12:00:00Z");
  const laterAt = new Date("2026-11-20T12:10:00Z");

  const makeSettings = (): ProductionSettingsView =>
    mockState.unconfigured
      ? {
          enabled: false,
          configured: false,
          state: "not_configured",
          summary: "Configure Phase I (P101), Phase II (P201), and a canon version to enable.",
          p101UrlConfigured: false,
          p101UrlMask: null,
          p201UrlConfigured: false,
          p201UrlMask: null,
          p301UrlConfigured: false,
          p301UrlMask: null,
          p401UrlConfigured: false,
          p401UrlMask: null,
          authHeaderName: "",
          authHeaderValueConfigured: false,
          canonVersion: "",
          runMode: "production",
          timeoutMs: 10_000,
        }
      : {
          enabled: !mockState.pipelineOff,
          configured: true,
          state: mockState.pipelineOff ? "disabled" : "configured",
          summary: "Phase I and Phase II webhook endpoints and canon version are configured.",
          p101UrlConfigured: true,
          p101UrlMask: { host: "hooks.example.test", last4: "9f2a" },
          p201UrlConfigured: true,
          p201UrlMask: { host: "hooks.example.test", last4: "4b8c" },
          p301UrlConfigured: mockState.p301Configured,
          p301UrlMask: mockState.p301Configured
            ? { host: "hooks.example.test", last4: "3c01" }
            : null,
          p401UrlConfigured: mockState.p401Configured,
          p401UrlMask: mockState.p401Configured
            ? { host: "hooks.example.test", last4: "4d01" }
            : null,
          authHeaderName: "X-Webhook-Token",
          authHeaderValueConfigured: true,
          canonVersion: "ReadyPackets_Production_v2.0",
          runMode: "production",
          timeoutMs: 12_000,
        };

  const sampleDispatch: ProductionDispatchItem = {
    publicId: deliveredDispatchId,
    orderPublicId,
    orderReference: "RP-C000008-2611-5E4A2D",
    phase: "P101",
    state: "delivered",
    attemptCount: 1,
    maxAttempts: 5,
    idempotencyKey: "idem-p101-1",
    payloadSha256: "a".repeat(64),
    identityTriple: {
      customerId: "RP-CUST-000008",
      orderId: "RP-C000008-2611-5E4A2D",
      runMode: "production",
    },
    packet: "7",
    tier: "Mixed",
    bundleScopeManifest: '{"packet_1":"Premium","packet_2":"Basic"}',
    releaseStatus: "",
    httpStatus: 202,
    responseSummary: "Accepted for Phase I intake",
    lastReasonCode: null,
    resendReason: null,
    retryOf: null,
    redeliveryOf: null,
    requestedByPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMH",
    correlationId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    deliveredAt: occurredAt,
    finalizedAt: occurredAt,
  };

  const failedP201Dispatch: ProductionDispatchItem = {
    ...sampleDispatch,
    publicId: failedDispatchId,
    phase: "P201",
    state: "dead",
    attemptCount: 5,
    maxAttempts: 5,
    packet: null,
    tier: null,
    bundleScopeManifest: null,
    httpStatus: 503,
    responseSummary: "Upstream receiver unavailable after 5 attempts",
    lastReasonCode: "UPSTREAM_5XX",
    deliveredAt: null,
    createdAt: laterAt,
    updatedAt: laterAt,
    finalizedAt: laterAt,
  };

  const redeliveredDispatch: ProductionDispatchItem = {
    ...sampleDispatch,
    publicId: redeliveredDispatchId,
    idempotencyKey: "idem-p101-redeliver-1",
    redeliveryOf: deliveredDispatchId,
    resendReason: "Downstream worker lost disk volume after accepting HTTP 202",
    createdAt: laterAt,
    updatedAt: laterAt,
    deliveredAt: laterAt,
    finalizedAt: laterAt,
  };

  const unknownDispatch: ProductionDispatchItem = {
    ...sampleDispatch,
    publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMU",
    state: "unknown",
    httpStatus: null,
    responseSummary: "Interrupted during delivery — verify downstream before re-sending.",
    lastReasonCode: "PRODUCTION_DELIVERY_INTERRUPTED",
    deliveredAt: null,
  };

  const canonicalContinuationPayload = {
    customer_id: "RP-CUST-000008",
    order_id: "RP-C000008-2611-5E4A2D",
    run_mode: "production",
  };

  const makeLaterPhase = (
    phase: "P301" | "P401",
    configured: boolean,
    delivered: boolean,
    prerequisiteDelivered: boolean,
  ): ProductionLaterPhasePreview => ({
    configured,
    eligible:
      !mockState.unconfigured &&
      !mockState.pipelineOff &&
      configured &&
      prerequisiteDelivered &&
      !delivered,
    p101Delivered: mockState.p101Delivered,
    prerequisiteDelivered,
    alreadyDelivered: delivered,
    activeState: null,
    validationErrors: [],
    disabledReasons: !configured
      ? [
          {
            code: `${phase}_ENDPOINT_MISSING`,
            category: "endpoint_missing",
            message: `${phase} endpoint is not configured.`,
            settingsActionable: true,
          },
        ]
      : !prerequisiteDelivered
        ? [
            {
              code: `${phase}_PREREQUISITE_MISSING`,
              category: "precondition",
              message: `Complete earlier pipeline phases before starting ${phase}.`,
              settingsActionable: false,
            },
          ]
        : [],
    payload: mockState.p101Delivered ? canonicalContinuationPayload : null,
  });

  const makePreview = (): ProductionOrderPreview => {
    const featureConfigured = !mockState.unconfigured;
    const featureEnabled = featureConfigured && !mockState.pipelineOff;
    const p301Prereq = mockState.p101Delivered && mockState.p201Delivered;
    const p401Prereq =
      mockState.p101Delivered &&
      mockState.p201Delivered &&
      (!mockState.p301Configured || mockState.p301Delivered);

    return {
      featureEnabled,
      featureConfigured,
      settingsHref: "/admin/integrations/production",
      p101: {
        configured: featureConfigured,
        eligible:
          featureEnabled &&
          !mockState.p101Delivered &&
          !mockState.p101Failed &&
          !mockState.p101Unknown &&
          !mockState.ineligibleOrder,
        alreadyDelivered: mockState.p101Delivered,
        activeState: mockState.p101Unknown
          ? "unknown"
          : mockState.p101Failed
            ? "dead"
            : null,
        validationErrors: mockState.ineligibleOrder
          ? [
              {
                code: "NON_PACKET_ITEMS",
                message: "Orders containing non-packet line items cannot be sent to P101.",
              },
            ]
          : [],
        disabledReasons: !featureConfigured
          ? [
              {
                code: "PIPELINE_NOT_CONFIGURED",
                category: "endpoint_missing",
                message: "Phase I (P101) endpoint and canon version must be configured first.",
                settingsActionable: true,
              },
            ]
          : !featureEnabled
            ? [
                {
                  code: "PIPELINE_DISABLED",
                  category: "pipeline_off",
                  message: "Production pipeline webhooks are currently switched off.",
                  settingsActionable: true,
                },
              ]
            : mockState.ineligibleOrder
              ? [
                  {
                    code: "NON_PACKET_ITEMS",
                    category: "precondition",
                    message: "Orders containing non-packet line items cannot be sent to P101.",
                    settingsActionable: false,
                  },
                ]
              : mockState.p101Delivered
                ? [
                    {
                      code: "P101_ALREADY_DELIVERED",
                      category: "already_delivered",
                      message: "Phase I (P101) has already been delivered for this order.",
                      settingsActionable: false,
                    },
                  ]
                : [],
        payload: mockState.ineligibleOrder
          ? null
          : {
              customer_id: "RP-CUST-000008",
              order_id: "RP-C000008-2611-5E4A2D",
              packet: "7",
              tier: "Mixed",
              canon_version: "ReadyPackets_Production_v2.0",
              run_mode: "production",
              client_name: mockState.staffViewer ? "J*** W***" : "John Wick",
              client_email: mockState.staffViewer ? "j***@example.test" : "john@example.test",
              release_status: "",
              bundle_scope_manifest: '{"packet_1":"Premium","packet_2":"Basic"}',
            },
        maskedForViewer: mockState.staffViewer,
      },
      p201: {
        configured: featureConfigured,
        eligible:
          featureEnabled &&
          mockState.p101Delivered &&
          !mockState.p201Delivered &&
          !mockState.p201Failed,
        p101Delivered: mockState.p101Delivered,
        alreadyDelivered: mockState.p201Delivered,
        activeState: mockState.p201Failed ? "dead" : null,
        validationErrors: [],
        disabledReasons: !featureConfigured
          ? [
              {
                code: "P201_ENDPOINT_MISSING",
                category: "endpoint_missing",
                message: "Phase II (P201) webhook endpoint is not configured.",
                settingsActionable: true,
              },
            ]
          : !featureEnabled
            ? [
                {
                  code: "PIPELINE_DISABLED",
                  category: "pipeline_off",
                  message: "Production pipeline webhooks are currently switched off.",
                  settingsActionable: true,
                },
              ]
            : !mockState.p101Delivered
              ? [
                  {
                    code: "P101_REQUIRED_FIRST",
                    category: "precondition",
                    message: "Deliver Phase I (P101) before starting Phase II (P201).",
                    settingsActionable: false,
                  },
                ]
              : mockState.p201Failed
                ? [
                    {
                      code: "P201_RETRY_FROM_HISTORY",
                      category: "retry_or_resend_required",
                      message: "Phase II failed delivery; retry it from this order's pipeline history.",
                      settingsActionable: false,
                    },
                  ]
                : [],
        payload: mockState.p101Delivered ? canonicalContinuationPayload : null,
      },
      p301: makeLaterPhase("P301", mockState.p301Configured, mockState.p301Delivered, p301Prereq),
      p401: makeLaterPhase("P401", mockState.p401Configured, mockState.p401Delivered, p401Prereq),
    };
  };

  const makeHistoryItems = (): ProductionDispatchItem[] => {
    if (mockState.emptyDispatches) return [];
    if (mockState.p101Unknown) return [unknownDispatch];
    const rows: ProductionDispatchItem[] = [];
    if (mockState.hasRedeliveryRow) rows.push(redeliveredDispatch);
    if (mockState.p201Failed) rows.push(failedP201Dispatch);
    if (mockState.p101Delivered) rows.push(sampleDispatch);
    return rows;
  };

  const endpoint = <TInput, TOut>(name: string, fn: (input: TInput) => TOut) => ({
    queryOptions: (input?: TInput) => ({
      queryKey: ["integrations", "production", name, input],
      queryFn: async () => {
        if (mockState.broken) throw new Error("private database detail");
        return fn(input as TInput);
      },
    }),
    queryKey: (input?: TInput) => ["integrations", "production", name, input],
  });

  const productionProxy = {
    pathKey: () => ["integrations", "production"],
    settings: {
      get: endpoint("settings.get", () => makeSettings()),
      update: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: updateSettings }) },
      test: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: testDestination }) },
    },
    order: {
      pathKey: () => ["integrations", "production", "order"],
      preview: endpoint("order.preview", () => makePreview()),
      history: endpoint("order.history", () => ({ items: makeHistoryItems() })),
      requestP101: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP101 }) },
      requestP201: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP201 }) },
      requestP301: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP301 }) },
      requestP401: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP401 }) },
      retry: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: retryDispatch }) },
      redeliver: {
        mutationOptions: (opts?: object) => ({ ...opts, mutationFn: redeliverDispatch }),
      },
      resend: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: resendDispatch }) },
    },
    admin: {
      listDispatches: endpoint("admin.listDispatches", (input: unknown) => {
        listDispatchesSpy(input);
        return {
          items: mockState.emptyDispatches
            ? []
            : mockState.p101Unknown
              ? [unknownDispatch]
              : mockState.hasRedeliveryRow
                ? [redeliveredDispatch, sampleDispatch]
                : [sampleDispatch],
        };
      }),
    },
  };

  const clientProxy = {
    integrations: {
      production: {
        settings: {
          update: { mutate: updateSettings },
          test: { mutate: testDestination },
        },
        order: {
          requestP101: { mutate: requestP101 },
          requestP201: { mutate: requestP201 },
          requestP301: { mutate: requestP301 },
          requestP401: { mutate: requestP401 },
          retry: { mutate: retryDispatch },
          redeliver: { mutate: redeliverDispatch },
          resend: { mutate: resendDispatch },
        },
      },
    },
  };

  return {
    safeError: (error: { data?: { safe?: unknown } } | undefined) => error?.data?.safe,
    errorMessage: (
      error: { data?: { safe?: { safeMessage?: string } } } | undefined,
      fallback?: string,
    ) => error?.data?.safe?.safeMessage ?? fallback ?? "Something went wrong.",
    useTRPC: () => ({ integrations: { production: productionProxy } }),
    useTRPCClient: () => clientProxy,
  };
});

function sessionFor(role: "customer" | "staff" | "admin"): MeResult {
  return {
    user: {
      publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMJ",
      role,
      name: "Alex Operator",
      email: "alex@example.test",
      status: "active",
    },
    state: "full",
    pendingSteps: [],
    nextStep: null,
  };
}

function AutomationOrderHostPage() {
  return (
    <>
      <PageHeader
        title="Order RP-C000008-2611-5E4A2D"
        description="Console order workspace — Automation tab"
      />
      <OrderProductionTab
        orderId={orderPublicId}
        area="console"
        stageActionsSlot={
          <section aria-label="Workflow stage actions">
            <h2 className="text-base font-semibold text-ink">Workflow stage actions</h2>
            <p className="text-sm text-body">2 configured actions ready for this stage.</p>
          </section>
        }
      />
    </>
  );
}

const orderAutomationTestRoutes: readonly RouteDef[] = [
  {
    path: "/admin/orders/:orderId/automation",
    title: "Order automation",
    access: "staff",
    component: AutomationOrderHostPage,
  },
];

beforeEach(() => {
  mockState.broken = false;
  mockState.emptyDispatches = false;
  mockState.p101Delivered = false;
  mockState.p101Failed = false;
  mockState.p101Unknown = false;
  mockState.p201Delivered = false;
  mockState.p201Failed = false;
  mockState.p301Configured = false;
  mockState.p301Delivered = false;
  mockState.p401Configured = false;
  mockState.p401Delivered = false;
  mockState.hasRedeliveryRow = false;
  mockState.ineligibleOrder = false;
  mockState.staffViewer = true;
  mockState.unconfigured = false;
  mockState.pipelineOff = false;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Production & Automation UI — WCAG 2.2 AA pageA11y (light & dark)", () => {
  pageA11y("/admin/integrations/production ready", async () => {
    mockState.p301Configured = true;
    mockState.hasRedeliveryRow = true;
    renderUi(<AppRoutes routes={productionAdminRoutes} />, {
      path: "/admin/integrations/production",
      api: fakeAuthApi({ me: async () => sessionFor("admin") }),
    });
    await screen.findByRole("heading", { level: 1, name: "Production pipeline" }, { timeout: 5000 });
    await screen.findByLabelText("Phase III (P301) webhook URL (optional)", {}, { timeout: 5000 });
  });

  pageA11y("/admin/orders/:orderId/automation ready", async () => {
    mockState.p101Delivered = true;
    mockState.p201Failed = true;
    mockState.p301Configured = true;
    mockState.staffViewer = false;
    renderUi(<AppRoutes routes={orderAutomationTestRoutes} />, {
      path: `/admin/orders/${orderPublicId}/automation`,
      api: fakeAuthApi({ me: async () => sessionFor("admin") }),
    });
    await screen.findByRole(
      "heading",
      { level: 1, name: "Order RP-C000008-2611-5E4A2D" },
      { timeout: 5000 },
    );
    await screen.findByRole(
      "heading",
      { name: "This order's pipeline history" },
      { timeout: 5000 },
    );
  });

  pageA11y("/admin/orders/:orderId/automation redeliver dialog open", async () => {
    mockState.p101Delivered = true;
    mockState.staffViewer = false;
    renderUi(<AppRoutes routes={orderAutomationTestRoutes} />, {
      path: `/admin/orders/${orderPublicId}/automation`,
      api: fakeAuthApi({ me: async () => sessionFor("admin") }),
    });
    await screen.findByRole("heading", { level: 1, name: "Order RP-C000008-2611-5E4A2D" });
    const historyTable = await screen.findByRole("table", {
      name: "This order's pipeline history",
    });
    const redeliverBtn = within(historyTable).getByRole("button", {
      name: "Redeliver Phase I intake (P101)",
    });
    fireEvent.click(redeliverBtn);
    await screen.findByRole("dialog", { name: "Redeliver Phase I intake (P101)" });
  });
});

describe("Production pipeline & Order Automation tab (Part B T1 / B4)", () => {
  it("renames the console order tab to Automation (key automation, order 50) and renders nothing for customers", () => {
    expect(productionAdminRoutes[0]).toMatchObject({
      path: "/admin/integrations/production",
      access: "admin",
      capability: "integrations.manage",
      title: "Production pipeline",
    });
    expect(productionAdminNav[0]).toMatchObject({
      href: "/admin/integrations/production",
      group: "Platform",
      access: "admin",
      capability: "integrations.manage",
    });
    expect(productionOrderTabs[0]).toMatchObject({
      key: "automation",
      label: "Automation",
      access: "staff",
      order: 50,
    });

    renderUi(
      <OrderProductionTab orderId={orderPublicId} area="customer" stageActionsSlot={null} />,
      { api: fakeAuthApi({ me: async () => sessionFor("customer") }) },
    );
    expect(screen.queryByRole("heading", { name: /Phase I/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start Phase/ })).toBeNull();
  });

  it("renders optional P301/P401 fields on Production pipeline settings, validates HTTPS, tests P301 destination, and links orders to /automation", async () => {
    mockState.p301Configured = true;
    const stepUp = vi.fn().mockResolvedValue(undefined);
    updateSettings
      .mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockResolvedValueOnce({});
    const dryRunResult: ProductionDestinationTestResult = {
      phase: "P301",
      allowed: true,
      reasonCode: "ALLOWED",
      safeMessage: "Destination resolved and matched an active webhook allowlist rule.",
      host: "hooks.example.test",
      resolvedAddresses: ["203.0.113.25"],
      matchedAllowlistRulePublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMK",
      checkedAt: new Date("2026-11-20T12:05:00Z"),
    };
    testDestination.mockResolvedValueOnce(dryRunResult);

    const { container } = renderUi(<ProductionPipelinePage />, {
      path: "/admin/integrations/production",
      api: fakeAuthApi({ me: async () => sessionFor("admin"), stepUp }),
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Production pipeline" }),
    ).toBeTruthy();
    expect(await screen.findByText(/https:\/\/hooks\.example\.test\/…9f2a/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/hooks\.example\.test\/…3c01/)).toBeTruthy();

    const orderLinks = await screen.findAllByRole("link", { name: "RP-C000008-2611-5E4A2D" });
    expect(orderLinks[0]?.getAttribute("href")).toBe(`/admin/orders/${orderPublicId}/automation`);
    await expectNoAxeViolations(container);

    // Block non-HTTPS Phase III URL before calling server
    fireEvent.change(screen.getByLabelText("Phase III (P301) webhook URL (optional)"), {
      target: { value: "http://insecure.example.test/p301" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/valid HTTPS webhook URL/)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();

    // Valid HTTPS URLs on P101 and optional P301/P401 trigger step-up and save
    fireEvent.change(screen.getByLabelText("Phase I (P101) webhook URL"), {
      target: { value: "https://hooks.example.test/p101-rotated-secret" },
    });
    fireEvent.change(screen.getByLabelText("Phase III (P301) webhook URL (optional)"), {
      target: { value: "https://hooks.example.test/p301-secret" },
    });
    fireEvent.change(screen.getByLabelText("Phase IV (P401) webhook URL (optional)"), {
      target: { value: "https://hooks.example.test/p401-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const verifyDialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(verifyDialog).getByLabelText(/Password/), {
      target: { value: "synthetic-password" },
    });
    fireEvent.change(within(verifyDialog).getByLabelText(/6-digit code/), {
      target: { value: "123456" },
    });
    fireEvent.click(within(verifyDialog).getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          canonVersion: "ReadyPackets_Production_v2.0",
          runMode: "production",
          timeoutMs: 12_000,
          p101Url: "https://hooks.example.test/p101-rotated-secret",
          p301Url: "https://hooks.example.test/p301-secret",
          p401Url: "https://hooks.example.test/p401-secret",
        }),
      ),
    );
    expect(stepUp).toHaveBeenCalledOnce();

    // Dry-run destination test for Phase III (P301)
    fireEvent.click(screen.getByRole("button", { name: "Test Phase III (P301) destination" }));
    expect(await screen.findByText("Phase III start (P301) allowed")).toBeTruthy();
    expect(testDestination).toHaveBeenCalledWith({ phase: "P301" });

    // Filter dispatches by P301
    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "P301" } });
    await waitFor(() =>
      expect(listDispatchesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "P301", limit: 50 }),
      ),
    );
  });

  it("shows explicit disabled reasons on P101/P201 and renders pipeline settings links only for administrators", async () => {
    mockState.pipelineOff = true;

    const staffView = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("staff") }),
      },
    );

    expect(
      (await screen.findAllByText("Production pipeline webhooks are currently switched off."))
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (screen.getByRole("button", { name: "Start Phase I" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Start Phase II" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /pipeline settings|Configure production pipeline/i })).toBeNull();
    staffView.unmount();

    mockState.staffViewer = false;
    renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("admin") }),
      },
    );

    const settingsLinks = await screen.findAllByRole("link", {
      name: /Open pipeline settings|Configure production pipeline/,
    });
    expect(settingsLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of settingsLinks) {
      expect(link.getAttribute("href")).toBe("/admin/integrations/production");
    }
  });

  it("mounts the Workflow stage actions slot at the top, shows Webhook rules, hides unconfigured Phase III/IV, and walks staff through Phase I & II", async () => {
    requestP101.mockImplementation(async () => {
      mockState.p101Delivered = true;
      return {};
    });
    requestP201.mockImplementation(async () => {
      mockState.p201Delivered = true;
      return {};
    });

    const { container } = renderUi(
      <OrderProductionTab
        orderId={orderPublicId}
        area="console"
        stageActionsSlot={
          <section aria-label="Workflow stage actions">
            <h2>Workflow stage actions</h2>
            <p>1 configured action</p>
          </section>
        }
      />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("staff") }),
      },
    );

    expect(await screen.findByRole("heading", { name: "Workflow stage actions" })).toBeTruthy();
    const rulesHeading = screen.getByRole("heading", { name: "Webhook rules" });
    const rulesSection = rulesHeading.closest("section")!;
    expect(within(rulesSection).getByText("bundle_scope_manifest")).toBeTruthy();
    expect(
      within(rulesSection).getByText(
        /Do not start Phase II.*before the Phase I final output artifacts exist/i,
      ),
    ).toBeTruthy();

    // Unconfigured Phase III / IV buttons must be absent
    expect(screen.queryByRole("button", { name: "Start Phase III" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start Phase IV" })).toBeNull();

    // Phase II disabled with explicit reason before Phase I delivery
    const startP201Before = screen.getByRole("button", { name: "Start Phase II" });
    expect((startP201Before as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Deliver Phase I (P101) before starting Phase II (P201)."),
    ).toBeTruthy();
    await expectNoAxeViolations(container);

    // Start Phase I
    fireEvent.change(screen.getByLabelText("Release status label"), {
      target: { value: "rc_v4_smoke" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Phase I" }));
    const confirmP101 = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmP101).getByRole("button", { name: "Start Phase I" }));
    await waitFor(() =>
      expect(requestP101).toHaveBeenCalledWith({
        orderPublicId,
        releaseStatus: "rc_v4_smoke",
      }),
    );

    // Phase I delivered: Phase II shows artifact-confirmation disabled reason until checked
    expect(
      await screen.findByText(
        "Confirm the Phase I final output artifacts exist before starting Phase II.",
      ),
    ).toBeTruthy();
    const startP201Btn = screen.getByRole("button", { name: "Start Phase II" }) as HTMLButtonElement;
    expect(startP201Btn.disabled).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I confirm the Phase I final output artifacts exist for this order ID/,
      }),
    );
    expect(startP201Btn.disabled).toBe(false);

    fireEvent.click(startP201Btn);
    const confirmP201 = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmP201).getByRole("button", { name: "Start Phase II" }));
    await waitFor(() =>
      expect(requestP201).toHaveBeenCalledWith({
        orderPublicId,
        phase1ArtifactsConfirmed: true,
      }),
    );
  });

  it("renders Start Phase III and Start Phase IV when configured and triggers requestP301 / requestP401", async () => {
    mockState.p101Delivered = true;
    mockState.p201Delivered = true;
    mockState.p301Configured = true;
    mockState.p401Configured = true;

    requestP301.mockImplementation(async () => {
      mockState.p301Delivered = true;
      return {};
    });
    requestP401.mockImplementation(async () => {
      mockState.p401Delivered = true;
      return {};
    });

    renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("staff") }),
      },
    );

    const startP301 = (await screen.findByRole("button", {
      name: "Start Phase III",
    })) as HTMLButtonElement;
    const startP401Before = screen.getByRole("button", {
      name: "Start Phase IV",
    }) as HTMLButtonElement;
    expect(startP301.disabled).toBe(false);
    // P401 waits for configured P301 to be delivered first
    expect(startP401Before.disabled).toBe(true);

    fireEvent.click(startP301);
    const dialog3 = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog3).getByRole("button", { name: "Start Phase III" }));
    await waitFor(() => expect(requestP301).toHaveBeenCalledWith({ orderPublicId }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start Phase IV" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Phase IV" }));
    const dialog4 = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog4).getByRole("button", { name: "Start Phase IV" }));
    await waitFor(() => expect(requestP401).toHaveBeenCalledWith({ orderPublicId }));
  });

  it("supports staff Retry for failed dispatches and admin-only step-up Redeliver requiring reason + exact typed REDELIVER", async () => {
    mockState.p101Delivered = true;
    mockState.p201Failed = true;
    retryDispatch.mockResolvedValueOnce({});

    // 1. Staff can Retry failed P201, but NEVER sees Redeliver on delivered P101
    const staffRender = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("staff") }),
      },
    );

    expect(await screen.findByRole("heading", { name: "This order's pipeline history" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Redeliver/ })).toBeNull();

    const retryButtons = screen.getAllByRole("button", { name: "Retry Phase II start (P201)" });
    fireEvent.click(retryButtons[0]!);
    await waitFor(() =>
      expect(retryDispatch).toHaveBeenCalledWith({
        orderPublicId,
        dispatchPublicId: failedDispatchId,
      }),
    );
    staffRender.unmount();

    // 2. Admin sees Redeliver on delivered P101, manages keyboard focus on cancel & step-up cancel, preserves idempotencyKey across step-up cancel + ambiguous retry, and issues a fresh key for a new dialog intent
    const user = userEvent.setup();
    mockState.staffViewer = false;
    const stepUp = vi.fn().mockResolvedValue(undefined);
    redeliverDispatch
      .mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockRejectedValueOnce({
        data: { safe: { safeMessage: "Temporary gateway timeout while confirming redelivery." } },
      })
      .mockImplementationOnce(async () => {
        mockState.hasRedeliveryRow = true;
        return {};
      })
      .mockResolvedValueOnce({});

    const adminRender = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("admin"), stepUp }),
      },
    );

    const historyTable = await screen.findByRole("table", {
      name: "This order's pipeline history",
    });
    const launcher = within(historyTable).getByRole("button", {
      name: "Redeliver Phase I intake (P101)",
    });

    // Open dialog via keyboard and verify initial focus moves inside dialog
    launcher.focus();
    expect(document.activeElement).toBe(launcher);
    await user.keyboard("{Enter}");

    const firstOpenDialog = await screen.findByRole("dialog", {
      name: "Redeliver Phase I intake (P101)",
    });
    await waitFor(() => expect(firstOpenDialog.contains(document.activeElement)).toBe(true));

    // Escape cancels the dialog and restores focus to the exact per-dispatch launcher button
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Redeliver Phase I intake (P101)" })).toBeNull(),
    );
    expect(document.activeElement).toBe(launcher);

    // Re-open via keyboard to test validation, step-up cancel focus return, and step-up verify
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Redeliver Phase I intake (P101)" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const confirmBtn = within(dialog).getByRole("button", {
      name: "Confirm redelivery",
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Reason alone or lowercase "redeliver" keeps Confirm redelivery disabled
    fireEvent.change(within(dialog).getByLabelText(/Reason for redelivery/), {
      target: { value: "Downstream worker lost disk volume after accepting HTTP 202" },
    });
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Type REDELIVER to confirm/), {
      target: { value: "redeliver" },
    });
    expect(confirmBtn.disabled).toBe(true);

    // Exact uppercase REDELIVER enables submission
    fireEvent.change(within(dialog).getByLabelText(/Type REDELIVER to confirm/), {
      target: { value: "REDELIVER" },
    });
    expect(confirmBtn.disabled).toBe(false);
    await expectNoAxeViolations(adminRender.container);

    // First submit opens step-up overlay; cancelling step-up keeps Redeliver dialog open and restores focus inside it
    fireEvent.click(confirmBtn);
    const cancelledVerifyDialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(cancelledVerifyDialog).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Redeliver Phase I intake (P101)" })).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(stepUp).not.toHaveBeenCalled();

    // Second submit completes step-up verification, hits an ambiguous gateway error, and retries inside the SAME dialog with the SAME idempotencyKey
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm redelivery" }));
    const verifyDialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(verifyDialog).getByLabelText(/Password/), {
      target: { value: "synthetic-password" },
    });
    fireEvent.change(within(verifyDialog).getByLabelText(/6-digit code/), {
      target: { value: "123456" },
    });
    fireEvent.click(within(verifyDialog).getByRole("button", { name: "Verify" }));

    expect(
      await within(dialog).findByText("Temporary gateway timeout while confirming redelivery."),
    ).toBeTruthy();

    // Retry inside the same open dialog succeeds and reuses the exact same operator idempotencyKey
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm redelivery" }));

    await waitFor(() => expect(redeliverDispatch).toHaveBeenCalledTimes(4));
    expect(stepUp).toHaveBeenCalledOnce();

    const intentKeysFirstDialog = redeliverDispatch.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );
    const firstIntentKey = intentKeysFirstDialog[0]!;
    expect(firstIntentKey).toMatch(/^[A-Za-z0-9:_-]{8,64}$/);
    expect(new Set(intentKeysFirstDialog)).toEqual(new Set([firstIntentKey]));
    expect(redeliverDispatch).toHaveBeenLastCalledWith({
      orderPublicId,
      dispatchPublicId: deliveredDispatchId,
      reason: "Downstream worker lost disk volume after accepting HTTP 202",
      confirmation: "REDELIVER",
      idempotencyKey: firstIntentKey,
    });

    // Resulting new delivery row displays `Redelivery of …` badge in pipeline history
    expect(
      (await screen.findAllByText(`Redelivery of …${deliveredDispatchId.slice(-6)}`)).length,
    ).toBeGreaterThanOrEqual(1);

    // Opening a brand-new Redeliver dialog later issues a fresh, distinct idempotencyKey
    const refreshedTable = await screen.findByRole("table", {
      name: "This order's pipeline history",
    });
    const secondLaunchButtons = within(refreshedTable).getAllByRole("button", {
      name: "Redeliver Phase I intake (P101)",
    });
    fireEvent.click(secondLaunchButtons[0]!);
    const secondDialog = await screen.findByRole("dialog", {
      name: "Redeliver Phase I intake (P101)",
    });
    fireEvent.change(within(secondDialog).getByLabelText(/Reason for redelivery/), {
      target: { value: "Second independent redelivery after upstream fix" },
    });
    fireEvent.change(within(secondDialog).getByLabelText(/Type REDELIVER to confirm/), {
      target: { value: "REDELIVER" },
    });
    fireEvent.click(within(secondDialog).getByRole("button", { name: "Confirm redelivery" }));

    await waitFor(() => expect(redeliverDispatch).toHaveBeenCalledTimes(5));
    const fifthCallArg = redeliverDispatch.mock.calls[4]![0] as { idempotencyKey: string };
    expect(fifthCallArg.idempotencyKey).toMatch(/^[A-Za-z0-9:_-]{8,64}$/);
    expect(fifthCallArg.idempotencyKey).not.toBe(firstIntentKey);
  });

  it("blocks ineligible orders, hides private error details on ErrorState, and preserves PW-02 Outcome unknown warning", async () => {
    mockState.ineligibleOrder = true;
    const ineligible = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      { api: fakeAuthApi({ me: async () => sessionFor("staff") }) },
    );
    expect(
      (await screen.findAllByText(/Orders containing non-packet line items cannot be sent to P101/))
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (screen.getByRole("button", { name: "Start Phase I" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    ineligible.unmount();

    mockState.ineligibleOrder = false;
    mockState.broken = true;
    const broken = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      { api: fakeAuthApi({ me: async () => sessionFor("staff") }) },
    );
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByText("No production dispatches for this order")).toBeNull();
    expect(screen.queryByText("private database detail")).toBeNull();
    broken.unmount();

    mockState.broken = false;
    mockState.p101Unknown = true;
    mockState.staffViewer = false;
    renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" stageActionsSlot={null} />,
      {
        path: `/admin/orders/${orderPublicId}/automation`,
        api: fakeAuthApi({ me: async () => sessionFor("admin") }),
      },
    );
    expect((await screen.findAllByText("Outcome unknown")).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "Re-send Phase I" }));
    const resendDialog = await screen.findByRole("dialog", {
      name: "Re-send Phase I intake (P101)",
    });
    expect(
      within(resendDialog).getByText(
        /Verify downstream workflow executions and output folders before re-sending/i,
      ),
    ).toBeTruthy();
  });
});
