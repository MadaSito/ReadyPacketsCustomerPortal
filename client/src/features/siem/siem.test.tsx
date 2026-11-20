// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import Console from "./Console";
import Destination from "./Destination";
import Editor from "./Editor";
import { siemFeature } from "./routes";
import SiemForwardingWidget from "./widgets/SiemForwardingWidget";

const { id, correlation, state, create, update, test, replay, purge } = vi.hoisted(() => ({
  id: "01JAFJ8VEGZ9GPVRR2S9KTYZME",
  correlation: "siem-test:example",
  state: { empty: false, broken: false },
  create: vi.fn(), update: vi.fn(), test: vi.fn(), replay: vi.fn(), purge: vi.fn(),
}));

vi.mock("@/lib/trpc", () => {
  const occurredAt = new Date("2026-09-22T12:00:00Z");
  const destination = {
    publicId: id, name: "Security collector", enabled: false, format: "syslog_rfc5425", host: "receiver.example.test", port: 6514,
    otlpPath: null, allowPrivateNetwork: false, minSeverity: "WARN", categories: ["security", "admin"], version: 3,
    secrets: { hasCustomCa: true, hasClientCert: true, hasClientKey: true, hasAuthSecret: false },
    delivery: { circuitState: "closed", queuedCount: 4, deadLetterCount: 1, lagSeq: 12, uncertainCount: 2, oldestQueuedAgeSeconds: 30,
      prunedAuditCount: 3, missingAuditGapCount: 0,
      deliveredCount: 22, lastSuccessAt: occurredAt, lastFailureAt: null, lastFailureReason: null, lastTestAt: null, lastTestOutcome: null,
      receiptConfirmation: "transport_accepted" },
  };
  const quarantined = { publicId: id, eventId: id, eventName: "identity.session.revoked", correlationId: correlation, severity: "WARN", attempts: 3,
    maxAttempts: 3, uncertainDelivery: true, lastReasonCode: "UNCERTAIN", deadLetteredAt: occurredAt };
  const activity = { event_id: id, correlation_id: correlation, event_name: "siem.delivery.uncertain_outcome", occurred_at: occurredAt, outcome: "unknown", reason_code: "UNCERTAIN" };
  const pathKey = () => ["siem"];
  const endpoint = (name: string, value: () => unknown) => ({
    queryOptions: (input?: unknown) => ({ queryKey: ["siem", name, input], queryFn: async () => value() }),
    queryKey: (input?: unknown) => ["siem", name, input],
    infiniteQueryOptions: (input: unknown, options: object) => ({
      ...options, initialPageParam: null, queryKey: ["siem", name, input], queryFn: async () => ({ items: value(), nextCursor: null }),
    }),
  });
  const api = { siem: { admin: { destinations: {
    create: { mutate: create }, update: { mutate: update }, test: { mutate: test },
  }, deadLetters: { replay: { mutate: replay }, purge: { mutate: purge } } } } };
  create.mockResolvedValue(destination);
  update.mockResolvedValue(destination);
  return {
    safeError: (error: { data?: { safe?: unknown } } | undefined) => error?.data?.safe,
    errorMessage: (_error: unknown, fallback?: string) => fallback ?? "Something went wrong.",
    useTRPCClient: () => api,
    useTRPC: () => ({ siem: { admin: { pathKey, destinations: {
      list: endpoint("list", () => {
        if (state.broken) throw new Error("private backend detail");
        return state.empty ? [] : [destination];
      }),
      get: endpoint("get", () => destination),
    }, health: endpoint("health", () => {
      if (state.broken) throw new Error("private backend detail");
      return {
        components: [{
          component: "siem.delivery",
          state: state.empty ? "not_configured" : "degraded",
          summary: state.empty ? "No SIEM or syslog forwarding destinations are configured." : "Delivery needs review.",
          metrics: {
            configuredDestinations: state.empty ? 0 : 1,
            enabledDestinations: state.empty ? 0 : 1,
            queueDepth: state.empty ? 0 : 4,
            deadLetters: state.empty ? 0 : 1,
            oldestPendingAgeSeconds: state.empty ? 0 : 125,
            maxLagSeq: state.empty ? 0 : 12,
            maxCursorLagAgeSeconds: state.empty ? 0 : 65,
            missingAuditGaps: 0,
            prunedAuditEvents: state.empty ? 0 : 3,
            customCounterValue: 7,
          },
          checkedAt: occurredAt,
        }],
      };
    }),
    deadLetters: { list: endpoint("quarantine", () => [quarantined]) } } },
    audit: { search: endpoint("activity", () => [activity]) } }),
  };
});

