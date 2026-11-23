/**
 * Built-in reports (D6). Panels reuse the custom-report compiler over the dataset whitelist; the few derived
 * measures (completion, turnaround, first response, phase, policy state) are fixed parameterised Drizzle queries
 * written here. Ranges are half-open [from, to) in UTC. Staff (no personal data) receive no panel that lists
 * customer identifiers; a note says so.
 */
import { and, count, countDistinct, eq, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { cartUpsellCartStates, carts } from "../cart/schema.js";
import { policyAcceptances, policyDocuments } from "../compliance/schema.js";
import { engagementSupportTicketMessages, engagementSupportTickets } from "../engagement/schema.js";
import { signInEvents, users } from "../identity/schema.js";
import { orders, orderStatusHistory, orderWorkflowVersions } from "../orders/schema.js";
import { isCancelState, type WorkflowDefinition } from "../orders/workflowTypes.js";
import { protectionSignInBans } from "../protection/schema.js";
import { referralEmailInvites } from "../referrals/schema.js";
import type { Tx } from "../../core/types.js";
import { fieldOf, getDataset } from "./catalogue.js";
import { compileSpec, specInvalid } from "./query.js";
import {
  REPORT_LIMITS, reportSpecSchema, type BuiltInKey, type Bucket, type Cell, type FieldType, type MetricView, type PanelView,
  type ReportSpecInput,
} from "./spec.js";

export const BUILT_INS: ReadonlyArray<{ key: BuiltInKey; title: string; description: string }> = [
  { key: "orders", title: "Orders", description: "Created, completed, status, phase, workflow, products, turnaround, overdue and revenue." },
  { key: "customers", title: "Customers", description: "New and active customers, lifecycle, top customers and policy acceptance." },
  { key: "referrals", title: "Referrals", description: "Invitations, sign-ups, conversions and rewards." },
  { key: "support", title: "Support", description: "Tickets opened and closed, status, category, priority, response and resolution times, backlog." },
  { key: "payments_discounts", title: "Payments and discounts", description: "Paid, refunded and waived amounts, providers, code redemptions and discount given." },
  { key: "carts", title: "Carts", description: "Open, abandoned and converted carts, upsell offers shown and accepted." },
  { key: "files_recordings", title: "Files and recordings", description: "Uploads, recordings, conversions and failures." },
  { key: "signins_security", title: "Sign-ins and security", description: "Sign-ins, failures, locks and sign-in bans." },
];

export interface Range { from: Date; to: Date }

export interface BuiltInContext {
  tx: Tx;
  range: Range;
  previous: Range | null;
  bucket: Bucket;
  includePersonal: boolean;
  overdueDays: number;
  now: Date;
}

export interface BuiltInOutput { metrics: MetricView[]; panels: PanelView[]; notes: string[] }

const PANEL_ROWS = 500;
const ABANDON_HOURS = 24;
const OPEN_TICKET_STATUSES = ["open", "pending_customer", "pending_staff"] as const;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
};

function inRange(expr: SQL | Parameters<typeof gte>[0], range: Range): SQL {
  return and(gte(expr, range.from), lt(expr, range.to)) as SQL;
}

function summarise(title: string, columns: PanelView["columns"], rows: Cell[][]): string {
  if (!rows.length) return `${title}: no data for this period.`;
  const valueIndex = columns.length - 1;
  const top = rows.slice(0, 3).map((row) => `${row.slice(0, valueIndex).map((c) => c ?? "none").join(" / ")}: ${row[valueIndex] ?? 0}`);
  return `${title}: ${rows.length} row${rows.length === 1 ? "" : "s"}. ${top.join("; ")}${rows.length > 3 ? "; …" : ""}.`;
}

function makePanel(key: string, title: string, chart: PanelView["chart"], columns: PanelView["columns"], rows: Cell[][], truncated = false): PanelView {
  return { key, title, chart, columns, rows, rowCount: rows.length, truncated, summary: summarise(title, columns, rows) };
}

