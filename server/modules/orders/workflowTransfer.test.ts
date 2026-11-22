/**
 * Increment 05 (A1) — workflow export / import: authorisation matrix, feature switch, round trip, drafts only,
 * idempotent apply, and the import abuse cases of contract §4 (oversized, deeply nested, wrong digest, unknown keys,
 * __proto__ / constructor keys, duplicate keys, 51 workflows, HTML in names, references to unknown policies).
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orderWorkflowDrafts, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { toDraft } from "./workflowDesign.js";
import { DEFAULT_WORKFLOW } from "./workflowTypes.js";
import { canonicalJson, jsonDepth, packageDigest } from "./workflowTransfer.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let adminNoStepUp: TestUser;
let staff: TestUser;
let alice: TestUser;

const POLICY_TERMS = `01JD${"0".repeat(19)}T01`;
const POLICY_OTHER = `01JD${"0".repeat(19)}T02`;
const POLICY_STAFF = `01JD${"0".repeat(19)}T03`;
let published: { documentPublicId: string; slug: string; title: string; audience: string }[];

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return error as DomainError;
  }
  throw new Error(`expected ${expected}`);
}
const call = (user: TestUser | null) =>
  createCallerFactory(ordersRouter)({ services: h.services, session: user?.principal ?? null, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
const transfer = () => mod.workflowTransfer;
let keySeq = 0;
const idem = () => `import-key-${String((keySeq += 1)).padStart(8, "0")}`;

type Pkg = { workflows: Record<string, unknown>[]; references: { policies: Record<string, unknown>[] }; integrity: { digest: string }; [key: string]: unknown };
async function exportAll(): Promise<Pkg> {
  const { packageText } = await transfer().exportPackage(admin.principal, { selection: { all: true } });
  return JSON.parse(packageText) as Pkg;
}
/** Re-seal after an edit (the digest then matches, so the edit itself is what is tested). */
const seal = (pkg: Pkg) => {
  pkg.integrity.digest = packageDigest(pkg.workflows, pkg.references);
  return JSON.stringify(pkg);
};
const counts = async () => ({
  workflows: (await t.db.select({ id: orderWorkflows.id }).from(orderWorkflows)).length,
  versions: (await t.db.select({ id: orderWorkflowVersions.id }).from(orderWorkflowVersions)).length,
  drafts: (await t.db.select({ id: orderWorkflowDrafts.id }).from(orderWorkflowDrafts)).length,
  defaultKey: (await t.db.select({ key: orderWorkflows.workflowKey }).from(orderWorkflows).where(eq(orderWorkflows.isDefault, true)))[0]?.key,
});
const clearDrafts = async () => {
  await t.db.delete(orderWorkflowDrafts).where(isNull(orderWorkflowDrafts.baseVersionId));
  await t.db.delete(orderWorkflowDrafts);
};

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  published = [
    { documentPublicId: POLICY_TERMS, slug: "terms", title: "Synthetic terms", audience: "customer" },
    { documentPublicId: POLICY_OTHER, slug: "other-terms", title: "Synthetic other terms", audience: "all" },
    { documentPublicId: POLICY_STAFF, slug: "staff-handbook", title: "Synthetic staff handbook", audience: "staff" },
  ];
  h.services.compliance = { listPublishedPolicies: async () => published } as unknown as Services["compliance"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  adminNoStepUp = await insertUser(h, t.db, { role: "admin" });
  staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
  alice = await insertUser(h, t.db);
  await h.settings.set("orders.workflow_rules.enabled", true);
  await mod.workflows.installStandard(admin.principal);
  // A published workflow with an acceptance gate on a published customer policy.
  const draft = await mod.workflows.createDraft(admin.principal, { from: "standard", workflowKey: "intake", name: "Synthetic intake" });
  const definition = { ...toDraft(DEFAULT_WORKFLOW), acceptanceGates: [{ key: "terms", policyPublicId: POLICY_TERMS, point: "order_start" as const, signatureMode: "checkbox" as const, askAgainOnNewVersion: true }] };
  await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Synthetic intake", definition, layout: { nodes: [{ key: "submitted", x: 10, y: 20 }] } });
  await mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: false });
});
afterAll(() => t.cleanup());
beforeEach(async () => {
  await h.settings.set("orders.workflow_transfer.enabled", true);
});

