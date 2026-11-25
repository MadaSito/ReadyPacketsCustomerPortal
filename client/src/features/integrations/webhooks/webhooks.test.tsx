import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import type { WebhookDeliveryDetailView, WebhookDeliveryListItemView } from "@server/modules/integrations/webhooks/types";
import { RouteFocus } from "@/app/RouteFocus";
import { visibleNav } from "@/app/shell/common";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { integrationsFeature } from "../routes";
import DeliveriesPage from "./DeliveriesPage";
import InboundPage from "./InboundPage";
import SubscriptionsPage from "./SubscriptionsPage";
import { WEBHOOK_PATHS } from "./paths";

const subscriptionId = "01JD0000000000000000000001";
const deliveryId = "01JD0000000000000000000002";
const rerunId = "01JD0000000000000000000003";
const attemptId = "01JD0000000000000000000004";
const date = new Date("2026-11-20T12:00:00.000Z");
const stepUpResponse = {
  message: "Verify your identity", code: -32003, data: {
    code: "FORBIDDEN", httpStatus: 403,
    safe: { domainCode: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED", safeMessage: "Verify your identity" },
  },
};
const settings = { enabled: false, retentionDays: 30, autoDisableThreshold: 5, deliveryTimeoutMs: 5000 };
const subscription = {
  publicId: subscriptionId, name: "Fulfilment", targetUrlHost: "receiver.example.test", targetUrlMasked: "https://receiver.example.test/…",
  description: null, status: "paused", events: ["order.created"], signingEnabled: true, signingSecretLast4: "8765", hasOverlapSecret: false,
  overlapExpiresAt: null, consecutiveFailures: 0, lastDeliveredAt: null, lastFailedAt: null, lastFailureReason: null,
  autoDisabledAt: null, version: 1, createdAt: date, updatedAt: date,
};
const inbound = {
  publicId: subscriptionId, name: "Fulfilment updates", endpointKey: "fulfilment-updates", description: null, enabled: false,
  receivePath: `/api/webhooks/inbound/${subscriptionId}`, signingSecretLast4: "8765", hasOverlapSecret: false, overlapExpiresAt: null,
  toleranceSeconds: 300, lastReceivedAt: null, version: 1, createdAt: date, updatedAt: date,
};
const delivery: WebhookDeliveryListItemView = {
  publicId: deliveryId, direction: "outbound", subscriptionPublicId: subscriptionId, inboundEndpointPublicId: null,
  targetLabel: "Fulfilment", eventKey: "order.created", externalEventId: null, status: "failed",
  httpMethod: "POST", httpPath: "/deliveries", httpStatus: 503, durationMs: 45, requestBytes: 14, responseBytes: 14,
  attemptCount: 1, maxAttempts: 3, reasonCode: "HTTP_503", correlationId: "webhook_test", actorLabel: "System",
  bodyTruncated: false, bodyPurged: false, isReplay: false, replayOfPublicId: null, isTest: false,
  canReplay: true, canRetry: false, canStop: false,
  orderPublicId: null, stageKey: null, manualRetryCount: 0, stoppedAt: null, stoppedByPublicId: null, stopReason: null,
  expiresAt: date, completedAt: date, createdAt: date,
};
const detail: WebhookDeliveryDetailView = {
  ...delivery, payloadSha256: "0".repeat(64), requestHeaders: { auth: "[REDACTED]" }, requestBody: "<img src=/preview>",
  responseHeaders: null, responseBody: null, attempts: [{ publicId: attemptId, attemptNumber: 1, outcome: "failed", httpStatus: 503,
    durationMs: 45, reasonCode: "HTTP_503", responseBytes: 14, responseHeaders: null, responseBody: null, occurredAt: date }],
};
const listings = {
  "settings.get": () => settings,
  catalogue: () => [{ key: "order.created", label: "Order created", description: "A new order is created.", group: "Orders" }],
  "subscriptions.list": () => ({ items: [subscription], nextCursor: null }),
  "inbound.list": () => ({ items: [inbound], nextCursor: null }),
  "deliveries.list": () => ({ items: [delivery], nextCursor: null }),
  "deliveries.get": () => detail,
};

function renderWebhooks(page: ReactElement, title: string, path: string,
  overrides: Record<string, (input: unknown) => unknown> = {}, api = fakeAuthApi()) {
  const queryClient = createTestQueryClient();
  const handlers: Record<string, (input: unknown) => unknown> = { ...listings, ...overrides };
  const prefix = "integrations.admin.webhooks.";
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({
    url: "https://portal.example.test/rpc",
    transformer: superjson,
    fetch: async (request, init) => {
      const url = new URL(String(request));
      const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as
        Record<string, Parameters<typeof superjson.deserialize>[0]>;
      return Response.json(url.pathname.slice(5).split(",").map((procedure, index) => {
        const handle = handlers[procedure.startsWith(prefix) ? procedure.slice(prefix.length) : procedure];
        if (!handle) throw new Error(`Unexpected test request: ${procedure}`);
        const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
        const result = handle(input);
        if (result === stepUpResponse) return { error: superjson.serialize(result) };
        return { result: { data: superjson.serialize(result) } };
      }));
    },
  })] });
  return renderUi(<main id="main">{page}<RouteFocus title={title} path={path} /></main>, {
    queryClient, path, api, wrapper: (ui) => <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>{ui}</TRPCProvider>,
  });
}