class Builder {
  readonly metrics: MetricView[] = [];
  readonly panels: PanelView[] = [];
  readonly notes: string[] = [];
  constructor(readonly ctx: BuiltInContext) {}

  private where(dataset: string, timeField: string, range: Range): SQL[] {
    const def = getDataset(dataset);
    const field = def && fieldOf(def, timeField);
    if (!field) throw specInvalid("Unknown report field.", timeField);
    return [inRange(field.expr, range)];
  }

  /** Panel from a whitelisted spec, ranged on `timeField` (null = current snapshot). */
  async spec(key: string, title: string, chart: PanelView["chart"], input: ReportSpecInput, timeField: string | null, personal = false) {
    if (personal && !this.ctx.includePersonal) {
      this.notes.push(`${title}: hidden because it lists customer identifiers.`);
      return;
    }
    const spec = reportSpecSchema.parse({ limit: PANEL_ROWS, ...input });
    const compiled = compileSpec(spec, {
      includePersonal: this.ctx.includePersonal,
      extraWhere: timeField ? this.where(spec.dataset, timeField, this.ctx.range) : [],
    });
    const rows = await compiled.fetch(this.ctx.tx, PANEL_ROWS + 1);
    this.panels.push(makePanel(key, title, chart, compiled.columns, rows.slice(0, PANEL_ROWS), rows.length > PANEL_ROWS));
  }

  /** Over-time panel: one count per bucket of `timeField`. */
  async series(key: string, title: string, dataset: string, timeField: string, filters: ReportSpecInput["filters"] = []) {
    await this.spec(key, title, "line", {
      dataset, filters, groupBy: [{ field: timeField, bucket: this.ctx.bucket }], aggregates: [{ fn: "count" }],
      sort: [{ key: timeField, dir: "asc" }],
    }, timeField);
  }

  async breakdown(key: string, title: string, dataset: string, timeField: string | null, by: string[], filters: ReportSpecInput["filters"] = []) {
    await this.spec(key, title, "bar", {
      dataset, filters, groupBy: by.map((field) => ({ field })), aggregates: [{ fn: "count" }], sort: [{ key: "count", dir: "desc" }],
    }, timeField);
  }

  /** Metric over the range and (when requested) the previous range. `compute` returns the single value. */
  async metric(key: string, label: string, type: FieldType, compute: (range: Range) => Promise<number | null>, options: { snapshot?: boolean } = {}) {
    const value = await compute(this.ctx.range);
    const previous = this.ctx.previous && !options.snapshot ? await compute(this.ctx.previous) : null;
    this.metrics.push({ key, label, type, value, previous });
  }

  /** Money metric: a value only when the period has a single currency. */
  async money(key: string, label: string, compute: (range: Range) => Promise<Array<{ currency: string | null; amount: unknown }>>) {
    const single = (rows: Array<{ currency: string | null; amount: unknown }>) => {
      const present = rows.filter((row) => row.currency);
      if (present.length === 0) return { value: 0, currency: null };
      if (present.length > 1) return { value: null, currency: null };
      return { value: num(present[0]!.amount), currency: present[0]!.currency };
    };
    const now = single(await compute(this.ctx.range));
    const before = this.ctx.previous ? single(await compute(this.ctx.previous)) : null;
    const previous = before && (before.currency === now.currency || before.value === 0) ? before.value : null;
    this.metrics.push({ key, label, type: "money", value: now.value, currency: now.currency, previous });
    if (now.value === null) this.notes.push(`${label}: several currencies in this period; see the breakdown by currency.`);
  }

  countSpec(dataset: string, timeField: string, filters: ReportSpecInput["filters"] = []) {
    return async (range: Range) => {
      const spec = reportSpecSchema.parse({ dataset, filters, aggregates: [{ fn: "count" }], limit: 1 });
      const compiled = compileSpec(spec, { includePersonal: this.ctx.includePersonal, extraWhere: this.where(dataset, timeField, range) });
      const [row] = await compiled.fetch(this.ctx.tx, 1);
      return num(row?.[0]) ?? 0;
    };
  }