beforeEach(() => {
  state.empty = false;
  state.broken = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

function tab(label: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name: label }), { button: 0, ctrlKey: false });
}
function continueWizard() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("SIEM administration", () => {
  it("registers the Security navigation and renders accessible destination health and backlog", async () => {
    expect(siemFeature.nav?.[0]).toMatchObject({ group: "Security", order: 35, capability: "siem.read" });
    const { container } = renderUi(<Console />);
    expect(screen.getByText("Loading forwarding health").closest('[role="status"]')).not.toBeNull();
    expect((await screen.findAllByRole("link", { name: "Security collector" })).length).toBeGreaterThan(0);
    expect(screen.getAllByText("4 queued · 1 quarantined").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Forwarding health" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Delivery status" })).toBeTruthy();
    expect(screen.queryByText("siem.delivery")).toBeNull();
    expect(screen.getByText("Degraded")).toBeTruthy();
    for (const label of [
      "Configured destinations",
      "Enabled destinations",
      "Queue depth",
      "Dead letters",
      "Oldest pending (age)",
      "Max sequence lag",
      "Max cursor lag (age)",
      "Missing audit gaps",
      "Pruned audit events",
      "Custom counter value",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("2 min 5 s")).toBeTruthy();
    expect(screen.getByText("1 min 5 s")).toBeTruthy();
    expect(screen.queryByText("customCounterValue")).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("shows an empty list or a safe, retryable error rather than an internal error", async () => {
    state.empty = true;
    const empty = renderUi(<Console />);
    await screen.findByText("No destinations configured");
    expect(await screen.findByText("Not configured")).toBeTruthy();
    expect(screen.queryByText("not configured")).toBeNull();
    empty.unmount();
    state.broken = true;
    renderUi(<Console />);
    expect(await screen.findAllByRole("button", { name: /try again|retry/i })).toHaveLength(2);
    expect(screen.queryByText("private backend detail")).toBeNull();
  });

  it("renders the console overview SIEM forwarding widget across configured, unconfigured, and error states with no axe violations", async () => {
    expect(siemFeature.widgets?.[0]).toMatchObject({
      key: "siem.forwarding",
      area: "console",
      access: "admin",
      capability: "siem.read",
      span: 4,
    });

    const configured = renderUi(<SiemForwardingWidget />);
    expect(await screen.findByText("Degraded")).toBeTruthy();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "SIEM forwarding" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open SIEM" }).getAttribute("href")).toBe("/admin/siem");
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.getByText("2 min 5 s")).toBeTruthy();
    expect(screen.getByText("1 dead-lettered")).toBeTruthy();
    await expectNoAxeViolations(configured.container);
    configured.unmount();

    state.empty = true;
    const unconfigured = renderUi(<SiemForwardingWidget />);
    expect(await screen.findByText("Not configured")).toBeTruthy();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Add destination" }).getAttribute("href")).toBe("/admin/siem/new");
    await expectNoAxeViolations(unconfigured.container);
    unconfigured.unmount();

    state.empty = false;
    state.broken = true;
    renderUi(<SiemForwardingWidget />);
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.queryByText("0 of 0")).toBeNull();
    expect(screen.queryByText("private backend detail")).toBeNull();
  });

  it("creates a paused TLS destination and does not echo credential material at review", async () => {
    const { container, location } = renderUi(<Editor />, { path: "/admin/siem/new" });
    expect(screen.getByLabelText(/Forwarding format/)).toHaveProperty("value", "syslog_rfc5425");
    expect(screen.getByLabelText(/Port/)).toHaveProperty("value", "6514");
    fireEvent.change(screen.getByLabelText(/Destination name/), { target: { value: "Security collector" } });
    fireEvent.change(screen.getByLabelText(/Receiver host/), { target: { value: "receiver.example.test" } });
    continueWizard();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "TLS credentials" }));
    expect(screen.getByText("Certificate verification is required")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Client certificate (PEM)"), { target: { value: "synthetic-certificate" } });
    continueWizard();
    expect(screen.getByText(/must be configured or removed together/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Client private key (PEM)"), { target: { value: "synthetic-key" } });
    continueWizard();
    expect(screen.queryByDisplayValue("synthetic-key")).toBeNull();
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false, format: "syslog_rfc5425", port: 6514,
      secrets: { clientCertPem: "synthetic-certificate", clientKeyPem: "synthetic-key" },
    })));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/admin/siem/${id}`));
  });

  it("does not load stored credentials and defaults a changed endpoint to quarantine", async () => {
    renderUi(<Editor />, { path: `/admin/siem/${id}/edit` });
    fireEvent.change(await screen.findByLabelText(/Receiver host/), { target: { value: "new.example.test" } });
    continueWizard();
    expect(screen.getByLabelText("Client private key (PEM)")).toHaveProperty("value", "");
    continueWizard();
    expect(screen.getByText(/replace or remove its existing client credentials/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Remove saved client certificate/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Remove saved client private key/ }));
    continueWizard();
    expect(screen.getByRole("checkbox", { name: /Move queued events/ }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      publicId: id, expectedVersion: 3, migrateBacklog: false, secrets: { clientCertPem: null, clientKeyPem: null },
    })));
  });

  it("steps up test delivery, handles uncertainty, and links audit correlations without exposing payloads", async () => {
    test.mockRejectedValueOnce({ data: { safe: { domainCode: "STEP_UP_REQUIRED" } } })
      .mockResolvedValueOnce({ outcome: "unknown", receiptConfirmation: "none", reasonCode: "UNCERTAIN", eventId: id });
    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<Destination />, { path: `/admin/siem/${id}`, api: fakeAuthApi({ stepUp }) });
    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Send test event" }));
    const verify = await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.change(within(verify).getByLabelText(/Password/), { target: { value: "synthetic-password" } });
    fireEvent.change(within(verify).getByLabelText(/6-digit code/), { target: { value: "123456" } });
    fireEvent.click(within(verify).getByRole("button", { name: "Verify" }));
    await screen.findByText("Latest test result");
    expect(stepUp).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledTimes(2);
    expect(test).toHaveBeenLastCalledWith({ publicId: id, expectedVersion: 3 });
    tab("Quarantine");
    const links = await screen.findAllByRole("link", { name: `Open audit correlation ${correlation}` });
    expect(links[0]?.getAttribute("href")).toBe(`/admin/audit?correlationId=${encodeURIComponent(correlation)}`);
    expect(screen.getAllByText("Uncertain delivery").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    tab("Delivery log");
    expect((await screen.findAllByText("siem.delivery.uncertain_outcome")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: `Open audit correlation ${correlation}` }).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("requires confirmation before replaying or permanently purging a quarantined event", async () => {
    replay.mockResolvedValue({ replayedCount: 1 });
    purge.mockResolvedValue({ purgedCount: 1 });
    renderUi(<Destination />, { path: `/admin/siem/${id}` });
    await screen.findByRole("heading", { name: "Security collector" });
    tab("Quarantine");
    fireEvent.click(await screen.findByRole("button", { name: "Replay backlog" }));
    expect(replay).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Replay up to 100 events" }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith({ destinationPublicId: id, limit: 100 }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const purgeButtons = await screen.findAllByRole("button", { name: "Purge" });
    fireEvent.click(purgeButtons[0]!);
    expect(purge).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Purge event" }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith({ publicIds: [id] }));
  });
});