describe("Webhooks administration", () => {
  it("registers the three admin routes and leaves webhook settings discoverable when disabled", () => {
    for (const path of Object.values(WEBHOOK_PATHS)) {
      expect(integrationsFeature.routes.find((route) => route.path === path)).toMatchObject({ access: "admin", capability: "webhooks.manage" });
    }
    const webhookNav = (integrationsFeature.nav ?? []).filter((item) => item.href === WEBHOOK_PATHS.subscriptions);
    expect(visibleNav(webhookNav, "console", "admin")).toHaveLength(1);
    expect(webhookNav[0]?.enabledBy).toBeUndefined();
    expect(visibleNav(webhookNav, "console", "staff")).toEqual([]);
    expect(visibleNav(webhookNav, "console", "customer")).toEqual([]);
  });

  const pages = [
    { key: "subscriptions", Page: SubscriptionsPage, title: "Webhook subscriptions", table: "Outbound subscriptions" },
    { key: "inbound", Page: InboundPage, title: "Inbound webhook endpoints", table: "Inbound endpoints" },
    { key: "deliveries", Page: DeliveriesPage, title: "Webhook deliveries", table: "Webhook delivery records" },
  ] as const;
  for (const { key, Page, title, table } of pages) {
    pageA11y(title, async () => {
      renderWebhooks(<Page />, title, WEBHOOK_PATHS[key]);
      await screen.findByRole("table", { name: table });
    });
  }

  it("includes the visible Test delivery label in the subscription action's accessible name", async () => {
    const user = userEvent.setup();
    const queue = vi.fn();
    renderWebhooks(<SubscriptionsPage />, "Webhook subscriptions", WEBHOOK_PATHS.subscriptions, {
      "settings.get": () => ({ ...settings, enabled: true }),
      "subscriptions.testDelivery": queue,
    });
    const table = await screen.findByRole("table", { name: "Outbound subscriptions" });
    const action = within(table).getByRole("button", { name: `Test delivery for ${subscription.name}` });
    expect(action).toHaveTextContent(/^Test delivery$/u);
    await user.click(action);
    expect(screen.getByRole("alertdialog", { name: "Send test delivery?" })).toBeVisible();
    expect(queue).not.toHaveBeenCalled();
  });

  it("creates a paused outbound subscription, with a once-only secret outside the query and mutation caches", async () => {
    const user = userEvent.setup();
    const secret = "synthetic_secret_1234";
    const create = vi.fn(() => ({ subscription, signingSecretOnce: secret }));
    const view = renderWebhooks(<SubscriptionsPage />, "Webhook subscriptions", WEBHOOK_PATHS.subscriptions, { "subscriptions.create": create });
    await screen.findByRole("table", { name: "Outbound subscriptions" });
    await user.click(screen.getByRole("button", { name: "Create subscription" }));
    const editor = screen.getByRole("dialog", { name: "Create subscription" });
    await user.type(within(editor).getByLabelText(/Name/), "Fulfilment");
    await user.type(within(editor).getByLabelText(/Destination URL/), "https://receiver.example.test/hook");
    await user.click(within(editor).getByRole("checkbox", { name: "Order created" }));
    await expectNoAxeViolations(editor);
    await user.click(within(editor).getByRole("button", { name: "Create subscription" }));
    const secretDialog = await screen.findByRole("dialog", { name: "Signing secret" });
    expect(within(secretDialog).getByText(secret)).toBeVisible();
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: "Fulfilment", description: null,
      targetUrl: "https://receiver.example.test/hook", events: ["order.created"], signingEnabled: true, paused: true });
    expect(view.queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(view.queryClient.getQueriesData({}))).not.toContain(secret);
    await user.click(within(secretDialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it("offers setup while the service is off and saves only changed settings", async () => {
    const user = userEvent.setup();
    const update = vi.fn(() => ({ ...settings, enabled: true }));
    renderWebhooks(<SubscriptionsPage />, "Webhook subscriptions", WEBHOOK_PATHS.subscriptions, { "settings.update": update });
    expect(await screen.findByText(/webhooks are off/iu)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Webhook settings" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Enable webhooks" }));
    expect(update).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Inbound and outbound webhooks are enabled.")).toBeVisible();
    expect(update).toHaveBeenCalledExactlyOnceWith({ enabled: true });
  });

  it("requires an acknowledgement to set zero-day body retention", async () => {
    const user = userEvent.setup();
    const update = vi.fn(() => ({ ...settings, retentionDays: 0 }));
    renderWebhooks(<SubscriptionsPage />, "Webhook subscriptions", WEBHOOK_PATHS.subscriptions, { "settings.update": update });
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Webhook settings" });
    const retention = within(dialog).getByRole("spinbutton", { name: "Body retention (days)" });
    await user.clear(retention);
    await user.type(retention, "0");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox", { name: /immediately delete retained/iu }));
    await user.click(save);
    expect(update).toHaveBeenCalledExactlyOnceWith({ retentionDays: 0 });
  });

  it("rotates an inbound endpoint secret only after confirmation and keeps the receive path unchanged", async () => {
    const user = userEvent.setup();
    const rotate = vi.fn(() => ({ endpoint: inbound, signingSecretOnce: "synthetic_rotated_secret" }));
    renderWebhooks(<InboundPage />, "Inbound webhook endpoints", WEBHOOK_PATHS.inbound, { "inbound.rotateSecret": rotate });
    const table = await screen.findByRole("table", { name: "Inbound endpoints" });
    expect(within(table).getByText(inbound.receivePath)).toBeVisible();
    await user.click(within(table).getByRole("button", { name: /rotate secret/iu }));
    const dialog = screen.getByRole("alertdialog", { name: "Rotate signing secret?" });
    expect(rotate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByText("synthetic_rotated_secret")).toBeVisible();
    expect(rotate).toHaveBeenCalledExactlyOnceWith({ publicId: subscriptionId, expectedVersion: 1, overlapMinutes: 60 });
  });

  it("applies direction, status, date and correlation filters and retains direction on the next cursor", async () => {
    const user = userEvent.setup();
    const list = vi.fn((input: unknown) => ({ items: (input as { cursor?: string }).cursor ? [] : [delivery],
      nextCursor: (input as { cursor?: string }).cursor ? null : rerunId }));
    renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries, { "deliveries.list": list });
    await user.selectOptions(screen.getByLabelText("Direction"), "inbound");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    fireEvent.change(screen.getByLabelText("Start date (UTC)"), { target: { value: "2026-11-20" } });
    await user.type(screen.getByLabelText("Correlation ID"), "webhook_test");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await screen.findByRole("table", { name: "Webhook delivery records" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      direction: "inbound", status: "failed", cursor: rerunId, correlationId: "webhook_test", from: new Date("2026-11-20T00:00:00.000Z"),
    }));
  });

  it("shows the redacted payload as text and sends redelivery after acknowledgement and actual step-up", async () => {
    const user = userEvent.setup();
    const end = { ...detail, publicId: rerunId, isReplay: true, replayOfPublicId: deliveryId };
    const redeliver = vi.fn().mockReturnValueOnce(stepUpResponse).mockReturnValueOnce(end);
    const get = vi.fn(() => detail);
    const verify = vi.fn(async () => ({ ok: true as const }));
    const view = renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries,
      { "settings.get": () => ({ ...settings, enabled: true }), "deliveries.get": get, "deliveries.redeliver": redeliver }, fakeAuthApi({ stepUp: verify }));
    const table = await screen.findByRole("table", { name: "Webhook delivery records" });
    expect(get).not.toHaveBeenCalled();
    await user.click(within(table).getByRole("button", { name: `Details for delivery ${deliveryId}` }));
    const dialog = screen.getByRole("dialog", { name: "Webhook delivery detail" });
    const action = await within(dialog).findByRole("button", { name: "Redeliver webhook" });
    expect(action).toBeDisabled();
    await user.click(within(dialog).getByText("Request body (redacted)", { selector: "summary" }));
    expect(within(dialog).getByText("<img src=/preview>")).toBeVisible();
    expect(dialog.querySelector("img")).toBeNull();
    expect(JSON.stringify(view.queryClient.getQueriesData({}))).not.toContain("/preview");
    await user.click(within(dialog).getByRole("checkbox", { name: /destination may receive this event again/iu }));
    await user.click(action);
    const prompt = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(prompt).getByLabelText(/Password/u), "example password");
    await user.type(within(prompt).getByLabelText(/6-digit code/u), "123456");
    await user.click(within(prompt).getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("button", { name: "View rerun" })).toBeVisible();
    expect(redeliver.mock.calls).toEqual([[{ publicId: deliveryId }], [{ publicId: deliveryId }]]);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("refuses to offer rerun when an inbound payload has been purged", async () => {
    const user = userEvent.setup();
    renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries, {
      "deliveries.get": () => ({ ...detail, direction: "inbound", bodyPurged: true, requestBody: null }),
    });
    const table = await screen.findByRole("table", { name: "Webhook delivery records" });
    await user.click(within(table).getByRole("button", { name: `Details for delivery ${deliveryId}` }));
    const dialog = screen.getByRole("dialog", { name: "Webhook delivery detail" });
    expect(await within(dialog).findByText(/stored body was removed/iu)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Reprocess inbound event" })).not.toBeInTheDocument();
  });

  it("uses the inbound-specific action rather than outbound redelivery when reprocessing", async () => {
    const user = userEvent.setup();
    const eventDetail = { ...detail, direction: "inbound" };
    const reprocess = vi.fn(() => ({ ...eventDetail, publicId: rerunId, isReplay: true }));
    const redeliver = vi.fn();
    renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries, {
      "settings.get": () => ({ ...settings, enabled: true }),
      "deliveries.get": () => eventDetail, "deliveries.reprocessInbound": reprocess, "deliveries.redeliver": redeliver,
    });
    const table = await screen.findByRole("table", { name: "Webhook delivery records" });
    await user.click(within(table).getByRole("button", { name: `Details for delivery ${deliveryId}` }));
    const dialog = screen.getByRole("dialog", { name: "Webhook delivery detail" });
    const run = await within(dialog).findByRole("button", { name: "Reprocess inbound event" });
    expect(run).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /may start automations again/iu }));
    await user.click(run);
    expect(await screen.findByRole("button", { name: "View rerun" })).toBeVisible();
    expect(reprocess).toHaveBeenCalledExactlyOnceWith({ publicId: deliveryId });
    expect(redeliver).not.toHaveBeenCalled();
  });

  it("keeps delivery details available while off without offering rerun", async () => {
    const user = userEvent.setup();
    renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries);
    const table = await screen.findByRole("table", { name: "Webhook delivery records" });
    await user.click(within(table).getByRole("button", { name: `Details for delivery ${deliveryId}` }));
    const dialog = screen.getByRole("dialog", { name: "Webhook delivery detail" });
    expect(await within(dialog).findByText(/enable webhooks under subscriptions/iu)).toBeVisible();
    expect(within(dialog).getByRole("table", { name: "Delivery attempts" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Redeliver webhook" })).not.toBeInTheDocument();
  });

  it("supports toggling HMAC-SHA256 signing on subscription edit and renders Signed / Unsigned badges", async () => {
    const user = userEvent.setup();
    const update = vi.fn(() => ({ ...subscription, signingEnabled: false, version: 2 }));
    renderWebhooks(<SubscriptionsPage />, "Webhook subscriptions", WEBHOOK_PATHS.subscriptions, {
      "subscriptions.list": () => ({
        items: [subscription, { ...subscription, publicId: "01JD0000000000000000000009", name: "Unsigned sink", signingEnabled: false }],
        nextCursor: null,
      }),
      "subscriptions.update": update,
    });
    const table = await screen.findByRole("table", { name: "Outbound subscriptions" });
    expect(within(table).getByText("Signed")).toBeVisible();
    expect(within(table).getByText("Unsigned")).toBeVisible();

    await user.click(within(table).getByRole("button", { name: `Edit ${subscription.name}` }));
    const dialog = screen.getByRole("dialog", { name: "Edit subscription" });
    const signingCheckbox = within(dialog).getByRole("checkbox", {
      name: /Sign deliveries with HMAC-SHA256/iu,
    });
    expect(signingCheckbox).toBeChecked();
    await user.click(signingCheckbox);
    await user.click(within(dialog).getByRole("button", { name: "Save subscription" }));

    expect(update).toHaveBeenCalledExactlyOnceWith({
      publicId: subscriptionId,
      expectedVersion: 1,
      name: "Fulfilment",
      description: null,
      targetUrl: undefined,
      events: ["order.created"],
      signingEnabled: false,
    });
  });

  it("filters deliveries by Order ID and Stopped status, stops queued deliveries, and retries eligible stopped records without creating a replay", async () => {
    const user = userEvent.setup();
    const orderPublicId = "01JD0000000000000000000077";
    const queuedDetail: WebhookDeliveryDetailView = {
      ...detail,
      status: "queued",
      canReplay: false,
      canRetry: false,
      canStop: true,
      orderPublicId,
      stageKey: "intake",
    };
    const stoppedDetail: WebhookDeliveryDetailView = {
      ...queuedDetail,
      status: "stopped",
      canStop: false,
      canRetry: true,
      stoppedAt: date,
      stoppedByPublicId: "01JD0000000000000000000055",
      stopReason: "Operator paused receiver",
    };
    const retriedDetail: WebhookDeliveryDetailView = {
      ...stoppedDetail,
      status: "queued",
      canStop: true,
      canRetry: false,
      manualRetryCount: 1,
      stoppedAt: null,
      stopReason: null,
    };

    const list = vi.fn(() => ({
      items: [{ ...delivery, status: "stopped" as const, orderPublicId, stageKey: "intake", canReplay: false, canStop: true }],
      nextCursor: null,
    }));
    const stop = vi.fn(() => stoppedDetail);
    const retry = vi.fn(() => retriedDetail);
    const redeliver = vi.fn();

    renderWebhooks(<DeliveriesPage />, "Webhook deliveries", WEBHOOK_PATHS.deliveries, {
      "settings.get": () => ({ ...settings, enabled: true }),
      "deliveries.list": list,
      "deliveries.get": () => queuedDetail,
      "deliveries.stop": stop,
      "deliveries.retry": retry,
      "deliveries.redeliver": redeliver,
    });

    await user.type(screen.getByLabelText("Order ID"), orderPublicId);
    await user.selectOptions(screen.getByLabelText("Status"), "stopped");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderPublicId, status: "stopped" }),
    );

    const table = await screen.findByRole("table", { name: "Webhook delivery records" });
    expect(within(table).getByText("Stopped")).toBeVisible();
    await user.click(within(table).getByRole("button", { name: `Details for delivery ${deliveryId}` }));

    const dialog = screen.getByRole("dialog", { name: "Webhook delivery detail" });
    await user.type(await within(dialog).findByLabelText("Stop reason (optional)"), "Operator paused receiver");
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Stop delivery" }));
    expect(stop).toHaveBeenCalledExactlyOnceWith({
      publicId: deliveryId,
      reason: "Operator paused receiver",
    });

    const retryButton = await within(dialog).findByRole("button", { name: "Retry delivery" });
    expect(within(dialog).queryByRole("button", { name: "Redeliver webhook" })).not.toBeInTheDocument();
    await user.click(retryButton);
    expect(retry).toHaveBeenCalledExactlyOnceWith({ publicId: deliveryId });
    expect(redeliver).not.toHaveBeenCalled();
  });
});