  sumByCurrency(dataset: string, timeField: string, amountField: string, filters: ReportSpecInput["filters"] = []) {
    return async (range: Range) => {
      const spec = reportSpecSchema.parse({
        dataset, filters, groupBy: [{ field: "currency" }], aggregates: [{ fn: "sum", field: amountField }], limit: 50,
      });
      const compiled = compileSpec(spec, { includePersonal: this.ctx.includePersonal, extraWhere: this.where(dataset, timeField, range) });
      const rows = await compiled.fetch(this.ctx.tx, 50);
      return rows.map((row) => ({ currency: typeof row[0] === "string" ? row[0] : null, amount: row[1] }));
    };
  }
}

/* --------------------------------------------------------------------- workflow facts ------------------------ */

interface WorkflowFacts {
  /** Terminal, non-cancel state keys across all workflow versions. */
  completedKeys: string[];
  terminalKeys: string[];
  phaseOf: (versionId: number, statusKey: string) => string;
}

async function workflowFacts(tx: Tx): Promise<WorkflowFacts> {
  const versions = await tx.select({ id: orderWorkflowVersions.id, definition: orderWorkflowVersions.definition })
    .from(orderWorkflowVersions).limit(2_000);
  const completed = new Set<string>();
  const terminal = new Set<string>();
  const phases = new Map<number, Map<string, string>>();
  for (const version of versions) {
    const definition = version.definition as WorkflowDefinition | null;
    const labels = new Map((definition?.phases ?? []).map((phase) => [phase.key, phase.label]));
    const byState = new Map<string, string>();
    for (const state of definition?.states ?? []) {
      if (state.kind === "terminal") {
        terminal.add(state.key);
        if (!isCancelState(state)) completed.add(state.key);
      }
      byState.set(state.key, state.phase ? labels.get(state.phase) ?? state.phase : "No phase");
    }
    phases.set(version.id, byState);
  }
  if (!completed.size) completed.add("completed");
  if (!terminal.size) { terminal.add("completed"); terminal.add("canceled"); }
  return {
    completedKeys: [...completed],
    terminalKeys: [...terminal],
    phaseOf: (versionId, statusKey) => phases.get(versionId)?.get(statusKey) ?? "No phase",
  };
}

/* --------------------------------------------------------------------- reports ------------------------------- */