describe("workflow transfer: authorisation and switch", () => {
  it("anonymous, customers and staff are refused; admins need step-up to preview or apply", async () => {
    await expect(call(null).admin.workflows.transfer.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(alice).admin.workflows.transfer.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const user of [alice, staff]) {
      await expect(call(user).admin.workflows.transfer.export({ selection: { all: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(call(user).admin.workflows.transfer.preview({ packageText: "{}" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(call(user).admin.workflows.transfer.applyImport({ packageText: "{}", idempotencyKey: idem(), decisions: [], policyMappings: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(call(adminNoStepUp).admin.workflows.transfer.preview({ packageText: "{}" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The service re-checks persisted step-up in the transaction (zero trust), not just the session snapshot.
    await expectError(transfer().preview(adminNoStepUp.principal, { packageText: "{}" }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expectError(transfer().exportPackage(staff.principal, { selection: { all: true } }), "FORBIDDEN:ACTOR_NOT_AUTHORIZED");
    expect(await call(admin).admin.workflows.transfer.status()).toEqual({ enabled: true, canExport: true, canImport: true, maxBytes: 2_097_152, maxWorkflows: 50 });
    // A body over 2 MiB is refused by the input schema before the service.
    await expect(call(admin).admin.workflows.transfer.preview({ packageText: "x".repeat(2_097_153) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("off by default: every step is refused and status says so", async () => {
    await h.settings.set("orders.workflow_transfer.enabled", false);
    expect((await transfer().status(admin.principal)).enabled).toBe(false);
    await expectError(transfer().exportPackage(admin.principal, { selection: { all: true } }), "FORBIDDEN:WORKFLOW_TRANSFER_DISABLED");
    await expectError(transfer().preview(admin.principal, { packageText: "{}" }), "FORBIDDEN:WORKFLOW_TRANSFER_DISABLED");
    await expectError(transfer().applyImport(admin.principal, { packageText: seal(await exportAllWhileOff()), idempotencyKey: idem(), decisions: [], policyMappings: [] }), "FORBIDDEN:WORKFLOW_TRANSFER_DISABLED");
  });
});

async function exportAllWhileOff(): Promise<Pkg> {
  await h.settings.set("orders.workflow_transfer.enabled", true);
  const pkg = await exportAll();
  await h.settings.set("orders.workflow_transfer.enabled", false);
  return pkg;
}

describe("workflow transfer: export", () => {
  it("exports published definitions with layout and portable policy references, no local ids; audited", async () => {
    await clearDrafts();
    const standalone = await mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "sketch", name: "Synthetic sketch" });
    const { fileName, packageText } = await transfer().exportPackage(admin.principal, { selection: { all: true } });
    expect(fileName).toMatch(/^readypackets-workflows-\d{8}-\d{4}\.json$/);
    const pkg = JSON.parse(packageText) as Pkg;
    expect(pkg).toMatchObject({ format: "readypackets.workflows", formatVersion: 1, source: { release: expect.any(String), label: expect.any(String) }, integrity: { algorithm: "sha256" } });
    expect(pkg.integrity.digest).toBe(packageDigest(pkg.workflows, pkg.references));
    expect(pkg.workflows.map((workflow) => [workflow.key, workflow.unpublished])).toEqual([
      ["intake", false],
      ["sketch", true],
      ["standard", false],
    ]);
    const intake = pkg.workflows[0] as { definition: { acceptanceGates: { policyRef: string }[] }; layout: unknown; description: unknown };
    expect(intake.definition.acceptanceGates[0]!.policyRef).toBe("policy_1");
    expect(intake.layout).toEqual({ nodes: [{ key: "submitted", x: 10, y: 20 }] });
    expect(intake.description).toBeNull();
    expect(pkg.references.policies).toEqual([{ ref: "policy_1", slug: "terms", title: "Synthetic terms", audience: "customer" }]);
    for (const secret of [POLICY_TERMS, admin.publicId, standalone.publicId]) expect(packageText).not.toContain(secret);
    expect(packageText).not.toMatch(/"(id|userId|workflowId|versionId|createdByUserId)"/);
    const event = h.audit.events.filter((e) => e.eventName === "workflow.exported").at(-1)!;
    expect(event).toMatchObject({ action: "export", attributes: { digest: pkg.integrity.digest, keys: "intake,sketch,standard", selection: "all" }, safeCounts: { workflows: 3, unpublished: 1, policy_references: 1 } });
  });

  it("a selection exports only the named keys; an unknown key is not found", async () => {
    const { packageText } = await transfer().exportPackage(admin.principal, { selection: { workflowKeys: ["standard"] } });
    const pkg = JSON.parse(packageText) as Pkg;
    expect(pkg.workflows.map((workflow) => workflow.key)).toEqual(["standard"]);
    expect(pkg.references.policies).toEqual([]);
    await expectError(transfer().exportPackage(admin.principal, { selection: { workflowKeys: ["nope_missing"] } }), "NOT_FOUND:WORKFLOW_NOT_FOUND");
  });

  it("canonical JSON sorts keys at every level and the depth scan ignores brackets in strings", () => {
    expect(canonicalJson({ b: [{ d: 1, c: "x" }], a: null })).toBe('{"a":null,"b":[{"c":"x","d":1}]}');
    expect(jsonDepth('{"a":"[[[[[[","b":[1]}', 24)).toBe(2);
  });
});

describe("workflow transfer: preview and apply", () => {
  it("preview shows existing workflows, suggested keys and slug matches; audited", async () => {
    await clearDrafts();
    const pkg = await exportAll();
    const preview = await transfer().preview(admin.principal, { packageText: JSON.stringify(pkg) });
    expect(preview.blocking).toEqual([]);
    const intake = preview.workflows.find((workflow) => workflow.key === "intake")!;
    expect(intake).toMatchObject({ valid: true, unpublished: false, existing: { name: "Synthetic intake", hasDraft: false }, suggestedKey: "intake_2" });
    expect(preview.references.policies).toEqual([
      { ref: "policy_1", slug: "terms", title: "Synthetic terms", audience: "customer", usedBy: ["intake"], resolution: { status: "matched", localPolicyPublicId: POLICY_TERMS, title: "Synthetic terms" } },
    ]);
    const event = h.audit.events.filter((e) => e.eventName === "workflow.import_previewed").at(-1)!;
    expect(event).toMatchObject({ outcome: "completed", attributes: { digest: preview.digest, digest_matches: true }, safeCounts: { workflows: 2, valid: 2, blocking: 0 } });
  });

  it("apply creates drafts only (create = unique key, draft = draft of the existing workflow); nothing is published", async () => {
    await clearDrafts();
    const pkg = await exportAll();
    const before = await counts();
    const key = idem();
    const input = { packageText: JSON.stringify(pkg), idempotencyKey: key, decisions: [{ key: "intake", action: "create" as const }, { key: "standard", action: "draft" as const }], policyMappings: [] };
    const result = await transfer().applyImport(admin.principal, input);
    expect(result.replayed).toBe(false);
    expect(result.results).toEqual([
      { key: "intake", action: "create", workflowKey: "intake_2", draftPublicId: expect.any(String) },
      { key: "standard", action: "draft", workflowKey: "standard", draftPublicId: expect.any(String) },
    ]);
    const after = await counts();
    expect(after).toEqual({ ...before, drafts: before.drafts + 2 });
    const created = await mod.workflows.getDraft(result.results[0]!.draftPublicId!);
    expect(created).toMatchObject({ workflowPublicId: null, workflowKey: "intake_2", name: "Synthetic intake" });
    expect(created.definition.acceptanceGates?.[0]?.policyPublicId).toBe(POLICY_TERMS);
    const drafted = await mod.workflows.getDraft(result.results[1]!.draftPublicId!);
    expect(drafted.workflowPublicId).not.toBeNull();
    const event = h.audit.events.filter((e) => e.eventName === "workflow.imported").at(-1)!;
    expect(event).toMatchObject({ resource: { type: "order_workflow_import", publicId: result.importPublicId }, attributes: { digest: pkg.integrity.digest, outcome: "intake:create=intake_2,standard:draft" }, safeCounts: { created: 1, drafted: 1, skipped: 0 } });

    // Replay with the same key and request: one effect. Same key, different choices: refused.
    const replay = await transfer().applyImport(admin.principal, { ...input, decisions: [...input.decisions].reverse() });
    expect(replay).toEqual({ ...result, replayed: true });
    expect((await counts()).drafts).toBe(after.drafts);
    // Same key and content but a tampered declared digest: the wrong digest blocks even a replay.
    const tampered = { ...pkg, integrity: { ...pkg.integrity, digest: "0".repeat(64) } };
    await expectError(transfer().applyImport(admin.principal, { ...input, packageText: JSON.stringify(tampered) }), "VALIDATION:PACKAGE_BLOCKED");
    await expectError(transfer().applyImport(admin.principal, { ...input, decisions: [{ key: "intake", action: "skip" }, { key: "standard", action: "skip" }] }), "CONFLICT:IDEMPOTENCY_KEY_REUSED");

    // The existing workflow now has a draft: "draft" is refused, nothing written.
    await expectError(transfer().applyImport(admin.principal, { ...input, idempotencyKey: idem(), decisions: [{ key: "intake", action: "skip" }, { key: "standard", action: "draft" }] }), "CONFLICT:WORKFLOW_DRAFT_EXISTS");
    expect((await counts()).drafts).toBe(after.drafts);
  });

  it("every workflow needs a decision; draft needs an existing workflow", async () => {
    await clearDrafts();
    const pkg = await exportAll();
    const text = JSON.stringify(pkg);
    await expectError(transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: [{ key: "intake", action: "skip" }], policyMappings: [] }), "VALIDATION:DECISIONS_INCOMPLETE");
    pkg.workflows[0]!.key = "brand_new";
    await expectError(
      transfer().applyImport(admin.principal, { packageText: seal(pkg), idempotencyKey: idem(), decisions: [{ key: "brand_new", action: "draft" }, { key: "standard", action: "skip" }], policyMappings: [] }),
      "VALIDATION:IMPORT_NO_EXISTING_WORKFLOW",
    );
  });
});

describe("workflow transfer: import abuse cases (§4)", () => {
  const structural = async (text: string, expected: string) => {
    await expectError(transfer().preview(admin.principal, { packageText: text }), expected);
    await expectError(transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: [], policyMappings: [] }), expected);
  };

  it("oversized, deeply nested, not JSON, wrong format version", async () => {
    await structural(`"${"x".repeat(2 * 1024 * 1024)}"`, "VALIDATION:PACKAGE_TOO_LARGE");
    // Multi-byte text: the limit is in UTF-8 bytes, not characters.
    await structural(`"${"é".repeat(1024 * 1024 + 1)}"`, "VALIDATION:PACKAGE_TOO_LARGE");
    await structural(`${"[".repeat(40)}${"]".repeat(40)}`, "VALIDATION:PACKAGE_TOO_DEEP");
    await structural("{not json", "VALIDATION:PACKAGE_NOT_JSON");
    // Very wide but shallow and under 2 MiB: refused as too large, never a RangeError (500).
    await structural(`[${"0,".repeat(600_000)}0]`, "VALIDATION:PACKAGE_TOO_LARGE");
    await structural(`{${Array.from({ length: 210_000 }, (_, i) => `"${i.toString(36)}":0`).join(",")}}`, "VALIDATION:PACKAGE_TOO_LARGE");
    const pkg = await exportAll();
    await structural(JSON.stringify({ ...pkg, formatVersion: 2 }), "VALIDATION:PACKAGE_FORMAT_UNSUPPORTED");
    await structural(JSON.stringify({ ...pkg, format: "something.else" }), "VALIDATION:PACKAGE_FORMAT_UNSUPPORTED");
  });

  it("__proto__ / constructor / prototype keys and unknown keys are refused", async () => {
    const text = JSON.stringify(await exportAll());
    await structural(text.replace('"format"', '"__proto__":{"polluted":true},"format"'), "VALIDATION:PACKAGE_FORBIDDEN_KEY");
    await structural(text.replace('"states":[{', '"states":[{"constructor":{"prototype":{}},'), "VALIDATION:PACKAGE_FORBIDDEN_KEY");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const pkg = await exportAll();
    pkg.workflows[0]!.extra = "unexpected";
    await structural(seal(pkg), "VALIDATION:PACKAGE_INVALID");
    const pkg2 = await exportAll();
    (pkg2.workflows[0]!.definition as Record<string, unknown>).script = "alert(1)";
    await structural(seal(pkg2), "VALIDATION:PACKAGE_INVALID");
  });

  it("wrong digest blocks preview and apply; no 'import anyway'", async () => {
    const pkg = await exportAll();
    pkg.workflows[0]!.name = "Edited by hand";
    const text = JSON.stringify(pkg);
    const preview = await transfer().preview(admin.principal, { packageText: text });
    expect(preview.blocking.map((entry) => entry.code)).toEqual(["DIGEST_MISMATCH"]);
    expect(h.audit.events.filter((e) => e.eventName === "workflow.import_previewed").at(-1)).toMatchObject({ outcome: "denied", reasonCode: "DIGEST_MISMATCH", attributes: { digest_matches: false } });
    await expectError(
      transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: pkg.workflows.map((workflow) => ({ key: String(workflow.key), action: "skip" as const })), policyMappings: [] }),
      "VALIDATION:PACKAGE_BLOCKED",
    );
  });

  it("duplicate workflow keys and 51 workflows are blocking", async () => {
    const pkg = await exportAll();
    pkg.workflows.push(structuredClone(pkg.workflows[0]!));
    expect((await transfer().preview(admin.principal, { packageText: seal(pkg) })).blocking.map((entry) => entry.code)).toEqual(["DUPLICATE_WORKFLOW_KEY"]);
    const many = await exportAll();
    const template = many.workflows.find((workflow) => workflow.key === "standard")!;
    many.workflows = Array.from({ length: 51 }, (_, index) => ({ ...structuredClone(template), key: `bulk_${index + 1}` }));
    const preview = await transfer().preview(admin.principal, { packageText: seal(many) });
    expect(preview.blocking.map((entry) => entry.code)).toEqual(["TOO_MANY_WORKFLOWS"]);
    expect(preview.workflows).toHaveLength(50);
    const bad = await exportAll();
    bad.workflows[0]!.key = "Bad-Key";
    expect((await transfer().preview(admin.principal, { packageText: seal(bad) })).blocking.map((entry) => entry.code)).toEqual(["WORKFLOW_KEY_INVALID"]);
  });

  it("HTML or script in names makes the workflow invalid: it can only be skipped", async () => {
    await clearDrafts();
    const pkg = await exportAll();
    const standard = pkg.workflows.find((workflow) => workflow.key === "standard")!;
    standard.name = "<script>alert(1)</script>";
    ((standard.definition as { states: { label: string }[] }).states[0]!).label = "<img src=x onerror=alert(1)>";
    const text = seal(pkg);
    const preview = await transfer().preview(admin.principal, { packageText: text });
    const row = preview.workflows.find((workflow) => workflow.key === "standard")!;
    expect(row.valid).toBe(false);
    expect(row.findings.filter((finding) => finding.code === "TEXT_MARKUP").map((finding) => finding.path)).toEqual(["name", "definition.states.0.label"]);
    await expectError(
      transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: [{ key: "intake", action: "skip" }, { key: "standard", action: "create" }], policyMappings: [] }),
      "VALIDATION:WORKFLOW_INVALID",
    );
    const skipped = await transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: [{ key: "intake", action: "create" }, { key: "standard", action: "skip" }], policyMappings: [] });
    expect(skipped.results.find((result) => result.key === "standard")).toEqual({ key: "standard", action: "skip", workflowKey: null, draftPublicId: null });
  });

  it("references: unknown refs are invalid; unmatched slugs need a mapping to a published customer policy or explicit gate removal", async () => {
    await clearDrafts();
    const unknownRef = await exportAll();
    ((unknownRef.workflows[0]!.definition as { acceptanceGates: { policyRef: string }[] }).acceptanceGates[0]!).policyRef = "policy_9";
    const unknownPreview = await transfer().preview(admin.principal, { packageText: seal(unknownRef) });
    expect(unknownPreview.workflows[0]).toMatchObject({ key: "intake", valid: false });
    expect(unknownPreview.workflows[0]!.findings.map((finding) => finding.code)).toContain("GATE_REFERENCE_UNKNOWN");

    const pkg = await exportAll();
    pkg.references.policies[0]!.slug = "missing-on-target";
    const text = seal(pkg);
    const preview = await transfer().preview(admin.principal, { packageText: text });
    expect(preview.references.policies[0]).toMatchObject({ ref: "policy_1", usedBy: ["intake"], resolution: { status: "not_found" } });
    expect(preview.workflows[0]!.valid).toBe(true);
    const decisions = [{ key: "intake", action: "create" as const }, { key: "standard", action: "skip" as const }];
    const apply = (policyMappings: { ref: string; localPolicyPublicId?: string; removeGates?: true }[]) => transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions, policyMappings });
    await expectError(apply([]), "VALIDATION:POLICY_MAPPING_REQUIRED");
    await expectError(apply([{ ref: "policy_1", localPolicyPublicId: POLICY_STAFF }]), "VALIDATION:POLICY_MAPPING_INVALID");
    await expectError(apply([{ ref: "policy_1", localPolicyPublicId: `01JD${"0".repeat(19)}T99` }]), "VALIDATION:POLICY_MAPPING_INVALID");
    await expectError(apply([{ ref: "policy_7", removeGates: true }]), "VALIDATION:POLICY_MAPPING_UNKNOWN_REF");
    // Skipping every workflow that uses the reference needs no mapping.
    const none = await transfer().applyImport(admin.principal, { packageText: text, idempotencyKey: idem(), decisions: [{ key: "intake", action: "skip" }, { key: "standard", action: "skip" }], policyMappings: [] });
    expect(none.results.every((result) => result.action === "skip")).toBe(true);

    const mapped = await apply([{ ref: "policy_1", localPolicyPublicId: POLICY_OTHER }]);
    const mappedDraft = await mod.workflows.getDraft(mapped.results[0]!.draftPublicId!);
    expect(mappedDraft.definition.acceptanceGates?.map((gate) => gate.policyPublicId)).toEqual([POLICY_OTHER]);
    const removed = await apply([{ ref: "policy_1", removeGates: true }]);
    const removedDraft = await mod.workflows.getDraft(removed.results[0]!.draftPublicId!);
    expect(removedDraft.definition.acceptanceGates ?? []).toEqual([]);
    expect(h.audit.events.filter((e) => e.eventName === "workflow.imported").at(-1)).toMatchObject({ attributes: { gates_removed: true } });
  });
});
