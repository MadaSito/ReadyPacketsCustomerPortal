import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AuditCenterPage from "./AuditCenterPage";
import { CaseDetailView, CasesTable } from "./CasesPage";
import { EventDetailPanel, EventsTable } from "./EventParts";
import ExportsPage, { ExportsTable } from "./ExportsPage";
import { IntegritySummary } from "./IntegrityPage";
import { buildQuery, DEFAULT_FILTERS, invalidIdentifier, readParam, type AuditEnvelope, type EventDetail, type ExportView, type IntegrityStatus } from "./model";
import RetentionPage, { RetentionView } from "./RetentionPage";
import { SavedQueriesTable } from "./SavedQueriesPage";

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

const ULID = (n: number) => `01JTEST${String(n).padStart(19, "0")}`;
const event = (n: number, patch: Partial<AuditEnvelope> = {}): AuditEnvelope => ({
  schema_version: "1", event_id: ULID(n), occurred_at: "2026-11-20T12:00:00.000Z", observed_at: "2026-11-20T12:00:00.000Z",
  severity_text: "WARN", severity_number: 13, category: "security", event_name: "auth.login", action: "login", outcome: "denied",
  reason_code: "MFA_FAILED", durability: "durable", actor_ref: "a".repeat(32), actor_role: "customer", actor_user_id: 7,
  session_ref: null, resource_type: null, resource_public_id: null, resource_ref: null, request_id: "req_1", trace_id: "b".repeat(32),
  span_id: null, correlation_id: "wf_synthetic_1", parent_correlation_id: null, job_id: null, package_id: null, import_id: null,
  delivery_id: null, provider: null, duration_ms: 12, origin: "http", service: "portal", installation_ref: "inst",
  release_ref: "test", deployment_profile: "test", source_address_class: "public", source_address_ref: "c".repeat(32),
  safe_counts: { attempts: 3 }, attributes: {}, dropped_attributes: 0, chain_seq: 4, ...patch,
});
const detail = (patch: Partial<EventDetail> = {}): EventDetail => ({
  event: event(1), chain: { seq: 4, linkHash: "d".repeat(64), prevHash: "e".repeat(64), sealedAt: "2026-11-20T12:00:05.000Z" },
  actorUserPublicId: ULID(99), caseIds: [], availablePivots: ["request", "trace", "correlation"], ...patch,
});
const exportRow = (patch: Partial<ExportView> = {}): ExportView => ({
  id: ULID(50), format: "jsonl", profile: "external", status: "completed", reasonCode: null, rowCount: 2, byteSize: 9,
  sha256: "f".repeat(64), truncated: false, query: { from: "2026-11-19T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z" }, manifest: null,
  createdAt: "2026-11-20T10:00:00.000Z", completedAt: "2026-11-20T10:00:03.000Z", expiresAt: "2026-11-27T10:00:00.000Z", expired: false, downloadCount: 0, ...patch,
});

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  fetchMock.mockReset();
});
afterEach(() => {
  window.location.hash = "";
});

describe("audit query model", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  it("builds a bounded time window and ANDs quick filters", () => {
    const q = buildQuery({ ...DEFAULT_FILTERS, category: "security", minSeverity: "WARN" }, now);
    expect(q.from).toBe("2026-11-19T12:00:00.000Z");
    expect(q.where).toEqual({ kind: "group", op: "and", terms: [
      { field: "category", op: "eq", value: "security" },
      { field: "severity", op: "gte", value: "WARN" },
    ] });
  });
  it("searches an ID across the id fields with OR, choosing fields by shape", () => {
    const plain = buildQuery({ ...DEFAULT_FILTERS, ids: "wf_123" }, now).where!.terms[0] as { op: string; terms: { field: string }[] };
    expect(plain.op).toBe("or");
    expect(plain.terms.map((t) => t.field)).toEqual(["correlation_id", "request_id", "job_id", "resource_public_id"]);
    const hex = buildQuery({ ...DEFAULT_FILTERS, ids: "a".repeat(32) }, now).where!.terms[0] as { terms: { field: string }[] };
    expect(hex.terms.map((t) => t.field)).toContain("trace_id");
    expect(invalidIdentifier({ ...DEFAULT_FILTERS, ids: "x' OR 1=1 --" })).not.toBeNull();
  });
  it("groups advanced conditions with the chosen operator and splits `in` lists", () => {
    const q = buildQuery({ ...DEFAULT_FILTERS, match: "or", conditions: [
      { key: "1", field: "outcome", op: "in", value: "denied, refused,," },
      { key: "2", field: "event_name", op: "prefix", value: "auth." },
      { key: "3", field: "job_id", op: "eq", value: "  " },
    ] }, now);
    expect(q.where!.terms).toEqual([{ kind: "group", op: "or", terms: [
      { field: "outcome", op: "in", value: ["denied", "refused"] },
      { field: "event_name", op: "prefix", value: "auth." },
    ] }]);
  });
  it("reads deep-link parameters from the query string or from a hash route", () => {
    expect(readParam("?correlationId=wf_a", "correlationId")).toBe("wf_a");
    window.location.hash = "#/admin/audit?correlationId=wf_b";
    expect(readParam("", "correlationId")).toBe("wf_b");
  });
});