async function ordersReport(b: Builder) {
  const { tx, now, overdueDays } = b.ctx;
  const facts = await workflowFacts(tx);
  const completedIn = (range: Range) => tx.select({ value: countDistinct(orderStatusHistory.orderId) }).from(orderStatusHistory)
    .where(and(inArray(orderStatusHistory.toStatus, facts.completedKeys), inRange(orderStatusHistory.occurredAt, range)));
  await b.metric("created", "Orders created", "number", b.countSpec("orders", "createdAt"));
  await b.metric("submitted", "Orders submitted", "number", b.countSpec("orders", "submittedAt"));
  await b.metric("completed", "Orders completed", "number", async (range) => num((await completedIn(range))[0]?.value) ?? 0);
  await b.metric("turnaround", "Average turnaround", "duration", async (range) => {
    const done = tx.select({ orderId: orderStatusHistory.orderId, doneAt: sql<Date>`MIN(${orderStatusHistory.occurredAt})`.as("done_at") })
      .from(orderStatusHistory).where(inArray(orderStatusHistory.toStatus, facts.completedKeys))
      .groupBy(orderStatusHistory.orderId).as("done");
    const [row] = await tx.select({
      value: sql<number>`AVG(GREATEST(0, TIMESTAMPDIFF(SECOND, COALESCE(${orders.submittedAt}, ${orders.createdAt}), ${done.doneAt})))`,
    }).from(done).innerJoin(orders, eq(orders.id, done.orderId)).where(inRange(done.doneAt, range));
    return num(row?.value);
  });
  const overdueBefore = new Date(now.getTime() - overdueDays * 86_400_000);
  const overdueWhere = and(notInArray(orders.statusKey, facts.terminalKeys), lt(sql`COALESCE(${orders.submittedAt}, ${orders.createdAt})`, overdueBefore));
  await b.metric("overdue", `Open longer than ${overdueDays} days`, "number", async () => {
    const [row] = await tx.select({ value: count() }).from(orders).where(overdueWhere);
    return num(row?.value) ?? 0;
  }, { snapshot: true });
  await b.money("revenue", "Revenue (submitted orders)", b.sumByCurrency("orders", "submittedAt", "total"));

  await b.series("created_over_time", "Orders created", "orders", "createdAt");
  await b.breakdown("by_status", "Orders by status", "orders", "createdAt", ["status"]);
  await b.breakdown("by_workflow", "Orders by workflow", "orders", "createdAt", ["workflow"]);
  const phaseRows = await tx.select({ versionId: orders.workflowVersionId, statusKey: orders.statusKey, value: count() }).from(orders)
    .where(inRange(orders.createdAt, b.ctx.range)).groupBy(orders.workflowVersionId, orders.statusKey).limit(5_000);
  const byPhase = new Map<string, number>();
  for (const row of phaseRows) {
    const phase = facts.phaseOf(row.versionId, row.statusKey);
    byPhase.set(phase, (byPhase.get(phase) ?? 0) + Number(row.value));
  }
  b.panels.push(makePanel("by_phase", "Orders by current phase", "bar",
    [{ key: "phase", label: "Phase", type: "string" }, { key: "count", label: "Count", type: "number" }],
    [...byPhase.entries()].sort((x, y) => y[1] - x[1]).map(([phase, value]) => [phase, value])));
  await b.spec("by_product", "Order lines by product and tier", "bar", {
    dataset: "order_items", groupBy: [{ field: "name" }, { field: "tier" }],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "quantity" }], sort: [{ key: "count", dir: "desc" }],
  }, "orderCreatedAt");
  await b.spec("revenue_by_currency", "Revenue by currency (submitted orders)", "bar", {
    dataset: "orders", groupBy: [{ field: "currency" }], aggregates: [{ fn: "count" }, { fn: "sum", field: "total" }],
  }, "submittedAt");
  const overdue = await tx.select({ reference: orders.reference, status: orders.statusKey, since: sql<Date>`COALESCE(${orders.submittedAt}, ${orders.createdAt})` })
    .from(orders).where(overdueWhere).orderBy(sql`COALESCE(${orders.submittedAt}, ${orders.createdAt})`).limit(50);
  b.panels.push(makePanel("overdue", `Oldest orders open longer than ${overdueDays} days`, "table",
    [{ key: "reference", label: "Order number", type: "string" }, { key: "status", label: "Status", type: "string" }, { key: "openSeconds", label: "Open for", type: "duration" }],
    overdue.map((row) => [row.reference, row.status, Math.max(0, Math.round((now.getTime() - new Date(row.since).getTime()) / 1000))])));
}

