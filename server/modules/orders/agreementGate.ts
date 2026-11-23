/**
 * Increment 06 (D14) — administration of the order agreement (MNDA) setting `orders.agreement_gate`.
 *
 * The admin card ("Order agreement (MNDA)", compliance_engineer) calls `get` / `update`. Rules:
 *  - admin role + `policies.manage`, re-checked in-tx from persisted state (actorCheck; step-up per capability);
 *  - it cannot be enabled without a PUBLISHED policy whose audience is all/customer (AGREEMENT_POLICY_INVALID);
 *  - every change is audited (`order.agreement_gate.updated`, plus the settings store's own change event);
 *  - stored values parse with defaults and never throw (`parseAgreementGate`).
 * Customers read their own state through `status` (display only; every write re-checks on the gateway).
 */
import { DomainError, validation } from "../../core/errors.js";
import type { AuditEmitter, Db, SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { ActorCheck } from "./actor.js";
import type { AgreementRequirement, OrderGatesService } from "./gates.js";
import { AGREEMENT_GATE_DEFAULT, ORDER_AGREEMENT_GATE, agreementGateSchema, parseAgreementGate, type AgreementGateSetting } from "./settings.js";

export interface AgreementGateDeps {
  db: Db;
  audit: AuditEmitter;
  settings: SettingsStore;
  services: Services;
  actorCheck: ActorCheck;
  gates: Pick<OrderGatesService, "agreementFor">;
}

export interface AgreementGateView extends AgreementGateSetting {
  policy: { publicId: string; title: string; versionLabel: string } | null;
  /** Published policies the card may offer (audience all/customer). Empty when compliance is absent. */
  choices: { publicId: string; title: string; versionLabel: string }[];
}

interface PolicyChoice {
  documentPublicId: string;
  title: string;
  audience: string;
  versionLabel: string;
}

const AUDIENCES = new Set(["all", "customer"]);

export function createAgreementGateService(deps: AgreementGateDeps) {
  /** Outside any tx: compliance reads on its own connection (see workflowTransferService.localPolicies). */
  async function choices(): Promise<PolicyChoice[]> {
    const compliance = (deps.services as Partial<Services>).compliance as { listPublishedPolicies?: () => Promise<PolicyChoice[]> } | undefined;
    if (typeof compliance?.listPublishedPolicies !== "function") return [];
    return (await compliance.listPublishedPolicies()).filter((policy) => AUDIENCES.has(policy.audience));
  }

  async function read(tx?: Tx): Promise<AgreementGateSetting> {
    return deps.settings.get(ORDER_AGREEMENT_GATE.key, parseAgreementGate, parseAgreementGate(undefined), tx);
  }

  async function guard(principal: SessionPrincipal, tx: Tx) {
    const current = await deps.actorCheck(principal, tx, "policies.manage");
    if (current.role !== "admin") throw new DomainError("FORBIDDEN", "ACTOR_NOT_AUTHORIZED", "You do not have permission to perform this action.");
  }

  const view = (setting: AgreementGateSetting, list: PolicyChoice[]): AgreementGateView => {
    const found = list.find((policy) => policy.documentPublicId === setting.policyPublicId);
    return {
      ...setting,
      policy: found ? { publicId: found.documentPublicId, title: found.title.slice(0, 200), versionLabel: found.versionLabel.slice(0, 40) } : null,
      choices: list.map((policy) => ({ publicId: policy.documentPublicId, title: policy.title.slice(0, 200), versionLabel: policy.versionLabel.slice(0, 40) })),
    };
  };

  return {
    async get(principal: SessionPrincipal): Promise<AgreementGateView> {
      const list = await choices();
      const setting = await deps.db.transaction(async (tx) => {
        await guard(principal, tx);
        return read(tx);
      });
      return view(setting, list);
    },

    async update(principal: SessionPrincipal, input: { setting: AgreementGateSetting; expectedEnabled?: boolean }): Promise<AgreementGateView> {
      const parsed = agreementGateSchema.safeParse(input.setting);
      if (!parsed.success) throw validation("AGREEMENT_SETTING_INVALID", "Choose a published policy before turning the agreement on.", { fields: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "_") });
      const next = parsed.data;
      const list = await choices();
      if (next.policyPublicId !== null && !list.some((policy) => policy.documentPublicId === next.policyPublicId))
        throw validation("AGREEMENT_POLICY_INVALID", "Choose a published policy for customers (or everyone) from the Policies page.", { field: "policyPublicId" });
      const saved = await deps.db.transaction(async (tx) => {
        await guard(principal, tx);
        const before = await read(tx);
        if (input.expectedEnabled !== undefined && input.expectedEnabled !== before.enabled)
          throw new DomainError("CONFLICT", "AGREEMENT_SETTING_CHANGED", "Someone else changed this setting. Reload to see the current value.");
        await deps.settings.set(ORDER_AGREEMENT_GATE.key, next, tx);
        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.agreement_gate.updated",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "platform_setting" },
            attributes: {
              setting_key: ORDER_AGREEMENT_GATE.key,
              enabled_from: String(before.enabled),
              enabled_to: String(next.enabled),
              policy_from: before.policyPublicId ?? "none",
              policy_public_id: next.policyPublicId ?? "none",
              apply_place_order: String(next.applyTo.placeOrder),
              apply_work_on_order: String(next.applyTo.workOnOrder),
              signature_mode: next.signatureMode,
              ask_again_on_new_version: String(next.askAgainOnNewVersion),
            },
          },
          tx,
        );
        return next;
      });
      return view(saved, list);
    },

    /** The signed-in user's own state (display only). */
    async status(principal: SessionPrincipal, input: { scope: "placeOrder" | "workOnOrder" }): Promise<AgreementRequirement> {
      return deps.gates.agreementFor({ actor: principal, scope: input.scope });
    },

    defaults: (): AgreementGateSetting => ({ ...AGREEMENT_GATE_DEFAULT, applyTo: { ...AGREEMENT_GATE_DEFAULT.applyTo } }),
  };
}

export type AgreementGateService = ReturnType<typeof createAgreementGateService>;
