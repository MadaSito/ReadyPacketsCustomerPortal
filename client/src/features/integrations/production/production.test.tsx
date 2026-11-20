// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResult } from "@/lib/authApi";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import {
  productionAdminNav,
  productionAdminRoutes,
  productionOrderTabs,
} from "./index";
import type {
  ProductionDestinationTestResult,
  ProductionDispatchItem,
  ProductionOrderPreview,
  ProductionSettingsView,
} from "./model";
import OrderProductionTab from "./OrderProductionTab";
import ProductionPipelinePage from "./ProductionPipelinePage";

const {
  orderPublicId,
  correlationId,
  mockState,
  updateSettings,
  testDestination,
  requestP101,
  requestP201,
  resendDispatch,
  listDispatchesSpy,
} = vi.hoisted(() => ({
  orderPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZME",
  correlationId: "01JAFJ8VEGZ9GPVRR2S9KTYZMF",
  mockState: {
    broken: false,
    emptyDispatches: false,
    p101Delivered: false,
    p101Unknown: false,
    p201Delivered: false,
    ineligibleOrder: false,
    staffViewer: true,
    unconfigured: false,
  },
  updateSettings: vi.fn(),
  testDestination: vi.fn(),
  requestP101: vi.fn(),
  requestP201: vi.fn(),
  resendDispatch: vi.fn(),
  listDispatchesSpy: vi.fn(),
}));

vi.mock("@/lib/trpc", () => {
  const occurredAt = new Date("2026-11-20T12:00:00Z");

  const makeSettings = (): ProductionSettingsView =>
    mockState.unconfigured
      ? {
          enabled: false,
          configured: false,
          state: "not_configured",
          summary: "Configure both HTTPS webhook URLs and a canon version to enable.",
          p101UrlConfigured: false,
          p101UrlMask: null,
          p201UrlConfigured: false,
          p201UrlMask: null,
          authHeaderName: "",
          authHeaderValueConfigured: false,
          canonVersion: "",
          runMode: "production",
          timeoutMs: 10_000,
        }
      : {
          enabled: true,
          configured: true,
          state: "configured",
          summary: "Both webhook endpoints and canon version are configured.",
          p101UrlConfigured: true,
          p101UrlMask: { host: "hooks.example.test", last4: "9f2a" },
          p201UrlConfigured: true,
          p201UrlMask: { host: "hooks.example.test", last4: "4b8c" },
          authHeaderName: "X-Webhook-Token",
          authHeaderValueConfigured: true,
          canonVersion: "ReadyPackets_Production_v2.0",
          runMode: "production",
          timeoutMs: 12_000,
        };

  const sampleDispatch: ProductionDispatchItem = {
    publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMG",
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
    requestedByPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMH",
    correlationId,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    deliveredAt: occurredAt,
    finalizedAt: occurredAt,
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

  const makePreview = (): ProductionOrderPreview => ({
    featureEnabled: !mockState.unconfigured,
    featureConfigured: !mockState.unconfigured,
    p101: {
      eligible: !mockState.p101Delivered && !mockState.p101Unknown && !mockState.ineligibleOrder,
      alreadyDelivered: mockState.p101Delivered,
      activeState: mockState.p101Unknown ? "unknown" : null,
      validationErrors: mockState.ineligibleOrder
        ? [{ code: "NON_PACKET_ITEMS", message: "Orders containing non-packet line items cannot be sent to P101." }]
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
      eligible: mockState.p101Delivered && !mockState.p201Delivered,
      p101Delivered: mockState.p101Delivered,
      alreadyDelivered: mockState.p201Delivered,
      activeState: null,
      validationErrors: [],
      payload: mockState.p101Delivered
        ? {
            customer_id: "RP-CUST-000008",
            order_id: "RP-C000008-2611-5E4A2D",
            run_mode: "production",
          }
        : null,
    },
  });

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
      history: endpoint("order.history", () => ({
        items: mockState.p101Unknown
          ? [unknownDispatch]
          : mockState.p101Delivered
            ? [sampleDispatch]
            : [],
      })),
      requestP101: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP101 }) },
      requestP201: { mutationOptions: (opts?: object) => ({ ...opts, mutationFn: requestP201 }) },
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