async function customersReport(b: Builder) {
  const { tx } = b.ctx;
  await b.metric("new", "New customers", "number", b.countSpec("customers", "createdAt"));
  await b.metric("active", "Active customers (signed in)", "number", async (range) => {
    const [row] = await tx.select({ value: countDistinct(signInEvents.userId) }).from(signInEvents)
      .where(and(eq(signInEvents.kind, "success"), eq(signInEvents.role, "customer"), inRange(signInEvents.occurredAt, range)));
    return num(row?.value) ?? 0;
  });
  await b.series("new_over_time", "New customers", "customers", "createdAt");
  await b.breakdown("by_lifecycle", "All customers by lifecycle", "customers", null, ["status"]);
  if (b.ctx.includePersonal) {
    const top = await tx.select({ customerNumber: users.customerRef, currency: orders.currency, orders: count(), revenue: sql<number>`SUM(${orders.totalMinor})` })
      .from(orders).innerJoin(users, eq(users.id, orders.ownerUserId))
      .where(and(eq(users.role, "customer"), inRange(orders.createdAt, b.ctx.range)))
      .groupBy(users.id, users.customerRef, orders.currency).orderBy(sql`COUNT(*) DESC`, sql`SUM(${orders.totalMinor}) DESC`).limit(10);
    b.panels.push(makePanel("top_customers", "Top customers by orders and revenue", "table", [
      { key: "customerNumber", label: "Customer number", type: "string" }, { key: "currency", label: "Currency", type: "string" },
      { key: "orders", label: "Orders", type: "number" }, { key: "revenue", label: "Revenue", type: "money", currency: null },
    ], top.map((row) => [row.customerNumber, row.currency, num(row.orders), num(row.revenue)])));
  } else {
    b.notes.push("Top customers: hidden because it lists customer identifiers.");
  }
  const docs = await tx.select({ id: policyDocuments.id, title: policyDocuments.title, versionId: policyDocuments.currentPublishedVersionId })
    .from(policyDocuments)
    .where(and(eq(policyDocuments.active, true), eq(policyDocuments.requiresAcceptance, true), isNotNull(policyDocuments.currentPublishedVersionId), ne(policyDocuments.audience, "staff")))
    .limit(50);
  const [active] = await tx.select({ value: count() }).from(users).where(and(eq(users.role, "customer"), eq(users.status, "active")));
  const activeCustomers = num(active?.value) ?? 0;
  const rows: Cell[][] = [];
  for (const doc of docs) {
    const [accepted] = await tx.select({ value: countDistinct(policyAcceptances.userId) }).from(policyAcceptances)
      .innerJoin(users, eq(users.id, policyAcceptances.userId))
      .where(and(eq(policyAcceptances.policyVersionId, doc.versionId!), eq(users.role, "customer"), eq(users.status, "active")));
    const value = num(accepted?.value) ?? 0;
    rows.push([doc.title, value, Math.max(0, activeCustomers - value)]);
  }
  b.panels.push(makePanel("policy_state", "Active customers and the current policy versions", "bar", [
    { key: "policy", label: "Policy", type: "string" }, { key: "accepted", label: "Accepted", type: "number" },
    { key: "notAccepted", label: "Not yet accepted", type: "number" },
  ], rows));
}

async function referralsReport(b: Builder) {
  const { tx } = b.ctx;
  await b.metric("invitations", "Invitations sent", "number", async (range) => {
    const [row] = await tx.select({ value: count() }).from(referralEmailInvites)
      .where(and(eq(referralEmailInvites.outcome, "enqueued"), inRange(referralEmailInvites.createdAt, range)));
    return num(row?.value) ?? 0;
  });
  await b.metric("signups", "Referred sign-ups", "number", b.countSpec("referrals", "attributedAt"));
  await b.metric("conversions", "Conversions", "number", b.countSpec("referrals", "qualifiedAt"));
  await b.money("rewards", "Rewards credited", b.sumByCurrency("referrals", "creditedAt", "reward"));
  await b.series("signups_over_time", "Referred sign-ups", "referrals", "attributedAt");
  await b.breakdown("by_status", "Referrals by status", "referrals", "attributedAt", ["status"]);
  await b.spec("rewards_by_currency", "Rewards credited by currency", "bar", {
    dataset: "referrals", groupBy: [{ field: "currency" }], aggregates: [{ fn: "count" }, { fn: "sum", field: "reward" }],
  }, "creditedAt");
}

