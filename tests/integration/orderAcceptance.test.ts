import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderPolicyAcceptances } from "../../server/modules/compliance/acceptanceSchema.js";
import { exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import { isPlatformSettingsStore } from "../../server/modules/platform/settingsStore.js";
import {
  Browser, HOST, bootstrapAdmin, createSystem, registerCustomer, seedProduct, stepUp,
  type ReadyAdmin, type ReadyCustomer, type System, type TrpcResult,
} from "./harness.js";

const workflowDrafts = "orders.admin.workflows.drafts";
const policyAdmin = "compliance.policies.admin";
const intakeAdmin = "compliance.intake.admin";
const gateKey = "confirm_project_terms";
const bodyText = "Please confirm the attached synthetic project terms.";
const blocked = { domainCode: "CONFLICT", reasonCode: "ORDER_ACCEPTANCE_REQUIRED" };

let sys: System;
let admin: ReadyAdmin;
let owner: ReadyCustomer;
let contributor: ReadyCustomer;
let productPublicId: string;
let questionnairePublicId: string;
let policyVersionId: string;
let documentPublicId: string;
let textSha256: string;
let apiToken: string;

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  const { settings } = sys.container.services;
  if (!isPlatformSettingsStore(settings)) throw new Error("Expected the assembled settings store");
  await settings.set("orders.workflow_rules.enabled", true);
  await settings.set("files.audio_conversion", { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true });
  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));

  const policy = Browser.ok(await admin.browser.mutate<{
    documentPublicId: string; draftVersionPublicId: string; contentHash: string;
  }>(`${policyAdmin}.createDocument`, {
    slug: "synthetic-project-terms", title: "Synthetic project terms", audience: "customer",
    requiresAcceptance: false, requiresTypedSignature: false, versionLabel: "1.0",
    contentFormat: "safe_markdown", bodyText,
  }));
  Browser.ok(await admin.browser.mutate(`${policyAdmin}.publishVersion`, { versionPublicId: policy.draftVersionPublicId }));
  policyVersionId = policy.draftVersionPublicId;
  documentPublicId = policy.documentPublicId;
  textSha256 = policy.contentHash;

  const questionnaire = Browser.ok(await admin.browser.mutate<{
    questionnairePublicId: string; draftVersionPublicId: string;
  }>(`${intakeAdmin}.createQuestionnaire`, {
    slug: "synthetic-project-intake", title: "Synthetic project intake",
    scopeKind: "default", fields: [{ key: "summary", label: "Summary", type: "short_text", required: true, sensitive: false }],
  }));
  Browser.ok(await admin.browser.mutate(`${intakeAdmin}.publishVersion`, { versionPublicId: questionnaire.draftVersionPublicId }));
  questionnairePublicId = questionnaire.questionnairePublicId;

  const name = "Synthetic acceptance workflow";
  const { publicId } = Browser.ok(await admin.browser.mutate<{ publicId: string }>(`${workflowDrafts}.create`,
    { from: "blank", workflowKey: "acceptance_fixture", name }));
  Browser.ok(await admin.browser.mutate(`${workflowDrafts}.save`, {
    draftId: publicId, expectedVersion: 1, name,
    definition: {
      phases: [{ key: "intake", label: "Intake" }],
      states: [
        {
          key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info", phase: "intake",
          requirements: {
            uploads: [{ key: "voice_evidence", label: "Voice evidence", kind: "audio", minCount: 0, maxCount: 4, allowedTypes: ["wav"], uploadedBy: ["customer"] }],
            acknowledgements: [],
          },
        },
        { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
        { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
      ],
      transitions: [
        { from: "submitted", to: "completed", allowedBy: ["customer", "staff", "admin", "api"], notifyCustomer: false, requiresNote: false },
        { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin", "api"], notifyCustomer: false, requiresNote: false },
      ],
      acceptanceGates: [{
        key: gateKey, policyPublicId: policy.documentPublicId,
        point: "order_start", signatureMode: "typed_name", askAgainOnNewVersion: true,
      }],
    },
  }));
  Browser.ok(await admin.browser.mutate(`${workflowDrafts}.publish`, { draftId: publicId, expectedVersion: 2, makeDefault: true }));
  productPublicId = await seedProduct(admin);

  const { version } = Browser.ok(await admin.browser.query<{ version: number }>("publicApi.admin.settings.get"));
  Browser.ok(await admin.browser.mutate("publicApi.admin.settings.update", { expectedVersion: version, enabled: true, retentionDays: 7 }));
  ({ token: apiToken } = Browser.ok(await admin.browser.mutate<{ token: string }>("publicApi.admin.keys.create", {
    name: "Synthetic acceptance fixture", scopes: ["orders:write"], expiresAt: null,
    ipAllowList: [], rateLimitPerMinute: 100, requireSigning: false,
  })));

  owner = await registerCustomer(sys, "acceptance.owner@example.test", "Acceptance Owner");
  contributor = await registerCustomer(sys, "acceptance.contributor@example.test", "Acceptance Contributor");
}, 120_000);

afterAll(async () => sys?.close());

async function createOrder(label: string) {
  const { publicId } = Browser.ok(await owner.browser.mutate<{ publicId: string }>("orders.create", {
    items: [{ productPublicId, quantity: 1 }], projectName: `Synthetic acceptance: ${label}`, idempotencyKey: `acceptance-fixture-${label}`,
  }));
  const { version } = Browser.ok(await owner.browser.query<{ version: number }>("orders.get", { orderId: publicId }));
  return { publicId, version };
}

function signatures(customer: ReadyCustomer, orderId: string, typedName: string) {
  return customer.browser.mutate("compliance.acceptance.accept", { orderId, gateKey, policyVersionId, textSha256, typedName });
}

function expectBlocked(result: TrpcResult) {
  expect(result.status).toBe(409);
  expect(result.error?.safe).toMatchObject(blocked);
}

const uploadKinds = {
  default: "",
  slot: "?statusKey=submitted&slotKey=voice_evidence",
  recording: "?statusKey=submitted&slotKey=voice_evidence&source=recording",
};

function upload(browser: Browser, orderId: string, kind: keyof typeof uploadKinds) {
  return browser.raw("post", `/api/files/upload/${orderId}${uploadKinds[kind]}`).attach("files", exampleWav(8000), `${kind}.wav`);
}

async function shareOrder(orderId: string, role: "viewer" | "contributor") {
  const grant = Browser.ok(await owner.browser.mutate<{ publicId: string }>("orders.sharing.invite", {
    orderId, email: contributor.email, role,
  }));
  Browser.ok(await contributor.browser.mutate("orders.sharing.respond", { grantId: grant.publicId, accept: true }));
  return grant.publicId;
}

describe("Order acceptance on assembled customer write paths", () => {
  it("gates default uploads, uploads into workflow slots, and recordings before any file is listed", async () => {
    const { publicId: orderId } = await createOrder("uploads");
    const listFiles = async () => Browser.ok(await owner.browser.query("files.list", { orderId }));
    const empty = await listFiles();
    for (const kind of Object.keys(uploadKinds) as (keyof typeof uploadKinds)[]) {
      const refused = await upload(owner.browser, orderId, kind);
      expect(refused.status, kind).toBe(409);
      expect(refused.body.safe, kind).toMatchObject(blocked);
    }
    expect(await listFiles()).toEqual(empty);
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    for (const kind of Object.keys(uploadKinds) as (keyof typeof uploadKinds)[]) {
      const allowed = await upload(owner.browser, orderId, kind);
      expect(allowed.status, kind).toBe(200);
      expect(allowed.body.results, kind).toEqual([expect.objectContaining({ outcome: "completed" })]);
    }
  });

  it.each(["saveDraft", "submit"] as const)("gates intake %s without changing the visible submissions", async (action) => {
    const { publicId: orderId } = await createOrder(`intake-${action}`);
    const ids = { orderPublicId: orderId, questionnairePublicId };
    const input = { ...ids, answers: { summary: "A synthetic answer." } };
    const read = async () => Browser.ok(await owner.browser.query("compliance.intake.getSubmission", ids));
    const initial = await read();
    expectBlocked(await owner.browser.mutate(`compliance.intake.${action}`, input));
    expect(await read()).toEqual(initial);
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    Browser.ok(await owner.browser.mutate(`compliance.intake.${action}`, input));
    expect(await read()).not.toEqual(initial);
  });

  it("requires the contributor's own acceptance even if the order owner already signed", async () => {
    const { publicId: orderId } = await createOrder("contributor");
    const grantId = await shareOrder(orderId, "contributor");
    Browser.ok(await contributor.browser.query("orders.get", { orderId }));
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    const refused = await upload(contributor.browser, orderId, "default");
    expect(refused.status).toBe(409);
    expect(refused.body.safe).toMatchObject(blocked);
    Browser.ok(await signatures(contributor, orderId, "Acceptance Contributor"));
    const allowed = await upload(contributor.browser, orderId, "default");
    expect(allowed.status).toBe(200);
    expect(allowed.body.results).toEqual([expect.objectContaining({ outcome: "completed" })]);
    Browser.ok(await owner.browser.mutate("orders.sharing.revoke", { orderId, grantId }));
    const revoked = await upload(contributor.browser, orderId, "default");
    expect(revoked.status).toBe(404);
    expect(revoked.body.safe.domainCode).toBe("NOT_FOUND");
  });

  it("does not grant write access when a viewer accepts a policy", async () => {
    const { publicId: orderId } = await createOrder("viewer");
    await shareOrder(orderId, "viewer");
    Browser.ok(await signatures(contributor, orderId, "Acceptance Contributor"));
    const refused = await upload(contributor.browser, orderId, "default");
    expect(refused.status).toBe(403);
    expect(refused.body.safe).toMatchObject({ domainCode: "FORBIDDEN", reasonCode: "GRANT_READ_ONLY" });
  });

  it("requires owner acceptance before the customer portal can submit a phase", async () => {
    const { publicId: orderId, version: expectedVersion } = await createOrder("portal-transition");
    const input = { orderId, expectedVersion, toStatus: "completed" };
    expectBlocked(await owner.browser.mutate("orders.transition", input));
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    Browser.ok(await owner.browser.mutate("orders.transition", input));
  });

  it("stores only one immutable receipt for the displayed text, scoped to the order and signer", async () => {
    const { publicId: orderId } = await createOrder("proof");
    const { publicId: secondOrderId } = await createOrder("still-blocked");
    const addr = "203.0.113.248";
    // The pre-existing general policy acceptance procedure is not order-gate evidence.
    Browser.ok(await owner.browser.mutate("compliance.policies.accept", {
      orderPublicId: orderId, versionPublicId: policyVersionId, contentHash: textSha256,
    }));
    const view = Browser.ok(await owner.browser.query<{
      blocking: boolean; gates: { key: string; policy: { text: string; textSha256: string; versionId: string } }[];
    }>("compliance.acceptance.forOrder", { orderId }));
    expect(view.blocking).toBe(true);
    const [gate] = view.gates;
    expect(gate).toMatchObject({ key: gateKey, policy: { text: bodyText, versionId: policyVersionId, textSha256 } });
    expect(createHash("sha256").update(gate!.policy.text, "utf8").digest("hex")).toBe(textSha256);
    const changed = await owner.browser.mutate("compliance.acceptance.accept", {
      orderId, gateKey, policyVersionId, textSha256: "0".repeat(64), typedName: "Acceptance Owner",
    });
    expect(changed.status).toBe(409);
    expect(changed.error?.safe.reasonCode).toBe("POLICY_TEXT_CHANGED");
    const sign = () => owner.browser.mutate<{ duplicate: boolean; receipt: { receiptId: string } }>("compliance.acceptance.accept", {
      orderId, gateKey, policyVersionId, textSha256, typedName: "Acceptance Owner",
    }, { address: addr });
    const [firstResult, repeatResult] = await Promise.all([sign(), sign()]);
    const first = Browser.ok(firstResult);
    const repeat = Browser.ok(repeatResult);
    expect([first.duplicate, repeat.duplicate].sort()).toEqual([false, true]);
    expect(first.receipt).toEqual(repeat.receipt);
    const { receiptId } = first.receipt;
    const [row] = await sys.t.db.select().from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.publicId, receiptId));
    expect(row).toMatchObject({ orderPublicId: orderId, textSha256, signatureMode: "typed_name" });
    expect(row?.sourceAddressEnc).toBeTruthy();
    expect(row?.sourceAddressEnc).not.toContain(addr);
    expect(row?.typedNameEnc).not.toContain("Acceptance Owner");
    const receipt = Browser.ok(await owner.browser.query("compliance.acceptance.receipt", { receiptId }));
    expect(JSON.stringify(receipt)).not.toContain(addr);
    expect(JSON.stringify(receipt)).not.toContain("sourceAddress");
    const hidden = await contributor.browser.query("compliance.acceptance.receipt", { receiptId });
    expect(hidden.status).toBe(404);
    expect(hidden.error?.safe).toMatchObject({ domainCode: "NOT_FOUND", reasonCode: "RECEIPT_NOT_FOUND" });
    const second = Browser.ok(await owner.browser.query("compliance.acceptance.forOrder", { orderId: secondOrderId }));
    expect(second).toMatchObject({ blocking: true, gates: [expect.objectContaining({ acceptance: null })] });
  });

  it("requires owner acceptance for an API v1 transition the workflow allows", async () => {
    const { publicId: orderId, version: expectedVersion } = await createOrder("api-transition");
    const submit = (idempotencyKey: string) => sys.http.post(`/api/v1/orders/${orderId}/transitions`)
      .set("Host", HOST).set("Authorization", `Bearer ${apiToken}`).set("Idempotency-Key", idempotencyKey)
      .send({ expectedVersion, toStatusKey: "completed" });
    const refused = await submit("synthetic-before-owner-signature");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "ORDER_ACCEPTANCE_REQUIRED" });
    await shareOrder(orderId, "contributor");
    Browser.ok(await signatures(contributor, orderId, "Acceptance Contributor"));
    const collaboratorOnly = await submit("synthetic-after-collaborator-signature");
    expect(collaboratorOnly.status).toBe(409);
    expect(collaboratorOnly.body).toMatchObject({ code: "ORDER_ACCEPTANCE_REQUIRED" });
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    const allowed = await submit("synthetic-after-owner-signature");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ data: { status: { key: "completed" }, version: expectedVersion + 1 } });
  });

  it("does not require acceptance for an allowed cancellation in the portal or via API v1", async () => {
    const portal = await createOrder("cancel-portal");
    const api = await createOrder("cancel-api");
    const readGate = (orderId: string) => owner.browser.query("compliance.acceptance.forOrder", { orderId });
    expect(Browser.ok(await readGate(portal.publicId))).toMatchObject({ blocking: true });
    expect(Browser.ok(await readGate(api.publicId))).toMatchObject({ blocking: true });
    Browser.ok(await owner.browser.mutate("orders.transition", {
      orderId: portal.publicId, expectedVersion: portal.version, toStatus: "canceled",
    }));
    const result = await sys.http.post(`/api/v1/orders/${api.publicId}/transitions`)
      .set("Host", HOST).set("Authorization", `Bearer ${apiToken}`).set("Idempotency-Key", "synthetic-cancel-before-signing")
      .send({ expectedVersion: api.version, toStatusKey: "canceled" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ data: { status: { key: "canceled" }, version: api.version + 1 } });
  });

  it("requires new evidence after policy publication and never serves policy text reclassified as staff-only", async () => {
    const { publicId: orderId } = await createOrder("policy-update");
    Browser.ok(await signatures(owner, orderId, "Acceptance Owner"));
    const read = async () => Browser.ok(await owner.browser.query("compliance.acceptance.forOrder", { orderId }));
    expect(await read()).toMatchObject({ blocking: false });

    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const updatedText = "Synthetic updated terms requiring a second acceptance.";
    const next = Browser.ok(await admin.browser.mutate<{ versionPublicId: string; contentHash: string }>(`${policyAdmin}.createDraftVersion`, {
      documentPublicId, versionLabel: "2.0", contentFormat: "plain_text", bodyText: updatedText,
    }));
    Browser.ok(await admin.browser.mutate(`${policyAdmin}.publishVersion`, { versionPublicId: next.versionPublicId }));
    expect(await read()).toMatchObject({
      blocking: true, gates: [expect.objectContaining({ acceptance: null, policy: expect.objectContaining({ text: updatedText }) })],
    });
    const stale = await signatures(owner, orderId, "Acceptance Owner");
    expect(stale.status).toBe(409);
    expect(stale.error?.safe.reasonCode).toBe("POLICY_TEXT_CHANGED");
    Browser.ok(await owner.browser.mutate("compliance.acceptance.accept", {
      orderId, gateKey, policyVersionId: next.versionPublicId, textSha256: next.contentHash, typedName: "Acceptance Owner",
    }));
    expect(await read()).toMatchObject({ blocking: false });
    const { document } = Browser.ok(await admin.browser.query<{ document: { version: number } }>(`${policyAdmin}.getDocument`, { documentPublicId }));
    Browser.ok(await admin.browser.mutate(`${policyAdmin}.updateDocument`, {
      documentPublicId, expectedVersion: document.version, title: "Synthetic project terms", audience: "staff",
      requiresAcceptance: false, requiresTypedSignature: false, active: true,
    }));
    const reclassified = await read();
    expect(reclassified).toMatchObject({ blocking: true, gates: [expect.objectContaining({ policy: null, acceptance: null })] });
    expect(JSON.stringify(reclassified)).not.toContain(updatedText);
  });

  it("applies a named gate on leaving its step and retains evidence when reacceptance is disabled", async () => {
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const policy = Browser.ok(await admin.browser.mutate<{
      documentPublicId: string; draftVersionPublicId: string; contentHash: string;
    }>(`${policyAdmin}.createDocument`, {
      slug: "synthetic-step-policy", title: "Synthetic step policy", audience: "customer", requiresAcceptance: false,
      requiresTypedSignature: false, versionLabel: "1.0", contentFormat: "plain_text", bodyText: "Synthetic policy for the review step.",
    }));
    Browser.ok(await admin.browser.mutate(`${policyAdmin}.publishVersion`, { versionPublicId: policy.draftVersionPublicId }));
    const name = "Synthetic named acceptance step";
    const { publicId: draftId } = Browser.ok(await admin.browser.mutate<{ publicId: string }>(`${workflowDrafts}.create`, {
      from: "blank", workflowKey: "named_acceptance_fixture", name,
    }));
    const edge = (from: string, to: string) => ({ from, to, allowedBy: ["customer", "admin"], notifyCustomer: false, requiresNote: false });
    Browser.ok(await admin.browser.mutate(`${workflowDrafts}.save`, {
      draftId, expectedVersion: 1, name,
      definition: {
        acceptanceGates: [{
          key: gateKey, policyPublicId: policy.documentPublicId, point: { stepKey: "review" },
          signatureMode: "checkbox", askAgainOnNewVersion: false,
        }],
        states: [
          { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info" },
          { key: "review", label: "Review", customerLabel: "Review", kind: "active", tone: "info" },
          { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
        ],
        transitions: [edge("submitted", "review"), edge("review", "completed")],
      },
    }));
    Browser.ok(await admin.browser.mutate(`${workflowDrafts}.publish`, { draftId, expectedVersion: 2, makeDefault: true }));

    const { publicId: orderId, version } = await createOrder("named-gate");
    const read = async () => Browser.ok(await owner.browser.query("compliance.acceptance.forOrder", { orderId }));
    expect(await read()).toMatchObject({ blocking: false, gates: [expect.objectContaining({ applies: false })] });
    const entered = Browser.ok(await owner.browser.mutate<{ version: number }>("orders.transition", { orderId, expectedVersion: version, toStatus: "review" }));
    expect(await read()).toMatchObject({ blocking: true, gates: [expect.objectContaining({ applies: true })] });
    const submit = { orderId, expectedVersion: entered.version, toStatus: "completed" };
    expectBlocked(await owner.browser.mutate("orders.transition", submit));
    Browser.ok(await owner.browser.mutate("compliance.acceptance.accept", {
      orderId, gateKey, policyVersionId: policy.draftVersionPublicId, textSha256: policy.contentHash,
    }));
    const latest = Browser.ok(await admin.browser.mutate<{ versionPublicId: string }>(`${policyAdmin}.createDraftVersion`, {
      documentPublicId: policy.documentPublicId, versionLabel: "2.0", contentFormat: "plain_text", bodyText: "Updated synthetic review policy.",
    }));
    Browser.ok(await admin.browser.mutate(`${policyAdmin}.publishVersion`, { versionPublicId: latest.versionPublicId }));
    expect(await read()).toMatchObject({
      blocking: false, gates: [expect.objectContaining({
        policy: expect.objectContaining({ versionId: latest.versionPublicId }),
        acceptance: expect.objectContaining({ versionNumber: 1 }),
      })],
    });
    Browser.ok(await owner.browser.mutate("orders.transition", submit));

    const staffControl = await createOrder("named-gate-staff");
    const reviewed = Browser.ok(await admin.browser.mutate<{ version: number }>("orders.transition", {
      orderId: staffControl.publicId, expectedVersion: staffControl.version, toStatus: "review",
    }));
    Browser.ok(await admin.browser.mutate("orders.transition", {
      orderId: staffControl.publicId, expectedVersion: reviewed.version, toStatus: "completed",
    }));
  });
});
