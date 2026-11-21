import { sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { registerMailTemplateAutomationAction } from "./automationAction.js";
import { mailTemplates } from "./schema.js";
import {
  createMailTemplatesService,
  type AutomationTemplateOptionView,
  type MailTemplateDetailView,
  type MailTemplatePreviewResult,
  type MailTemplateSummaryView,
  type MailTemplateVersionView,
} from "./service.js";
import { registerAdditionalShippedMailTemplates } from "./systemCatalogue.js";

// Ensure static registration is available at module load for any container
registerMailTemplateAutomationAction();

export type MailTemplatesModule = ModuleLifecycle & ReturnType<typeof createMailTemplatesService>;

export type {
  AutomationTemplateOptionView,
  MailTemplateDetailView,
  MailTemplatePreviewResult,
  MailTemplateSummaryView,
  MailTemplateVersionView,
};

export function createMailTemplatesModule(deps: ModuleDeps): MailTemplatesModule {
  const svc = createMailTemplatesService(deps);

  return {
    ...svc,
    init() {
      const existingKeys = new Set(
        deps.services.jobAdmin.getBuiltinMailTemplates().map((t) => t.key),
      );
      registerAdditionalShippedMailTemplates(deps.mailer, existingKeys);
      deps.services.jobAdmin.registerMailTemplateStore(svc.store);
      registerMailTemplateAutomationAction();
    },
    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const rows = await deps.db.select({ ok: sql<number>`1` }).from(mailTemplates).limit(1);
        return [
          {
            component: "mailTemplates",
            state: "ok",
            summary: "E-mail template catalogue and version store healthy.",
            metrics: { reachable: rows.length >= 0 ? 1 : 0 },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "mailTemplates",
            state: "failing",
            summary: "E-mail template store health query failed.",
            checkedAt,
          },
        ];
      }
    },
  };
}