async function supportReport(b: Builder) {
  const { tx, now } = b.ctx;
  const t = engagementSupportTickets;
  const m = engagementSupportTicketMessages;
  const closedAt = sql`COALESCE(${t.closedAt}, ${t.resolvedAt})`;
  const resolvedAt = sql`COALESCE(${t.resolvedAt}, ${t.closedAt})`;
  await b.metric("opened", "Tickets opened", "number", b.countSpec("support_tickets", "createdAt"));
  await b.metric("closed", "Tickets resolved or closed", "number", async (range) => {
    const [row] = await tx.select({ value: count() }).from(t).where(inRange(closedAt, range));
    return num(row?.value) ?? 0;
  });
  await b.metric("first_response", "Average time to first response", "duration", async (range) => {
    const first = tx.select({ ticketId: m.ticketId, at: sql<Date>`MIN(${m.createdAt})`.as("first_at") }).from(m).innerJoin(t, eq(t.id, m.ticketId))
      .where(and(inArray(m.authorRole, ["staff", "admin"]), eq(m.internalOnly, false), gte(m.createdAt, t.createdAt)))
      .groupBy(m.ticketId).as("first_reply");
    const [row] = await tx.select({ value: sql<number>`AVG(GREATEST(0, TIMESTAMPDIFF(SECOND, ${t.createdAt}, ${first.at})))` })
      .from(t).innerJoin(first, eq(first.ticketId, t.id)).where(inRange(t.createdAt, range));
    return num(row?.value);
  });
  await b.metric("resolution", "Average time to resolution", "duration", async (range) => {
    const [row] = await tx.select({ value: sql<number>`AVG(GREATEST(0, TIMESTAMPDIFF(SECOND, ${t.createdAt}, ${resolvedAt})))` })
      .from(t).where(inRange(resolvedAt, range));
    return num(row?.value);
  });
  await b.metric("backlog", "Open backlog", "number", async () => {
    const [row] = await tx.select({ value: count() }).from(t).where(inArray(t.status, OPEN_TICKET_STATUSES));
    return num(row?.value) ?? 0;
  }, { snapshot: true });
  await b.series("opened_over_time", "Tickets opened", "support_tickets", "createdAt");
  await b.breakdown("by_status", "Tickets by status", "support_tickets", "createdAt", ["status"]);
  await b.breakdown("by_category", "Tickets by category", "support_tickets", "createdAt", ["category"]);
  await b.breakdown("by_priority", "Tickets by priority", "support_tickets", "createdAt", ["priority"]);
  const age = sql`TIMESTAMPDIFF(HOUR, ${t.createdAt}, ${now})`;
  const bucket = sql<string>`CASE WHEN ${age} < 24 THEN 'Under 24 hours' WHEN ${age} < 72 THEN '1–3 days' WHEN ${age} < 168 THEN '3–7 days' ELSE 'Over 7 days' END`;
  const backlog = await tx.select({ bucket, value: count(), order: sql<number>`MIN(${age})` }).from(t)
    .where(inArray(t.status, OPEN_TICKET_STATUSES)).groupBy(bucket).orderBy(sql`MIN(${age})`);
  b.panels.push(makePanel("backlog_age", "Open backlog by age", "bar",
    [{ key: "age", label: "Age", type: "string" }, { key: "count", label: "Tickets", type: "number" }],
    backlog.map((row) => [row.bucket, num(row.value)])));
}

async function paymentsReport(b: Builder) {
  const paid: ReportSpecInput["filters"] = [{ field: "status", op: "eq", value: "succeeded" }, { field: "method", op: "neq", value: "waiver" }];
  await b.money("paid", "Paid", b.sumByCurrency("payments", "receivedAt", "amount", paid));
  await b.money("refunded", "Refunded", b.sumByCurrency("refunds", "refundedAt", "amount"));
  await b.metric("waived", "Payments waived", "number", b.countSpec("payments", "receivedAt", [{ field: "method", op: "eq", value: "waiver" }]));
  await b.metric("redemptions", "Code redemptions", "number", b.countSpec("promo_redemptions", "createdAt", [{ field: "status", op: "eq", value: "redeemed" }]));
  await b.money("promo_discount", "Discount given by codes", b.sumByCurrency("promo_redemptions", "createdAt", "promoDiscount", [{ field: "status", op: "eq", value: "redeemed" }]));
  await b.spec("paid_by_provider", "Paid by provider", "bar", {
    dataset: "payments", filters: paid, groupBy: [{ field: "provider" }, { field: "currency" }],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "amount" }], sort: [{ key: "count", dir: "desc" }],
  }, "receivedAt");
  await b.spec("refunds_by_provider", "Refunds by provider", "bar", {
    dataset: "refunds", groupBy: [{ field: "provider" }, { field: "currency" }], aggregates: [{ fn: "count" }, { fn: "sum", field: "amount" }],
  }, "refundedAt");
  await b.spec("redemptions_by_promotion", "Redemptions by promotion", "bar", {
    dataset: "promo_redemptions", filters: [{ field: "status", op: "eq", value: "redeemed" }],
    groupBy: [{ field: "label" }, { field: "currency" }], aggregates: [{ fn: "count" }, { fn: "sum", field: "promoDiscount" }],
    sort: [{ key: "count", dir: "desc" }],
  }, "createdAt");
}

