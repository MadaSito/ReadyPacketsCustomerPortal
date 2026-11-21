import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, OutboundMail, SessionPrincipal, Tx } from "../../core/types.js";
import type { MailTemplateStore, PublishedMailTemplate } from "../jobs/mailPorts.js";
import { assertLiveMailAdminInTx, runMailTemplatesTx } from "./actorAuth.js";
import {
  computeMailTemplateContentHash,
  extractTextPlaceholders,
  MAX_SUBJECT_LENGTH,
  MAX_TEMPLATE_VARS,
  parseAllowedTemplateUrl,
  plainTextToDeliveryHtml,
  projectInertMailPreviewHtml,
  renderMailTemplateVersion,
  sanitizeTemplateHtmlOnSave,
  substitutePlainText,
  validateSubjectTemplate,
  validateTextBodyTemplate,
  VAR_NAME_RE,
  wrapDeliveryHtmlDocument,
} from "./sanitizer.js";
import {
  mailTemplates,
  mailTemplateVersions,
  type MailTemplateCategory,
  type MailTemplateFormat,
  type MailTemplateKind,
  type MailTemplateVariableSpec,
  type MailTemplateVersionState,
} from "./schema.js";
import { buildSystemTemplateMetadata, type SystemMailTemplateMetadata } from "./systemCatalogue.js";

const VERIFY_AUDIT_KEY = "jobs.mail.verify_audit_copy";
const TEST_VERSION_PREFIX = "mail_templates.test_v.";
const TEST_DEFAULT_PREFIX = "mail_templates.test_default.";
const CUSTOM_KEY_RE = /^custom\.[a-z][a-z0-9_]{1,63}$/;

export interface MailTemplateSummaryView {
  publicId: string;
  templateKey: string;
  kind: MailTemplateKind;
  category: MailTemplateCategory;
  name: string;
  description: string;
  declaredVars: MailTemplateVariableSpec[];
  hasPublishedOverride: boolean;
  hasWorkingDraft: boolean;
  activeFormat: MailTemplateFormat;
  latestVersionNumber: number;
  version: number;
  updatedAt: Date;
}