function sessionFor(role: "customer" | "staff" | "admin") {
  const meResult: MeResult = {
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
  return meResult;
}

beforeEach(() => {
  mockState.broken = false;
  mockState.emptyDispatches = false;
  mockState.p101Delivered = false;
  mockState.p101Unknown = false;
  mockState.p201Delivered = false;
  mockState.ineligibleOrder = false;
  mockState.staffViewer = true;
  mockState.unconfigured = false;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Production pipeline webhooks UI", () => {
  it("exports admin route, console nav, and console-only order tab that never renders for customers", () => {
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
      key: "production",
      label: "Production",
      access: "staff",
    });

    renderUi(
      <OrderProductionTab orderId={orderPublicId} area="customer" />,
      { api: fakeAuthApi({ me: async () => sessionFor("customer") }) },
    );
    expect(screen.queryByRole("heading", { name: /Phase I/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start Phase/ })).toBeNull();
  });

  it("renders the admin Production pipeline page, enforces HTTPS/canon rules, steps up save & dry-run test, and has no axe violations", async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    updateSettings
      .mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockResolvedValueOnce({});
    const dryRunResult: ProductionDestinationTestResult = {
      phase: "P101",
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
    expect(screen.getByLabelText("Phase I (P101) webhook URL")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Authorization header value")).toHaveProperty("value", "");
    expect(
      (await screen.findAllByRole("link", { name: "RP-C000008-2611-5E4A2D" })).length,
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(container);

    // Block non-HTTPS webhook URL before calling server
    fireEvent.change(screen.getByLabelText("Phase I (P101) webhook URL"), {
      target: { value: "http://insecure.example.test/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/valid HTTPS webhook URL/)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();

    // Valid HTTPS URL triggers step-up and saves
    fireEvent.change(screen.getByLabelText("Phase I (P101) webhook URL"), {
      target: { value: "https://hooks.example.test/p101-rotated-secret" },
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
        }),
      ),
    );
    expect(stepUp).toHaveBeenCalledOnce();

    // Dry-run destination test
    fireEvent.click(screen.getByRole("button", { name: "Test Phase I (P101) destination" }));
    expect(await screen.findByText("Phase I intake (P101) allowed")).toBeTruthy();
    expect(screen.getByText("203.0.113.25")).toBeTruthy();
    expect(testDestination).toHaveBeenCalledWith({ phase: "P101" });

    // Filter dispatches by phase
    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "P201" } });
    await waitFor(() =>
      expect(listDispatchesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "P201", limit: 50 }),
      ),
    );
  });

  it("shows ErrorState rather than empty/zero state when admin settings fail to load", async () => {
    mockState.broken = true;
    renderUi(<ProductionPipelinePage />, {
      path: "/admin/integrations/production",
      api: fakeAuthApi({ me: async () => sessionFor("admin") }),
    });
    expect((await screen.findAllByRole("button", { name: /try again|retry/i })).length).toBeGreaterThan(0);
    expect(screen.queryByText("private database detail")).toBeNull();
    expect(screen.queryByText("No production dispatches recorded")).toBeNull();
  });

  it("walks staff through Phase I start and Phase II artifact confirmation without exposing admin re-send or order_scope_mode", async () => {
    requestP101.mockImplementation(async () => {
      mockState.p101Delivered = true;
      return {};
    });
    requestP201.mockImplementation(async () => {
      mockState.p201Delivered = true;
      return {};
    });

    const { container } = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" />,
      {
        path: `/admin/orders/${orderPublicId}/production`,
        api: fakeAuthApi({ me: async () => sessionFor("staff") }),
      },
    );

    expect(await screen.findByRole("heading", { name: "Phase I intake (P101)" })).toBeTruthy();
    expect(screen.getByText(/Client name and email are masked in this preview for staff/)).toBeTruthy();
    expect(screen.queryByText(/order_scope_mode/)).toBeNull();
    expect(screen.getAllByText(/bundle_scope_manifest/).length).toBeGreaterThan(0);

    // Phase II cannot be started before Phase I is delivered
    const startP201Before = screen.getByRole("button", { name: "Start Phase II" });
    expect((startP201Before as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Re-send/ })).toBeNull();
    await expectNoAxeViolations(container);

    // Trigger Phase I with optional release_status
    fireEvent.change(screen.getByLabelText("Release status label"), {
      target: { value: "rc_v3_smoke" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Phase I" }));
    const confirmP101 = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmP101).getByRole("button", { name: "Start Phase I" }));
    await waitFor(() =>
      expect(requestP101).toHaveBeenCalledWith({
        orderPublicId,
        releaseStatus: "rc_v3_smoke",
      }),
    );

    // Phase I is now delivered, still staff sees no Re-send button, and Start Phase II stays disabled until checkbox is checked
    expect(await screen.findByText("Ready after artifact check")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Re-send/ })).toBeNull();
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

  it("allows administrators to re-send only with an audit reason, Phase I artifact confirmation for Phase II, and step-up MFA", async () => {
    mockState.p101Delivered = true;
    mockState.p201Delivered = true;
    mockState.staffViewer = false;

    const stepUp = vi.fn().mockResolvedValue(undefined);
    resendDispatch
      .mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockResolvedValueOnce({});

    const { container } = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" />,
      {
        path: `/admin/orders/${orderPublicId}/production`,
        api: fakeAuthApi({ me: async () => sessionFor("admin"), stepUp }),
      },
    );

    const resendP201Btn = await screen.findByRole("button", { name: "Re-send Phase II" });
    await expectNoAxeViolations(container);
    fireEvent.click(resendP201Btn);

    const dialog = await screen.findByRole("dialog", { name: "Re-send Phase II start (P201)" });
    // Reason too short
    fireEvent.change(within(dialog).getByLabelText(/Reason for re-send/), {
      target: { value: "short" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Phase II re-send" }));
    expect(await within(dialog).findByText(/at least 8 characters/)).toBeTruthy();
    expect(resendDispatch).not.toHaveBeenCalled();

    // Valid reason without artifact confirmation
    fireEvent.change(within(dialog).getByLabelText(/Reason for re-send/), {
      target: { value: "Downstream queue dropped the initial Phase II run" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Phase II re-send" }));
    expect(await within(dialog).findByText(/Confirm the Phase I final output artifacts exist/)).toBeTruthy();
    expect(resendDispatch).not.toHaveBeenCalled();

    // Check artifact confirmation and complete step-up
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: /I confirm the Phase I final output artifacts exist for this order ID/,
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Phase II re-send" }));

    const verifyDialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(verifyDialog).getByLabelText(/Password/), {
      target: { value: "synthetic-password" },
    });
    fireEvent.change(within(verifyDialog).getByLabelText(/6-digit code/), {
      target: { value: "123456" },
    });
    fireEvent.click(within(verifyDialog).getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(resendDispatch).toHaveBeenLastCalledWith({
        orderPublicId,
        phase: "P201",
        reason: "Downstream queue dropped the initial Phase II run",
        phase1ArtifactsConfirmed: true,
      }),
    );
    expect(stepUp).toHaveBeenCalledOnce();
  });

  it("blocks ineligible orders with clear validation reasons and renders ErrorState when preview fails", async () => {
    mockState.ineligibleOrder = true;
    const ineligible = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" />,
      { api: fakeAuthApi({ me: async () => sessionFor("staff") }) },
    );
    expect(await screen.findByText(/Orders containing non-packet line items cannot be sent to P101/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start Phase I" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await expectNoAxeViolations(ineligible.container);
    ineligible.unmount();

    mockState.ineligibleOrder = false;
    mockState.broken = true;
    renderUi(<OrderProductionTab orderId={orderPublicId} area="console" />, {
      api: fakeAuthApi({ me: async () => sessionFor("staff") }),
    });
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByText("No production dispatches for this order")).toBeNull();
    expect(screen.queryByText("private database detail")).toBeNull();
  });

  it("renders Outcome unknown badge, keeps P201 blocked, and shows verify-downstream-first warning on admin re-send (PW-02)", async () => {
    mockState.p101Unknown = true;
    mockState.staffViewer = false;

    const orderView = renderUi(
      <OrderProductionTab orderId={orderPublicId} area="console" />,
      {
        path: `/admin/orders/${orderPublicId}/production`,
        api: fakeAuthApi({ me: async () => sessionFor("admin") }),
      },
    );

    expect((await screen.findAllByText("Outcome unknown")).length).toBeGreaterThanOrEqual(1);
    expect(
      (screen.getByRole("button", { name: "Start Phase II" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const resendP101Btn = screen.getByRole("button", { name: "Re-send Phase I" });
    await expectNoAxeViolations(orderView.container);
    fireEvent.click(resendP101Btn);

    const dialog = await screen.findByRole("dialog", { name: "Re-send Phase I intake (P101)" });
    expect(
      within(dialog).getByText(
        /Verify downstream workflow executions and output folders before re-sending/i,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        /issues a new idempotency key and may duplicate work if an earlier uncertain or delivered request already ran/i,
      ),
    ).toBeTruthy();
    await expectNoAxeViolations(orderView.container);
    orderView.unmount();

    const adminPage = renderUi(<ProductionPipelinePage />, {
      path: "/admin/integrations/production",
      api: fakeAuthApi({ me: async () => sessionFor("admin") }),
    });
    expect(await screen.findByText("Outcome unknown")).toBeTruthy();
    await expectNoAxeViolations(adminPage.container);
  });
});
