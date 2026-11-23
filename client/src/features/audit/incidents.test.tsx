import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import IncidentDetailPage, { BanDialog, CloseDialog, IncidentDetailView, timelineItems } from "./IncidentDetailPage";
import IncidentsPage, { draftErrors, RulesCard } from "./IncidentsPage";
import { banDurationOf, banReasonError, type CorrelationConfig, type IncidentDetail, type IncidentSummary, type RulesView } from "./model";
import { auditFeature } from "./routes";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, fetchMock } = vi.hoisted(() => ({ handlers: {} as Record<string, (input: unknown) => unknown>, fetchMock: vi.fn() }));
vi.mock("@/lib/sessionTransport", async (original) => ({ ...await original<typeof transportModule>(), sessionFetch: fetchMock }));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    return Promise.resolve(handler(input));
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "infiniteQueryOptions") {
          return (input: Record<string, unknown>, opts: { getNextPageParam: (p: unknown) => unknown }) => ({
            queryKey: [key, input, "infinite"],
            queryFn: ({ pageParam }: { pageParam: unknown }) => call(key, { ...input, cursor: pageParam }),
            initialPageParam: null,
            getNextPageParam: opts.getNextPageParam,
          });
        }
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        if (prop === "query" || prop === "mutate") return (input: unknown) => call(key, input);
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

const ID = "01JTESTAAAAAAAAAAAAAAAAAA1";
const rule = (severity: "low" | "medium" | "high" | "critical", threshold: number, windowMinutes: number, distinct = 1) => ({ enabled: true, severity, threshold, windowMinutes, distinct });
const config: CorrelationConfig = {
  enabled: true, mergeMinutes: 60,
  rules: {
    brute_force_account: rule("high", 10, 15), password_spraying: rule("high", 5, 10), credential_stuffing: rule("critical", 30, 5, 5),
    distributed_account: rule("high", 5, 30), success_after_failures: rule("critical", 5, 30), mfa_fatigue: rule("high", 5, 10),
    rate_limit_repeated: rule("medium", 5, 15), ban_evasion: rule("high", 1, 30), privilege_then_export: rule("high", 1, 60),
  },
};
const info = Object.fromEntries(Object.keys(config.rules).map((k) => [k, { label: `Rule ${k}`, description: `About ${k}.`, threshold: "Failed attempts", subject: "account" }])) as RulesView["info"];
const rulesView = (patch: Partial<RulesView> = {}): RulesView => ({
  config, info, lastRun: { at: "2026-11-20T12:00:00.000Z", events: 40, findings: 1, truncated: false, reason: null }, addressesDeterminable: true, canEdit: true, ...patch,
});
const summary = (patch: Partial<IncidentSummary> = {}): IncidentSummary => ({
  publicId: ID, ruleKey: "brute_force_account", ruleLabel: "Brute force on one account", severity: "high", status: "open", subjectKind: "account",
  firstEventAt: "2026-11-20T11:50:00.000Z", lastEventAt: "2026-11-20T11:59:00.000Z", eventCount: 12, accountCount: 1, addressCount: 1, version: 1,
  hasUser: true, hasAddress: true, ...patch,
});
const incident = (patch: Partial<IncidentDetail> = {}): IncidentDetail => ({
  ...summary(), acknowledgedAt: null, closedAt: null, closeReason: null,
  events: [{ eventId: "01JTESTEVENT0000000000001", eventName: "auth.login.failed", occurredAt: "2026-11-20T11:50:00.000Z" }],
  linkedEventsCapped: false,
  timeline: [
    { at: "2026-11-20T11:51:00.000Z", kind: "opened", byMe: false, byPerson: false, detail: { rule_key: "brute_force_account" } },
    { at: "2026-11-20T11:59:00.000Z", kind: "escalated", byMe: false, byPerson: false, detail: { from: "high", to: "critical" } },
    { at: "2026-11-20T12:01:00.000Z", kind: "action_ban_ip", byMe: true, byPerson: true, detail: { permanent: true } },
  ],
  auditQuery: { from: "2026-11-20T11:45:00.000Z", to: "2026-11-20T12:05:00.000Z" },
  actions: { banIp: { available: true, reason: null }, endSessions: { available: true, reason: null } },
  ...patch,
});

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  fetchMock.mockReset();
});

describe("incident model helpers", () => {
  it("parses ban durations and reasons like the server", () => {
    expect(banDurationOf("15")).toBe(15);
    expect(banDurationOf("permanent")).toBeNull();
    expect(banDurationOf("30")).toBeUndefined();
    expect(banReasonError("ok")).not.toBeNull();
    expect(banReasonError("Brute force from this address")).toBeNull();
    expect(banReasonError("bad\u0007reason")).not.toBeNull();
  });
  it("validates rule thresholds within the server bounds", () => {
    const draft = Object.fromEntries(Object.entries(config.rules).map(([k, r]) => [k, { ...r, threshold: String(r.threshold), windowMinutes: String(r.windowMinutes), distinct: String(r.distinct) }])) as Parameters<typeof draftErrors>[0];
    expect(draftErrors(draft, "60")).toEqual({});
    draft.brute_force_account.threshold = "0";
    draft.mfa_fatigue.windowMinutes = "1441";
    draft.password_spraying.distinct = "0"; // ignored: only credential stuffing uses it
    expect(Object.keys(draftErrors(draft, "4")).sort()).toEqual(["brute_force_account.threshold", "mergeMinutes", "mfa_fatigue.windowMinutes"]);
  });
  it("orders the timeline newest first and names the actor", () => {
    const items = timelineItems(incident());
    expect(items.map((i) => i.title)).toEqual(["Address banned", "Severity raised", "Incident opened"]);
    expect(items[0]!.actor).toBe("You");
    expect(items[1]!.description).toBe("From High to Critical.");
    expect(items[2]!.actor).toBe("Correlation engine");
  });
  it("registers admin-only routes behind security.incidents.read", () => {
    const paths = auditFeature.routes.filter((r) => r.path.startsWith("/admin/audit/incidents"));
    expect(paths.map((r) => [r.path, r.access, r.capability])).toEqual([
      ["/admin/audit/incidents", "admin", "security.incidents.read"],
      ["/admin/audit/incidents/:publicId", "admin", "security.incidents.read"],
    ]);
  });
});