async function cartsReport(b: Builder) {
  const { tx, now } = b.ctx;
  const staleBefore = new Date(now.getTime() - ABANDON_HOURS * 3_600_000);
  await b.metric("created", "Carts created", "number", b.countSpec("carts", "createdAt"));
  await b.metric("open", "Open carts now", "number", b.countSpec("carts", "createdAt", [{ field: "status", op: "eq", value: "open" }]), { snapshot: true });
  await b.metric("abandoned", `Abandoned (expired, or idle over ${ABANDON_HOURS} hours)`, "number", async (range) => {
    const spec = reportSpecSchema.parse({ dataset: "carts", aggregates: [{ fn: "count" }], limit: 1 });
    const compiled = compileSpec(spec, {
      includePersonal: false,
      extraWhere: [inRange(carts.createdAt, range), or(eq(carts.status, "expired"), and(eq(carts.status, "open"), lt(carts.lastActivityAt, staleBefore))) as SQL],
    });
    const [row] = await compiled.fetch(tx, 1);
    return num(row?.[0]) ?? 0;
  });
  await b.metric("converted", "Converted (checked out)", "number", b.countSpec("carts", "checkedOutAt"));
  const upsell = (column: typeof cartUpsellCartStates.firstShownAt) => async (range: Range) => {
    const [row] = await tx.select({ value: count() }).from(cartUpsellCartStates).where(inRange(column, range));
    return num(row?.value) ?? 0;
  };
  await b.metric("upsell_shown", "Upsell offers shown", "number", upsell(cartUpsellCartStates.firstShownAt));
  await b.metric("upsell_accepted", "Upsell offers accepted", "number", upsell(cartUpsellCartStates.acceptedAt));
  await b.series("created_over_time", "Carts created", "carts", "createdAt");
  await b.breakdown("by_status", "Carts by status", "carts", "createdAt", ["status"]);
  const offers = await tx.select({
    offerKey: cartUpsellCartStates.offerKey,
    shown: sql<number>`SUM(${cartUpsellCartStates.firstShownAt} IS NOT NULL)`,
    accepted: sql<number>`SUM(${cartUpsellCartStates.acceptedAt} IS NOT NULL)`,
    dismissed: sql<number>`SUM(${cartUpsellCartStates.dismissedAt} IS NOT NULL)`,
  }).from(cartUpsellCartStates).where(inRange(sql`COALESCE(${cartUpsellCartStates.firstShownAt}, ${cartUpsellCartStates.createdAt})`, b.ctx.range))
    .groupBy(cartUpsellCartStates.offerKey).orderBy(sql`SUM(${cartUpsellCartStates.firstShownAt} IS NOT NULL) DESC`).limit(100);
  b.panels.push(makePanel("upsell_offers", "Upsell offers", "bar", [
    { key: "offer", label: "Offer", type: "string" }, { key: "shown", label: "Shown", type: "number" },
    { key: "accepted", label: "Accepted", type: "number" }, { key: "dismissed", label: "Dismissed", type: "number" },
  ], offers.map((row) => [row.offerKey, num(row.shown), num(row.accepted), num(row.dismissed)])));
}