describe("audit center page", () => {
  it("honours ?correlationId= under hash routing and opens event details", async () => {
    window.location.hash = "#/admin/audit?correlationId=wf_synthetic_1";
    const search = vi.fn((_input: unknown) => ({ items: [event(1)], nextCursor: null, freshness: { headSeq: 4, lastSealedAt: null } }));
    handlers["audit.search"] = search;
    handlers["audit.event"] = () => detail();
    const user = userEvent.setup();
    const { container } = renderUi(<AuditCenterPage />, { path: "/admin/audit" });
    expect(await screen.findByRole("heading", { level: 1, name: "Audit center" })).toBeInTheDocument();
    await waitFor(() => expect(search).toHaveBeenCalled());
    const input = search.mock.calls[0]![0] as unknown as { query: { where: { terms: { terms: { field: string; value: string }[] }[] } } };
    expect(input.query.where.terms[0]!.terms).toContainEqual({ field: "correlation_id", op: "eq", value: "wf_synthetic_1" });
    expect(screen.getByRole("searchbox", { name: "Find by ID" })).toHaveValue("wf_synthetic_1");
    await screen.findAllByText("auth.login");
    await expectNoAxeViolations(container);
    await user.click(screen.getAllByRole("button", { name: /Open event auth\.login/ })[0]!);
    const drawer = await screen.findByRole("dialog", { name: "Event details" });
    expect(await within(drawer).findByRole("button", { name: "Same workflow" })).toBeInTheDocument();
    expect(within(drawer).getByText("Sealed #4")).toBeInTheDocument();
  });

  it("applies ?saved=<id> exactly as stored and can return to the filters", async () => {
    const stored = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z", where: { kind: "group" as const, op: "and" as const, terms: [{ field: "category" as const, op: "eq" as const, value: "admin" }] } };
    window.location.hash = `#/admin/audit?saved=${ULID(5)}`;
    handlers["audit.savedQueries.list"] = () => [{ id: ULID(5), name: "Admin changes", shared: false, mine: true, query: stored, updatedAt: "2026-10-02T00:00:00.000Z" }];
    const search = vi.fn(() => ({ items: [], nextCursor: null, freshness: { headSeq: 0, lastSealedAt: null } }));
    handlers["audit.search"] = search;
    renderUi(<AuditCenterPage />, { path: "/admin/audit" });
    expect(await screen.findByText("Saved search “Admin changes”")).toBeInTheDocument();
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: stored })));
    fireEvent.click(screen.getByRole("button", { name: "Back to my filters" }));
    expect(screen.queryByText("Saved search “Admin changes”")).not.toBeInTheDocument();
  });

  it("rejects malformed IDs client-side without sending a query", async () => {
    const search = vi.fn(() => ({ items: [], nextCursor: null, freshness: { headSeq: 0, lastSealedAt: null } }));
    handlers["audit.search"] = search;
    renderUi(<AuditCenterPage />, { path: "/admin/audit" });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("No events match")).toBeInTheDocument();
    const box = screen.getByRole("searchbox", { name: "Find by ID" });
    fireEvent.change(box, { target: { value: "bad value; drop" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText(/without spaces/)).toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("audit presentational parts", () => {
  it("event table shows loading, empty and error states, and mobile cards carry labels", async () => {
    const { rerender, container } = renderUi(<EventsTable rows={undefined} loading error={null} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByRole("status", { name: "Loading Audit events" })).toBeInTheDocument();
    rerender(<EventsTable rows={[]} loading={false} error={null} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByText("No events match")).toBeInTheDocument();
    rerender(<EventsTable rows={undefined} loading={false} error={new Error("synthetic")} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<EventsTable rows={[event(1), event(2, { severity_text: "ERROR", outcome: "failed" })]} loading={false} error={null} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(screen.getAllByText("ERROR").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("dl dt").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("event detail reveals the source address only on request and offers pivots", async () => {
    const onReveal = vi.fn();
    const onPivot = vi.fn();
    const { container, rerender } = renderUi(<EventDetailPanel detail={detail()} revealed={undefined} onReveal={onReveal} revealing={false} onPivot={onPivot} pivoting={null} onAddToCase={() => undefined} />);
    await expectNoAxeViolations(container);
    expect(screen.queryByText("203.0.113.7")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal address" }));
    expect(onReveal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Same trace" }));
    expect(onPivot).toHaveBeenCalledWith("trace");
    rerender(<EventDetailPanel detail={detail()} revealed="203.0.113.7" onReveal={onReveal} revealing={false} onPivot={onPivot} pivoting={null} onAddToCase={() => undefined} />);
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("Reveal recorded")).toBeInTheDocument();
  });

  it("integrity summary reports a break truthfully", async () => {
    const status: IntegrityStatus = {
      headSeq: 10, headHash: "a".repeat(64), lastSealedAt: null, lastVerifiedAt: null, lastVerifyOk: null, lastVerifyBreakSeq: null,
      unsealed: 2, oldestUnsealedAgeSeconds: 2000, horizonSeconds: 900, counts: { events: 12, sealed: 10, tombstones: 0 },
      checkpointPublicKey: "pk", checkpointKeyRef: "k1", emitter: null,
    };
    const { container, rerender } = renderUi(<IntegritySummary status={status} verification={null} />);
    expect(screen.getByText("Not verified yet")).toBeInTheDocument();
    expect(screen.getByText("Sealing is behind")).toBeInTheDocument();
    await expectNoAxeViolations(container);
    rerender(<IntegritySummary status={status} verification={{ ok: false, checked: 5, pruned: 0, fromSeq: 1, lastSeq: 5, headSeq: 10, complete: false, firstBreak: { seq: 5, eventId: null, reason: "DIGEST_MISMATCH" }, checkpointsVerified: 0, unsealedOlderThanHorizon: 2, verifiedAt: "2026-11-20T12:00:00.000Z" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("First problem at record #5");
  });

  it("saved searches link through ?saved= and cases show empty state", async () => {
    const { container } = renderUi(
      <>
        <SavedQueriesTable rows={[{ id: ULID(5), name: "Denied logins", shared: true, mine: true, query: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z" }, updatedAt: "2026-11-20T00:00:00.000Z" }]} loading={false} error={null} onRetry={() => undefined} onDelete={() => undefined} />
        <CasesTable rows={[]} loading={false} error={null} onRetry={() => undefined} onOpen={() => undefined} />
      </>,
    );
    expect(screen.getAllByRole("link", { name: "Denied logins" })[0]).toHaveAttribute("href", `/admin/audit?saved=${ULID(5)}`);
    expect(screen.getByText("No cases")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("case detail adds notes and keeps the draft when saving fails", async () => {
    const onAddNote = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const user = userEvent.setup();
    const { container } = renderUi(<CaseDetailView detail={{ id: ULID(6), title: "Case", status: "open", severity: "WARN", eventCount: 1, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", closedAt: null, events: [event(1)], notes: [] }} onStatus={() => undefined} statusBusy={false} onAddNote={onAddNote} noteBusy={false} />);
    await expectNoAxeViolations(container);
    const box = screen.getByRole("textbox", { name: "Add a note" });
    await user.type(box, "Checked with the account owner");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(onAddNote).toHaveBeenCalledTimes(1));
    expect(box).toHaveValue("Checked with the account owner");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(box).toHaveValue(""));
  });
});

describe("exports and retention pages", () => {
  it("offers download only for completed, unexpired exports", async () => {
    const { container } = renderUi(<ExportsTable rows={[exportRow(), exportRow({ id: ULID(51), status: "running", byteSize: null }), exportRow({ id: ULID(52), expired: true })]} loading={false} error={null} onRetry={() => undefined} onDownload={() => undefined} onDetails={() => undefined} downloading={null} />);
    expect(screen.getAllByRole("button", { name: /^Download export/ })).toHaveLength(2); // one row × desktop + mobile renderings
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("refuses a download whose size does not match the manifest", async () => {
    handlers["audit.exports.list"] = () => [exportRow()];
    fetchMock.mockResolvedValue(new Response("short", { status: 200, headers: { "Content-Disposition": "attachment; filename=x.jsonl" } }));
    renderUi(<ExportsPage />, { path: "/admin/audit/exports" });
    fireEvent.click((await screen.findAllByRole("button", { name: /^Download export/ }))[0]!);
    expect(await screen.findByText("Incomplete download")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/audit\/exports\/01JTEST0+50\/download$/), { cache: "no-store" });
  });

  it("retention run requires typing the confirmation word", async () => {
    const state = {
      policies: [{ category: "security" as const, retainDays: 365, updatedAt: null }, { category: "business" as const, retainDays: null, updatedAt: null }],
      holds: [{ id: ULID(8), label: "Matter 1", categories: null, from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z", active: true, createdAt: "2026-11-01T00:00:00.000Z", releasedAt: null }],
      runs: [],
    };
    handlers["audit.retention.get"] = () => state;
    const run = vi.fn(() => ({ id: ULID(9), dryRun: false, status: "completed", counts: { security: 3 }, startedAt: "2026-11-20T00:00:00.000Z", finishedAt: null, checkpointId: null }));
    handlers["audit.retention.run"] = run;
    const user = userEvent.setup();
    const { container } = renderUi(<RetentionPage />, { path: "/admin/audit/retention" });
    expect((await screen.findAllByText("Forever")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Run retention now" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Remove events" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "REMOVE");
    await user.click(confirm);
    await waitFor(() => expect(run).toHaveBeenCalledWith({ dryRun: false }));
    expect(await screen.findByText("Retention complete")).toBeInTheDocument();
  });

  it("retention view renders policies and holds accessibly", async () => {
    const { container } = renderUi(<RetentionView state={{ policies: [], holds: [], runs: [] }} onEditPolicy={() => undefined} onReleaseHold={() => undefined} />);
    expect(screen.getByText("No legal holds")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