describe("incident views", () => {
  it("rules card saves the edited config and blocks invalid values", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    renderUi(<RulesCard view={rulesView()} onSave={onSave} saving={false} />);
    const user = userEvent.setup();
    const thresholds = screen.getAllByLabelText(/Failed attempts \(at least\)/);
    await user.clear(thresholds[0]!);
    await user.type(thresholds[0]!, "0");
    await user.click(screen.getByRole("button", { name: "Save rules" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText("Fix the highlighted values.")).toBeInTheDocument();
    await user.clear(thresholds[0]!);
    await user.type(thresholds[0]!, "12");
    await user.click(screen.getByRole("button", { name: "Save rules" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mergeMinutes: 60, rules: expect.objectContaining({ brute_force_account: expect.objectContaining({ threshold: 12 }) }) }));
    await expectNoAxeViolations();
  });
  it("rules card is read-only without the firewall permission", () => {
    renderUi(<RulesCard view={rulesView({ canEdit: false })} onSave={vi.fn()} saving={false} />);
    expect(screen.queryByRole("button", { name: "Save rules" })).toBeNull();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });
  it("detail explains unavailable actions and links to the audit search", async () => {
    renderUi(<IncidentDetailView detail={incident({ status: "acknowledged", actions: { banIp: { available: false, reason: "ADDRESS_UNDETERMINABLE" }, endSessions: { available: false, reason: "NO_USER" } } })}
      onAcknowledge={vi.fn()} onClose={vi.fn()} onBan={vi.fn()} onEndSessions={vi.fn()} busy={false} />);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ban IP address" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End sessions" })).toBeDisabled();
    expect(screen.getByText(/bans are paused/)).toBeInTheDocument();
    expect(screen.getByText(/not tied to a known person/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in audit search" })).toHaveAttribute("href", `/admin/audit?incident=${ID}`);
    expect(screen.getAllByRole("link", { name: "auth.login.failed" })[0]).toHaveAttribute("href", "/admin/audit?event=01JTESTEVENT0000000000001");
    await expectNoAxeViolations();
  });
  it("ban dialog validates the reason and sends a permanent ban as null", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderUi(<BanDialog open onCancel={vi.fn()} onSubmit={onSubmit} busy={false} />);
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Ban address" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Enter a reason of 3 to 240 characters.")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText(/Duration/), "permanent");
    await user.type(within(dialog).getByLabelText(/Reason/), "Credential stuffing source");
    await user.click(within(dialog).getByRole("button", { name: "Ban address" }));
    expect(onSubmit).toHaveBeenCalledWith(null, "Credential stuffing source");
    await expectNoAxeViolations();
  });
  it("close dialog requires a reason", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderUi(<CloseDialog open onCancel={vi.fn()} onSubmit={onSubmit} busy={false} />);
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Close incident" }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.selectOptions(within(dialog).getByLabelText(/Reason/), "false_positive");
    await user.click(within(dialog).getByRole("button", { name: "Close incident" }));
    expect(onSubmit).toHaveBeenCalledWith("false_positive");
  });
  it("list page shows counts, the address warning and the incidents", async () => {
    handlers["audit.incidents.list"] = () => ({ items: [summary()], nextCursor: null, counts: { open: 1, acknowledged: 2, closed: 3 } });
    handlers["audit.incidents.rules"] = () => rulesView({ addressesDeterminable: false });
    renderUi(<main><IncidentsPage /></main>);
    expect((await screen.findAllByRole("link", { name: "Brute force on one account" }))[0]).toHaveAttribute("href", `/admin/audit/incidents/${ID}`);
    expect(await screen.findByText("Client addresses cannot be determined")).toBeInTheDocument();
  });
});

pageA11y("Security incidents page", async () => {
  document.title = "Security incidents · ReadyPackets";
  handlers["audit.incidents.list"] = () => ({ items: [summary(), summary({ publicId: "01JTESTAAAAAAAAAAAAAAAAAA2", severity: "critical", status: "acknowledged" })], nextCursor: null, counts: { open: 1, acknowledged: 1, closed: 0 } });
  handlers["audit.incidents.rules"] = () => rulesView();
  renderUi(<main><IncidentsPage /></main>);
  expect((await screen.findAllByRole("link", { name: "Brute force on one account" })).length).toBeGreaterThanOrEqual(2);
  expect(await screen.findByRole("button", { name: "Save rules" })).toBeInTheDocument();
});

pageA11y("Security incident detail page", async () => {
  document.title = "Security incident · ReadyPackets";
  handlers["audit.incidents.get"] = () => incident({ severity: "critical" });
  renderUi(<main><IncidentDetailPage /></main>, { path: `/admin/audit/incidents/${ID}`, wrapper: (c) => <Route path="/admin/audit/incidents/:publicId">{c}</Route> });
  expect(await screen.findByText("Critical incident", {}, { timeout: 3000 })).toBeInTheDocument();
});