async function filesReport(b: Builder) {
  await b.metric("uploads", "Files uploaded", "number", b.countSpec("files", "createdAt"));
  await b.metric("recordings", "Audio and video files", "number", b.countSpec("files", "createdAt", [{ field: "recording", op: "eq", value: true }]));
  await b.metric("converted", "Conversions completed", "number", b.countSpec("files", "createdAt", [{ field: "conversionState", op: "eq", value: "converted" }]));
  await b.metric("failed", "Conversion failures", "number", b.countSpec("files", "createdAt", [{ field: "conversionState", op: "eq", value: "failed" }]));
  await b.series("uploads_over_time", "Files uploaded", "files", "createdAt");
  await b.breakdown("by_category", "Files by category", "files", "createdAt", ["category"]);
  await b.breakdown("by_type", "Files by content type", "files", "createdAt", ["contentType"]);
  await b.breakdown("conversions", "Conversions by state", "files", "createdAt", ["conversionState"], [{ field: "conversionState", op: "isNotNull" }]);
}

async function securityReport(b: Builder) {
  const { tx, now } = b.ctx;
  await b.metric("signins", "Successful sign-ins", "number", b.countSpec("sign_ins", "occurredAt", [{ field: "kind", op: "eq", value: "success" }]));
  await b.metric("failures", "Failed sign-ins", "number", b.countSpec("sign_ins", "occurredAt", [{ field: "kind", op: "eq", value: "failure" }]));
  await b.metric("locks", "Account locks", "number", b.countSpec("sign_ins", "occurredAt", [{ field: "kind", op: "eq", value: "lock" }]));
  await b.metric("bans", "Sign-in bans created", "number", async (range) => {
    const [row] = await tx.select({ value: count() }).from(protectionSignInBans).where(inRange(protectionSignInBans.createdAt, range));
    return num(row?.value) ?? 0;
  });
  await b.metric("active_bans", "Sign-in bans in force", "number", async () => {
    const [row] = await tx.select({ value: count() }).from(protectionSignInBans)
      .where(or(isNull(protectionSignInBans.expiresAt), gte(protectionSignInBans.expiresAt, now)));
    return num(row?.value) ?? 0;
  }, { snapshot: true });
  await b.spec("over_time", "Sign-in events", "line", {
    dataset: "sign_ins", groupBy: [{ field: "occurredAt", bucket: b.ctx.bucket }, { field: "kind" }], aggregates: [{ fn: "count" }],
    sort: [{ key: "occurredAt", dir: "asc" }],
  }, "occurredAt");
  await b.breakdown("failure_reasons", "Failures by reason", "sign_ins", "occurredAt", ["reasonCode"], [{ field: "kind", op: "eq", value: "failure" }]);
  const bans = await tx.select({ source: protectionSignInBans.source, value: count() }).from(protectionSignInBans)
    .where(inRange(protectionSignInBans.createdAt, b.ctx.range)).groupBy(protectionSignInBans.source);
  b.panels.push(makePanel("bans_by_source", "Sign-in bans by source", "bar",
    [{ key: "source", label: "Source", type: "string" }, { key: "count", label: "Bans", type: "number" }],
    bans.map((row) => [row.source, num(row.value)])));
}

const RUNNERS: Record<BuiltInKey, (b: Builder) => Promise<void>> = {
  orders: ordersReport,
  customers: customersReport,
  referrals: referralsReport,
  support: supportReport,
  payments_discounts: paymentsReport,
  carts: cartsReport,
  files_recordings: filesReport,
  signins_security: securityReport,
};

export async function runBuiltIn(key: BuiltInKey, ctx: BuiltInContext): Promise<BuiltInOutput> {
  const builder = new Builder(ctx);
  await RUNNERS[key](builder);
  if (!ctx.includePersonal && !builder.notes.some((note) => note.includes("identifiers"))) {
    builder.notes.push("Customer identifiers are not shown for your role.");
  }
  return { metrics: builder.metrics, panels: builder.panels, notes: builder.notes };
}

export const PANEL_LIMIT = { rows: PANEL_ROWS, csvRows: REPORT_LIMITS.csvRows } as const;