export interface MailTemplateVersionView {
  publicId: string;
  versionNumber: number;
  state: MailTemplateVersionState;
  format: MailTemplateFormat;
  subject: string;
  /** Sanitized canonical HTML source for editing in `RichTextEditor` (never injected via `dangerouslySetInnerHTML`). */
  bodyHtml: string | null;
  bodyText: string;
  contentHash: string;
  changeNote: string;
  restoredFromVersionNumber: number | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailTemplateDetailView extends MailTemplateSummaryView {
  systemDefault: {
    format: MailTemplateFormat;
    subject: string;
    bodyHtml: string;
    bodyText: string;
  } | null;
  activePublished: MailTemplateVersionView | null;
  workingDraft: MailTemplateVersionView | null;
  versions: MailTemplateVersionView[];
}

export interface MailTemplatePreviewResult {
  subject: string;
  text: string;
  /** Preview-only projected HTML stripped of all links, images, and network/navigation attributes (`""` for plain text). */
  previewHtml: string;
}

export interface AutomationTemplateOptionView {
  templateKey: string;
  name: string;
  kind: MailTemplateKind;
  category: MailTemplateCategory;
  declaredVars: MailTemplateVariableSpec[];
}

function toVersionView(row: typeof mailTemplateVersions.$inferSelect): MailTemplateVersionView {
  return {
    publicId: row.publicId,
    versionNumber: row.versionNumber,
    state: row.state,
    format: row.format,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    contentHash: row.contentHash,
    changeNote: row.changeNote,
    restoredFromVersionNumber: row.restoredFromVersionNumber,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function withTestPrefix(subject: string): string {
  const prefixed = subject.startsWith("[TEST] ") ? subject : `[TEST] ${subject}`;
  return prefixed.length <= MAX_SUBJECT_LENGTH ? prefixed : prefixed.slice(0, MAX_SUBJECT_LENGTH).trim();
}

function normalizeDeclaredVarsInput(vars: readonly MailTemplateVariableSpec[]): MailTemplateVariableSpec[] {
  if (vars.length > MAX_TEMPLATE_VARS) {
    throw validation("TOO_MANY_TEMPLATE_VARIABLES", `Templates may declare at most ${MAX_TEMPLATE_VARS} variables.`);
  }
  const seen = new Set<string>();
  return vars.map((v) => {
    const name = v.name.trim();
    if (!VAR_NAME_RE.test(name)) {
      throw validation("INVALID_TEMPLATE_VARIABLE", `Invalid variable name "${name}".`);
    }
    if (seen.has(name)) {
      throw validation("DUPLICATE_TEMPLATE_VARIABLE", `Duplicate variable name "${name}".`);
    }
    seen.add(name);
    const label = v.label.normalize("NFC").trim().slice(0, 120) || name;
    const sampleValue = v.sampleValue.normalize("NFC").replace(/\0/g, "").slice(0, 500) || `Sample ${name}`;
    return {
      name,
      label,
      required: Boolean(v.required || v.sensitive),
      ...(v.sensitive ? { sensitive: true } : {}),
      sampleValue,
    };
  });
}

export function createMailTemplatesService(deps: ModuleDeps) {
  const getSystemCatalogueMap = (): Map<string, SystemMailTemplateMetadata> => {
    const builtins = deps.services.jobAdmin.getBuiltinMailTemplates();
    const map = new Map<string, SystemMailTemplateMetadata>();
    for (const b of builtins) {
      if (b.key === VERIFY_AUDIT_KEY) continue;
      map.set(b.key, buildSystemTemplateMetadata(b));
    }
    return map;
  };

  const ensureSystemTemplatesSynced = async (dbOrTx: DbOrTx): Promise<Map<string, SystemMailTemplateMetadata>> => {
    const catalogue = getSystemCatalogueMap();
    if (catalogue.size === 0) return catalogue;

    const existing = await dbOrTx
      .select({ id: mailTemplates.id, templateKey: mailTemplates.templateKey, declaredVarsJson: mailTemplates.declaredVarsJson })
      .from(mailTemplates)
      .where(eq(mailTemplates.kind, "system"));
    const existingKeys = new Set(existing.map((r) => r.templateKey));

    const now = deps.clock.now();
    for (const meta of catalogue.values()) {
      if (existingKeys.has(meta.templateKey)) continue;
      await dbOrTx
        .insert(mailTemplates)
        .values({
          publicId: ulid(now.getTime()),
          templateKey: meta.templateKey,
          kind: "system",
          category: meta.category,
          name: meta.name,
          description: meta.description,
          declaredVarsJson: meta.declaredVars,
          activePublishedVersionId: null,
          workingDraftVersionId: null,
          latestVersionNumber: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({ set: { id: sql`${mailTemplates.id}` } });
    }
    return catalogue;
  };

  const buildPublishedAdapter = (
    key: string,
    declaredVars: readonly MailTemplateVariableSpec[],
    versionRow: {
      format: MailTemplateFormat;
      subject: string;
      bodyHtml: string | null;
      bodyText: string;
    },
    options?: { prefixTestSubject?: boolean },
  ): PublishedMailTemplate => {
    const varNames = declaredVars.map((v) => v.name);
    const sensitiveVars = declaredVars.filter((v) => v.sensitive).map((v) => v.name);
    return {
      key,
      vars: varNames,
      ...(sensitiveVars.length > 0 ? { sensitiveVars } : {}),
      render(vars: OutboundMail["vars"]) {
        const rendered = renderMailTemplateVersion({
          format: versionRow.format,
          subjectTemplate: versionRow.subject,
          bodyHtmlTemplate: versionRow.bodyHtml,
          bodyTextTemplate: versionRow.bodyText,
          declaredVars: varNames,
          vars,
          canonicalOrigin: deps.config.canonicalOrigin,
        });
        return {
          subject: options?.prefixTestSubject ? withTestPrefix(rendered.subject) : rendered.subject,
          text: rendered.text,
          html: rendered.html,
        };
      },
    };
  };

  const store: MailTemplateStore = {
    async resolve(key: string, tx?: Tx): Promise<PublishedMailTemplate | null> {
      if (!key || key === VERIFY_AUDIT_KEY || key.startsWith("mail_templates.internal.")) {
        return null;
      }
      const dbOrTx: DbOrTx = tx ?? deps.db;

      // Internal test-send resolution for a specific draft/published version (`sendTestToMe` only)
      if (key.startsWith(TEST_VERSION_PREFIX)) {
        const rawUlid = key.slice(TEST_VERSION_PREFIX.length).toUpperCase();
        if (!/^[0-9A-Z]{26}$/.test(rawUlid)) return null;
        const [ver] = await dbOrTx
          .select()
          .from(mailTemplateVersions)
          .where(eq(mailTemplateVersions.publicId, rawUlid))
          .limit(1);
        if (!ver) return null;
        const [tpl] = await dbOrTx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.id, ver.templateId))
          .limit(1);
        if (!tpl) return null;
        return buildPublishedAdapter(key, tpl.declaredVarsJson, ver, { prefixTestSubject: true });
      }

      // Internal test-send resolution for a system template's un-customised built-in default (`sendTestToMe` only)
      if (key.startsWith(TEST_DEFAULT_PREFIX)) {
        const targetKey = key.slice(TEST_DEFAULT_PREFIX.length);
        const sysMeta = getSystemCatalogueMap().get(targetKey);
        if (!sysMeta) return null;
        const canonicalDefault = sanitizeTemplateHtmlOnSave(
          sysMeta.defaultBodyHtml,
          new Set(sysMeta.declaredVars.map((v) => v.name)),
        );
        return buildPublishedAdapter(
          key,
          sysMeta.declaredVars,
          {
            format: "html",
            subject: sysMeta.defaultSubject,
            bodyHtml: canonicalDefault.html,
            bodyText: sysMeta.defaultBodyText,
          },
          { prefixTestSubject: true },
        );
      }

      const [tpl] = await dbOrTx
        .select()
        .from(mailTemplates)
        .where(eq(mailTemplates.templateKey, key))
        .limit(1);

      if (!tpl || tpl.activePublishedVersionId === null) {
        return null;
      }

      const [publishedVer] = await dbOrTx
        .select()
        .from(mailTemplateVersions)
        .where(
          and(
            eq(mailTemplateVersions.id, tpl.activePublishedVersionId),
            eq(mailTemplateVersions.templateId, tpl.id),
            eq(mailTemplateVersions.state, "published"),
          ),
        )
        .limit(1);

      if (!publishedVer) {
        return null;
      }

      return buildPublishedAdapter(tpl.templateKey, tpl.declaredVarsJson, publishedVer);
    },
  };

  const loadSummaryList = async (
    dbOrTx: DbOrTx,
    filters?: { kind?: MailTemplateKind; category?: MailTemplateCategory; query?: string },
  ): Promise<MailTemplateSummaryView[]> => {
    await ensureSystemTemplatesSynced(dbOrTx);
    const rows = await dbOrTx
      .select()
      .from(mailTemplates)
      .orderBy(asc(mailTemplates.kind), asc(mailTemplates.category), asc(mailTemplates.name));

    const activeVersionIds = rows
      .map((r) => r.activePublishedVersionId)
      .filter((id): id is number => typeof id === "number");

    const formatByVersionId = new Map<number, MailTemplateFormat>();
    if (activeVersionIds.length > 0) {
      const verRows = await dbOrTx
        .select({ id: mailTemplateVersions.id, format: mailTemplateVersions.format })
        .from(mailTemplateVersions)
        .where(inArray(mailTemplateVersions.id, activeVersionIds));
      for (const vr of verRows) {
        formatByVersionId.set(vr.id, vr.format);
      }
    }

    const q = filters?.query?.trim().toLowerCase() ?? "";
    return rows
      .filter((r) => {
        if (r.templateKey === VERIFY_AUDIT_KEY) return false;
        if (filters?.kind && r.kind !== filters.kind) return false;
        if (filters?.category && r.category !== filters.category) return false;
        if (q) {
          const hay = `${r.name} ${r.templateKey} ${r.description}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .map((r) => ({
        publicId: r.publicId,
        templateKey: r.templateKey,
        kind: r.kind,
        category: r.category,
        name: r.name,
        description: r.description,
        declaredVars: r.declaredVarsJson,
        hasPublishedOverride: r.activePublishedVersionId !== null,
        hasWorkingDraft: r.workingDraftVersionId !== null,
        activeFormat:
          (r.activePublishedVersionId ? formatByVersionId.get(r.activePublishedVersionId) : undefined) ??
          (r.kind === "system" ? "text" : "html"),
        latestVersionNumber: r.latestVersionNumber,
        version: r.version,
        updatedAt: r.updatedAt,
      }));
  };

  const buildDetailViewInTx = async (
    dbOrTx: DbOrTx,
    templateKey: string,
    catalogue: ReadonlyMap<string, SystemMailTemplateMetadata>,
  ): Promise<MailTemplateDetailView> => {
    const [tpl] = await dbOrTx
      .select()
      .from(mailTemplates)
      .where(eq(mailTemplates.templateKey, templateKey))
      .limit(1);
    if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
      throw notFound();
    }

    const versionRows = await dbOrTx
      .select()
      .from(mailTemplateVersions)
      .where(eq(mailTemplateVersions.templateId, tpl.id))
      .orderBy(desc(mailTemplateVersions.versionNumber));

    const activePublishedRow =
      tpl.activePublishedVersionId !== null
        ? versionRows.find((v) => v.id === tpl.activePublishedVersionId) ?? null
        : null;
    const workingDraftRow =
      tpl.workingDraftVersionId !== null
        ? versionRows.find((v) => v.id === tpl.workingDraftVersionId) ?? null
        : null;

    const sysMeta = tpl.kind === "system" ? catalogue.get(tpl.templateKey) ?? null : null;
    let systemDefault: MailTemplateDetailView["systemDefault"] = null;
    if (sysMeta) {
      const canonicalHtml = sanitizeTemplateHtmlOnSave(
        sysMeta.defaultBodyHtml,
        new Set(sysMeta.declaredVars.map((v) => v.name)),
      ).html;
      systemDefault = {
        format: "text",
        subject: sysMeta.defaultSubject,
        bodyHtml: canonicalHtml,
        bodyText: sysMeta.defaultBodyText,
      };
    }

    return {
      publicId: tpl.publicId,
      templateKey: tpl.templateKey,
      kind: tpl.kind,
      category: tpl.category,
      name: tpl.name,
      description: tpl.description,
      declaredVars: tpl.declaredVarsJson,
      hasPublishedOverride: activePublishedRow !== null,
      hasWorkingDraft: workingDraftRow !== null,
      activeFormat: activePublishedRow?.format ?? (tpl.kind === "system" ? "text" : "html"),
      latestVersionNumber: tpl.latestVersionNumber,
      version: tpl.version,
      updatedAt: tpl.updatedAt,
      systemDefault,
      activePublished: activePublishedRow ? toVersionView(activePublishedRow) : null,
      workingDraft: workingDraftRow ? toVersionView(workingDraftRow) : null,
      versions: versionRows.map(toVersionView),
    };
  };

  const prepareSanitizedContent = (input: {
    format: MailTemplateFormat;
    subject: string;
    bodyHtml?: string | null;
    bodyText?: string | null;
    deriveTextFromHtml?: boolean;
    declaredVars: readonly MailTemplateVariableSpec[];
  }) => {
    const allowedSet = new Set(input.declaredVars.map((v) => v.name));
    const subjectRes = validateSubjectTemplate(input.subject, allowedSet);

    if (input.format === "text") {
      const textRes = validateTextBodyTemplate(input.bodyText ?? "", allowedSet);
      const contentHash = computeMailTemplateContentHash({
        format: "text",
        subject: subjectRes.subject,
        bodyHtml: null,
        bodyText: textRes.text,
      });
      return {
        format: "text" as const,
        subject: subjectRes.subject,
        bodyHtml: null,
        bodyText: textRes.text,
        contentHash,
        referencedHtmlVars: new Set<string>(),
        referencedTextVars: new Set<string>([...subjectRes.referencedVars, ...textRes.referencedVars]),
      };
    }

    const htmlRes = sanitizeTemplateHtmlOnSave(input.bodyHtml ?? "", allowedSet);
    const shouldDerive = input.deriveTextFromHtml === true || !input.bodyText?.trim();
    const textRes = shouldDerive
      ? validateTextBodyTemplate(htmlRes.derivedText, allowedSet)
      : validateTextBodyTemplate(input.bodyText ?? "", allowedSet);

    const contentHash = computeMailTemplateContentHash({
      format: "html",
      subject: subjectRes.subject,
      bodyHtml: htmlRes.html,
      bodyText: textRes.text,
    });

    return {
      format: "html" as const,
      subject: subjectRes.subject,
      bodyHtml: htmlRes.html,
      bodyText: textRes.text,
      contentHash,
      referencedHtmlVars: new Set<string>([...subjectRes.referencedVars, ...htmlRes.referencedVars]),
      referencedTextVars: new Set<string>([...subjectRes.referencedVars, ...textRes.referencedVars]),
    };
  };

  const assertRequiredSystemVarsPresent = (
    tpl: typeof mailTemplates.$inferSelect,
    prepared: ReturnType<typeof prepareSanitizedContent>,
  ) => {
    if (tpl.kind !== "system") return;
    const missing: string[] = [];
    for (const spec of tpl.declaredVarsJson) {
      if (!spec.required && !spec.sensitive) continue;
      const inText = prepared.referencedTextVars.has(spec.name);
      const inHtml = prepared.format === "text" ? true : prepared.referencedHtmlVars.has(spec.name);
      if (!inText || !inHtml) {
        missing.push(spec.name);
      }
    }
    if (missing.length > 0) {
      throw validation(
        "MISSING_REQUIRED_TEMPLATE_VARIABLES",
        `Cannot publish without required variables in both body and text alternative: ${missing.map((m) => `{{${m}}}`).join(", ")}.`,
      );
    }
  };

  return {
    store,
    ensureSystemTemplatesSynced,

    async list(
      principal: SessionPrincipal,
      input: { kind?: MailTemplateKind; category?: MailTemplateCategory; query?: string } = {},
    ): Promise<{ items: MailTemplateSummaryView[] }> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const items = await loadSummaryList(tx, input);
        return { items };
      });
    },

    async listForAutomations(principal: SessionPrincipal): Promise<{ items: AutomationTemplateOptionView[] }> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        await assertLiveMailAdminInTx(deps, principal, tx, "automations.read");
        const all = await loadSummaryList(tx);
        const items: AutomationTemplateOptionView[] = all
          .filter((t) => t.kind === "system" || t.hasPublishedOverride)
          .map((t) => ({
            templateKey: t.templateKey,
            name: t.name,
            kind: t.kind,
            category: t.category,
            declaredVars: t.declaredVars,
          }));
        return { items };
      });
    },

    async get(principal: SessionPrincipal, input: { templateKey: string }): Promise<MailTemplateDetailView> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);
        return buildDetailViewInTx(tx, input.templateKey, catalogue);
      });
    },

    async createCustom(
      principal: SessionPrincipal,
      input: {
        templateKey: string;
        name: string;
        description?: string;
        category?: MailTemplateCategory;
        declaredVars: readonly MailTemplateVariableSpec[];
        format: MailTemplateFormat;
        subject: string;
        bodyHtml?: string | null;
        bodyText?: string | null;
        deriveTextFromHtml?: boolean;
      },
    ): Promise<MailTemplateDetailView> {
      const normalizedKey = input.templateKey.trim();
      if (!CUSTOM_KEY_RE.test(normalizedKey)) {
        throw validation(
          "INVALID_CUSTOM_TEMPLATE_KEY",
          "Custom template keys must start with 'custom.' followed by lowercase letters, digits, or underscores.",
        );
      }
      const name = input.name.normalize("NFC").trim();
      if (name.length < 2 || name.length > 160) {
        throw validation("INVALID_TEMPLATE_NAME", "Template name must be between 2 and 160 characters.");
      }
      const description = (input.description ?? "").normalize("NFC").trim().slice(0, 500);
      const category = input.category ?? "automation";
      const declaredVars = normalizeDeclaredVarsInput(input.declaredVars);
      const prepared = prepareSanitizedContent({
        format: input.format,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        deriveTextFromHtml: input.deriveTextFromHtml,
        declaredVars,
      });

      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [existing] = await tx
          .select({ id: mailTemplates.id })
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, normalizedKey))
          .limit(1);
        if (existing) {
          throw conflict("DUPLICATE_TEMPLATE_KEY", "A mail template with this key already exists.");
        }

        const now = deps.clock.now();
        const templatePublicId = ulid(now.getTime());
        const [insertTpl] = await tx.insert(mailTemplates).values({
          publicId: templatePublicId,
          templateKey: normalizedKey,
          kind: "custom",
          category,
          name,
          description,
          declaredVarsJson: declaredVars,
          activePublishedVersionId: null,
          workingDraftVersionId: null,
          latestVersionNumber: 1,
          version: 1,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        });

        const templateId = Number(insertTpl.insertId);
        const draftPublicId = ulid(now.getTime());
        const [insertVer] = await tx.insert(mailTemplateVersions).values({
          publicId: draftPublicId,
          templateId,
          versionNumber: 1,
          state: "draft",
          format: prepared.format,
          subject: prepared.subject,
          bodyHtml: prepared.bodyHtml,
          bodyText: prepared.bodyText,
          contentHash: prepared.contentHash,
          changeNote: "Initial draft",
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        });

        await tx
          .update(mailTemplates)
          .set({ workingDraftVersionId: Number(insertVer.insertId) })
          .where(eq(mailTemplates.id, templateId));

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.created",
            action: "create",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: templatePublicId },
            attributes: {
              template_key: normalizedKey,
              kind: "custom",
              category,
              format: prepared.format,
              var_count: declaredVars.length,
            },
          },
          tx,
        );

        return buildDetailViewInTx(tx, normalizedKey, catalogue);
      });
    },

    async saveDraft(
      principal: SessionPrincipal,
      input: {
        templateKey: string;
        expectedVersion: number;
        name?: string;
        description?: string;
        declaredVars?: readonly MailTemplateVariableSpec[];
        format: MailTemplateFormat;
        subject: string;
        bodyHtml?: string | null;
        bodyText?: string | null;
        deriveTextFromHtml?: boolean;
        changeNote?: string;
      },
    ): Promise<MailTemplateDetailView> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [tpl] = await tx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, input.templateKey))
          .for("update")
          .limit(1);

        if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
          throw notFound();
        }
        if (tpl.version !== input.expectedVersion) {
          throw conflict("STALE_TEMPLATE_VERSION", "This template was modified by another session. Reload and try again.");
        }

        const effectiveVars =
          tpl.kind === "custom" && input.declaredVars
            ? normalizeDeclaredVarsInput(input.declaredVars)
            : tpl.declaredVarsJson;

        const prepared = prepareSanitizedContent({
          format: input.format,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodyText: input.bodyText,
          deriveTextFromHtml: input.deriveTextFromHtml,
          declaredVars: effectiveVars,
        });

        const nextName =
          tpl.kind === "custom" && input.name !== undefined
            ? input.name.normalize("NFC").trim()
            : tpl.name;
        if (nextName.length < 2 || nextName.length > 160) {
          throw validation("INVALID_TEMPLATE_NAME", "Template name must be between 2 and 160 characters.");
        }
        const nextDesc =
          input.description !== undefined
            ? input.description.normalize("NFC").trim().slice(0, 500)
            : tpl.description;
        const changeNote = (input.changeNote ?? "").normalize("NFC").trim().slice(0, 500);
        const now = deps.clock.now();

        let draftId = tpl.workingDraftVersionId;
        let savedVersionNumber = tpl.latestVersionNumber;

        if (draftId !== null) {
          const [existingDraft] = await tx
            .select()
            .from(mailTemplateVersions)
            .where(and(eq(mailTemplateVersions.id, draftId), eq(mailTemplateVersions.state, "draft")))
            .for("update")
            .limit(1);
          if (existingDraft) {
            savedVersionNumber = existingDraft.versionNumber;
            await tx
              .update(mailTemplateVersions)
              .set({
                format: prepared.format,
                subject: prepared.subject,
                bodyHtml: prepared.bodyHtml,
                bodyText: prepared.bodyText,
                contentHash: prepared.contentHash,
                changeNote,
                updatedAt: now,
              })
              .where(eq(mailTemplateVersions.id, existingDraft.id));
          } else {
            draftId = null;
          }
        }

        if (draftId === null) {
          savedVersionNumber = tpl.latestVersionNumber + 1;
          const [inserted] = await tx.insert(mailTemplateVersions).values({
            publicId: ulid(now.getTime()),
            templateId: tpl.id,
            versionNumber: savedVersionNumber,
            state: "draft",
            format: prepared.format,
            subject: prepared.subject,
            bodyHtml: prepared.bodyHtml,
            bodyText: prepared.bodyText,
            contentHash: prepared.contentHash,
            changeNote,
            createdByUserId: actor.userId,
            createdAt: now,
            updatedAt: now,
          });
          draftId = Number(inserted.insertId);
        }

        await tx
          .update(mailTemplates)
          .set({
            name: nextName,
            description: nextDesc,
            declaredVarsJson: effectiveVars,
            workingDraftVersionId: draftId,
            latestVersionNumber: Math.max(tpl.latestVersionNumber, savedVersionNumber),
            version: tpl.version + 1,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(mailTemplates.id, tpl.id));

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.draft.saved",
            action: "update",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: tpl.publicId },
            attributes: {
              template_key: tpl.templateKey,
              kind: tpl.kind,
              format: prepared.format,
              version_number: savedVersionNumber,
            },
          },
          tx,
        );

        return buildDetailViewInTx(tx, tpl.templateKey, catalogue);
      });
    },

    async publish(
      principal: SessionPrincipal,
      input: { templateKey: string; expectedVersion: number; changeNote?: string },
    ): Promise<MailTemplateDetailView> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [tpl] = await tx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, input.templateKey))
          .for("update")
          .limit(1);

        if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
          throw notFound();
        }
        if (tpl.version !== input.expectedVersion) {
          throw conflict("STALE_TEMPLATE_VERSION", "This template was modified by another session. Reload and try again.");
        }
        if (tpl.workingDraftVersionId === null) {
          throw validation("NO_DRAFT_TO_PUBLISH", "Save a draft version before publishing.");
        }

        const [draft] = await tx
          .select()
          .from(mailTemplateVersions)
          .where(and(eq(mailTemplateVersions.id, tpl.workingDraftVersionId), eq(mailTemplateVersions.state, "draft")))
          .for("update")
          .limit(1);

        if (!draft) {
          throw validation("NO_DRAFT_TO_PUBLISH", "Save a draft version before publishing.");
        }

        // Re-sanitize and re-validate required system variables at publish time
        const prepared = prepareSanitizedContent({
          format: draft.format,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          deriveTextFromHtml: false,
          declaredVars: tpl.declaredVarsJson,
        });
        assertRequiredSystemVarsPresent(tpl, prepared);

        const now = deps.clock.now();
        const changeNote =
          input.changeNote !== undefined
            ? input.changeNote.normalize("NFC").trim().slice(0, 500)
            : draft.changeNote;

        await tx
          .update(mailTemplateVersions)
          .set({
            state: "published",
            format: prepared.format,
            subject: prepared.subject,
            bodyHtml: prepared.bodyHtml,
            bodyText: prepared.bodyText,
            contentHash: prepared.contentHash,
            changeNote,
            publishedAt: now,
            publishedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(mailTemplateVersions.id, draft.id));

        await tx
          .update(mailTemplates)
          .set({
            activePublishedVersionId: draft.id,
            workingDraftVersionId: null,
            version: tpl.version + 1,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(mailTemplates.id, tpl.id));

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.version.published",
            action: "transition",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: tpl.publicId },
            attributes: {
              template_key: tpl.templateKey,
              kind: tpl.kind,
              format: prepared.format,
              version_number: draft.versionNumber,
            },
          },
          tx,
        );

        return buildDetailViewInTx(tx, tpl.templateKey, catalogue);
      });
    },

    async resetToDefault(
      principal: SessionPrincipal,
      input: { templateKey: string; expectedVersion: number },
    ): Promise<MailTemplateDetailView> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [tpl] = await tx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, input.templateKey))
          .for("update")
          .limit(1);

        if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
          throw notFound();
        }
        if (tpl.kind !== "system") {
          throw validation("CANNOT_RESET_CUSTOM_TEMPLATE", "Only built-in system templates have a default to reset to.");
        }
        if (tpl.version !== input.expectedVersion) {
          throw conflict("STALE_TEMPLATE_VERSION", "This template was modified by another session. Reload and try again.");
        }

        const draftIdToClear = tpl.workingDraftVersionId;
        const now = deps.clock.now();

        await tx
          .update(mailTemplates)
          .set({
            activePublishedVersionId: null,
            workingDraftVersionId: null,
            version: tpl.version + 1,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(mailTemplates.id, tpl.id));

        if (draftIdToClear !== null) {
          await tx
            .delete(mailTemplateVersions)
            .where(and(eq(mailTemplateVersions.id, draftIdToClear), eq(mailTemplateVersions.state, "draft")));
        }

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.reset_to_default",
            action: "transition",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: tpl.publicId },
            attributes: {
              template_key: tpl.templateKey,
              kind: tpl.kind,
            },
          },
          tx,
        );

        return buildDetailViewInTx(tx, tpl.templateKey, catalogue);
      });
    },

    async restoreVersion(
      principal: SessionPrincipal,
      input: { templateKey: string; expectedVersion: number; versionNumber: number },
    ): Promise<MailTemplateDetailView> {
      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [tpl] = await tx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, input.templateKey))
          .for("update")
          .limit(1);

        if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
          throw notFound();
        }
        if (tpl.version !== input.expectedVersion) {
          throw conflict("STALE_TEMPLATE_VERSION", "This template was modified by another session. Reload and try again.");
        }

        const [sourceVer] = await tx
          .select()
          .from(mailTemplateVersions)
          .where(
            and(
              eq(mailTemplateVersions.templateId, tpl.id),
              eq(mailTemplateVersions.versionNumber, input.versionNumber),
              eq(mailTemplateVersions.state, "published"),
            ),
          )
          .limit(1);

        if (!sourceVer) {
          throw notFound();
        }

        const now = deps.clock.now();
        let draftId = tpl.workingDraftVersionId;
        let targetDraftNumber = tpl.latestVersionNumber;

        if (draftId !== null) {
          const [existingDraft] = await tx
            .select()
            .from(mailTemplateVersions)
            .where(and(eq(mailTemplateVersions.id, draftId), eq(mailTemplateVersions.state, "draft")))
            .for("update")
            .limit(1);
          if (existingDraft) {
            targetDraftNumber = existingDraft.versionNumber;
            await tx
              .update(mailTemplateVersions)
              .set({
                format: sourceVer.format,
                subject: sourceVer.subject,
                bodyHtml: sourceVer.bodyHtml,
                bodyText: sourceVer.bodyText,
                contentHash: sourceVer.contentHash,
                changeNote: `Restored from version ${sourceVer.versionNumber}`,
                restoredFromVersionNumber: sourceVer.versionNumber,
                updatedAt: now,
              })
              .where(eq(mailTemplateVersions.id, existingDraft.id));
          } else {
            draftId = null;
          }
        }

        if (draftId === null) {
          targetDraftNumber = tpl.latestVersionNumber + 1;
          const [inserted] = await tx.insert(mailTemplateVersions).values({
            publicId: ulid(now.getTime()),
            templateId: tpl.id,
            versionNumber: targetDraftNumber,
            state: "draft",
            format: sourceVer.format,
            subject: sourceVer.subject,
            bodyHtml: sourceVer.bodyHtml,
            bodyText: sourceVer.bodyText,
            contentHash: sourceVer.contentHash,
            changeNote: `Restored from version ${sourceVer.versionNumber}`,
            restoredFromVersionNumber: sourceVer.versionNumber,
            createdByUserId: actor.userId,
            createdAt: now,
            updatedAt: now,
          });
          draftId = Number(inserted.insertId);
        }

        await tx
          .update(mailTemplates)
          .set({
            workingDraftVersionId: draftId,
            latestVersionNumber: Math.max(tpl.latestVersionNumber, targetDraftNumber),
            version: tpl.version + 1,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(mailTemplates.id, tpl.id));

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.version.restored",
            action: "update",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: tpl.publicId },
            attributes: {
              template_key: tpl.templateKey,
              restored_from_version: sourceVer.versionNumber,
              draft_version: targetDraftNumber,
            },
          },
          tx,
        );

        return buildDetailViewInTx(tx, tpl.templateKey, catalogue);
      });
    },

    async preview(
      principal: SessionPrincipal,
      input: {
        format: MailTemplateFormat;
        subject: string;
        bodyHtml?: string | null;
        bodyText?: string | null;
        deriveTextFromHtml?: boolean;
        declaredVars: readonly MailTemplateVariableSpec[];
        sampleVars?: Readonly<Record<string, string>>;
      },
    ): Promise<MailTemplatePreviewResult> {
      const normalizedVars = normalizeDeclaredVarsInput(input.declaredVars);
      const prepared = prepareSanitizedContent({
        format: input.format,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        deriveTextFromHtml: input.deriveTextFromHtml,
        declaredVars: normalizedVars,
      });

      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");

        const varsObj: Record<string, string> = {};
        for (const spec of normalizedVars) {
          const override = input.sampleVars?.[spec.name];
          varsObj[spec.name] = override !== undefined && override !== "" ? override : spec.sampleValue;
        }

        if (prepared.format === "text") {
          const rendered = renderMailTemplateVersion({
            format: "text",
            subjectTemplate: prepared.subject,
            bodyHtmlTemplate: null,
            bodyTextTemplate: prepared.bodyText,
            declaredVars: normalizedVars.map((v) => v.name),
            vars: varsObj,
            canonicalOrigin: deps.config.canonicalOrigin,
          });
          return {
            subject: rendered.subject,
            text: rendered.text,
            previewHtml: "",
          };
        }

        // Ensure sample link variables fallback to a safe canonical URL if the user typed a non-URL sample
        const htmlCheck = sanitizeTemplateHtmlOnSave(
          prepared.bodyHtml ?? "",
          new Set(normalizedVars.map((v) => v.name)),
        );
        for (const hrefVar of htmlCheck.hrefVars) {
          const candidate = varsObj[hrefVar] ?? "";
          if (
            !parseAllowedTemplateUrl(candidate, {
              allowMailto: true,
              canonicalOrigin: deps.config.canonicalOrigin,
            })
          ) {
            varsObj[hrefVar] = "https://portal.readypackets.example";
          }
        }

        const rendered = renderMailTemplateVersion({
          format: "html",
          subjectTemplate: prepared.subject,
          bodyHtmlTemplate: prepared.bodyHtml,
          bodyTextTemplate: prepared.bodyText,
          declaredVars: normalizedVars.map((v) => v.name),
          vars: varsObj,
          canonicalOrigin: deps.config.canonicalOrigin,
        });

        return {
          subject: rendered.subject,
          text: rendered.text,
          previewHtml: rendered.previewHtml ?? projectInertMailPreviewHtml(rendered.html),
        };
      });
    },

    async sendTestToMe(
      principal: SessionPrincipal,
      input: {
        templateKey: string;
        source?: "working_draft" | "published" | "system_default";
        sampleVars?: Readonly<Record<string, string>>;
      },
    ): Promise<{ queued: true; targetSource: "working_draft" | "published" | "system_default" }> {
      // Rate-limit BEFORE opening DB transaction (no second connection inside tx!)
      await deps.rateLimiter.consume("expensive", `mail_templates.send_test:${principal.userId}`);

      return runMailTemplatesTx(deps, principal, { type: "mail_template" }, async (tx) => {
        const actor = await assertLiveMailAdminInTx(deps, principal, tx, "mail.manage");
        const catalogue = await ensureSystemTemplatesSynced(tx);

        const [tpl] = await tx
          .select()
          .from(mailTemplates)
          .where(eq(mailTemplates.templateKey, input.templateKey))
          .limit(1);

        if (!tpl || tpl.templateKey === VERIFY_AUDIT_KEY) {
          throw notFound();
        }

        let targetSource: "working_draft" | "published" | "system_default";
        let outboxTemplateKey: string;
        let hrefVarsToEnsure: string[] = [];

        const requested = input.source;
        if (
          (requested === "working_draft" || !requested) &&
          tpl.workingDraftVersionId !== null
        ) {
          const [draft] = await tx
            .select()
            .from(mailTemplateVersions)
            .where(eq(mailTemplateVersions.id, tpl.workingDraftVersionId))
            .limit(1);
          if (!draft) throw notFound();
          targetSource = "working_draft";
          outboxTemplateKey = `${TEST_VERSION_PREFIX}${draft.publicId.toLowerCase()}`;
          if (draft.format === "html" && draft.bodyHtml) {
            hrefVarsToEnsure = sanitizeTemplateHtmlOnSave(
              draft.bodyHtml,
              new Set(tpl.declaredVarsJson.map((v) => v.name)),
            ).hrefVars;
          }
        } else if (
          (requested === "published" || !requested) &&
          tpl.activePublishedVersionId !== null
        ) {
          const [pub] = await tx
            .select()
            .from(mailTemplateVersions)
            .where(eq(mailTemplateVersions.id, tpl.activePublishedVersionId))
            .limit(1);
          if (!pub) throw notFound();
          targetSource = "published";
          outboxTemplateKey = `${TEST_VERSION_PREFIX}${pub.publicId.toLowerCase()}`;
          if (pub.format === "html" && pub.bodyHtml) {
            hrefVarsToEnsure = sanitizeTemplateHtmlOnSave(
              pub.bodyHtml,
              new Set(tpl.declaredVarsJson.map((v) => v.name)),
            ).hrefVars;
          }
        } else if (tpl.kind === "system" && catalogue.has(tpl.templateKey)) {
          const sysMeta = catalogue.get(tpl.templateKey)!;
          targetSource = "system_default";
          outboxTemplateKey = `${TEST_DEFAULT_PREFIX}${tpl.templateKey}`;
          hrefVarsToEnsure = sanitizeTemplateHtmlOnSave(
            sysMeta.defaultBodyHtml,
            new Set(tpl.declaredVarsJson.map((v) => v.name)),
          ).hrefVars;
        } else {
          throw validation("NO_TEMPLATE_CONTENT", "Save a draft or publish this template before sending a test.");
        }

        const varsObj: Record<string, string> = {};
        for (const spec of tpl.declaredVarsJson) {
          const override = input.sampleVars?.[spec.name];
          varsObj[spec.name] = override !== undefined && override !== "" ? override : spec.sampleValue;
        }
        for (const hrefVar of hrefVarsToEnsure) {
          const candidate = varsObj[hrefVar] ?? "";
          if (
            !parseAllowedTemplateUrl(candidate, {
              allowMailto: true,
              canonicalOrigin: deps.config.canonicalOrigin,
            })
          ) {
            varsObj[hrefVar] = "https://portal.readypackets.example";
          }
        }

        const now = deps.clock.now();
        const testDispatchId = ulid(now.getTime());

        // Strictly addressed to the signed-in acting administrator's own `userId` (never a raw address)
        await deps.mailer.enqueue(
          {
            template: outboxTemplateKey,
            to: { userId: actor.userId },
            vars: varsObj,
            idempotencyKey: `mail_template.test:${testDispatchId}`,
          },
          tx,
        );

        await deps.audit.record(
          {
            category: "operational",
            eventName: "mail_template.test.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: actor.userId, role: actor.role },
            resource: { type: "mail_template", publicId: tpl.publicId },
            attributes: {
              template_key: tpl.templateKey,
              target_source: targetSource,
            },
          },
          tx,
        );

        return { queued: true as const, targetSource };
      });
    },
  };
}

// Re-export helpers used in tests and automation action
export {
  extractTextPlaceholders,
  plainTextToDeliveryHtml,
  projectInertMailPreviewHtml,
  substitutePlainText,
  wrapDeliveryHtmlDocument,
};
