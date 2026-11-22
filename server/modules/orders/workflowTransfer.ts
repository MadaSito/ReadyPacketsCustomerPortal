/**
 * Increment 05 (A1, contract D1 / ADR 0042) — workflow transfer package: format, guarded parsing, canonical JSON,
 * digest and per-workflow validation. Pure (no database); `workflowTransferService.ts` does the reads and writes.
 *
 * The package is UNTRUSTED input. Parsing order: UTF-8 byte size → bracket depth scan (no parse yet) → JSON.parse
 * (never eval) → walk every key (forbidden `__proto__` / `constructor` / `prototype`, node budget) → strict zod
 * schemas (unknown keys rejected everywhere) → digest over the canonical JSON of the RAW `workflows` and
 * `references` values. Values are never used as object keys without Map / own-property checks. Imported text is
 * plain text: anything that looks like markup is an error finding, and clients render it as text only.
 * The digest detects damage and accidental edits; it is not a signature and never proves origin.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { validation } from "../../core/errors.js";
import {
  draftAcknowledgementSchema,
  draftStateSchema,
  draftTransitionSchema,
  draftUploadSchema,
  hasErrors,
  layoutSchema,
  MAX_STATES,
  MAX_TRANSITIONS,
  toPublishable,
  validateDraft,
  type WorkflowDraftDefinition,
  type WorkflowIssue,
} from "./workflowDesign.js";
import { FOLDER_TEMPLATE_MAX, GATE_SIGNATURE_MODES, MAX_ACCEPTANCE_GATES, MAX_PHASES, usesWorkflowRules, workflowDefinitionSchema } from "./workflowTypes.js";

export const TRANSFER_FORMAT = "readypackets.workflows";
export const TRANSFER_FORMAT_VERSION = 1;
export const TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
export const TRANSFER_MAX_WORKFLOWS = 50;
export const TRANSFER_MAX_DEPTH = 24;
export const TRANSFER_MAX_NODES = 200_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WORKFLOW_KEY = /^[a-z][a-z0-9_]{1,47}$/;
const MARKUP = /<\s*[a-z!/?]/i;
/** Placeholder policy id used only to validate a definition whose gate references are not resolved yet. */
const PLACEHOLDER_POLICY_ID = "0".repeat(26);

/* ------------------------------------------------------------------ format */

const draftText = (max: number) => z.string().max(max).transform((value) => value.normalize("NFC"));
export const policyRefSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

const packageGateSchema = z.strictObject({
  key: draftText(48),
  policyRef: policyRefSchema,
  point: z.union([z.literal("order_start"), z.strictObject({ stepKey: draftText(48) })]),
  signatureMode: z.enum(GATE_SIGNATURE_MODES),
  askAgainOnNewVersion: z.boolean(),
});

/** The designer's draft definition with gates pointing to package references instead of local policy ids. */
const packageDefinitionSchema = z.strictObject({
  states: z
    .array(
      z.strictObject({
        ...draftStateSchema.shape,
        requirements: z
          .strictObject({ uploads: z.array(draftUploadSchema).max(10), acknowledgements: z.array(draftAcknowledgementSchema).max(5) })
          .optional(),
      }),
    )
    .max(MAX_STATES),
  transitions: z.array(draftTransitionSchema).max(MAX_TRANSITIONS),
  phases: z.array(z.strictObject({ key: draftText(48), label: draftText(60) })).max(MAX_PHASES).optional(),
  acceptanceGates: z.array(packageGateSchema).max(MAX_ACCEPTANCE_GATES).optional(),
  storageFolder: draftText(FOLDER_TEMPLATE_MAX).optional(),
});
export type PackageDefinition = z.output<typeof packageDefinitionSchema>;

const packageWorkflowSchema = z.strictObject({
  key: z.string().max(48),
  name: draftText(200),
  /** Workflows have no description column today; exported as null (documented). */
  description: draftText(2000).nullable(),
  unpublished: z.boolean(),
  definition: packageDefinitionSchema,
  layout: layoutSchema.nullable(),
});
export type PackageWorkflow = z.output<typeof packageWorkflowSchema>;

const packagePolicySchema = z.strictObject({
  ref: policyRefSchema,
  /** "" when the source installation had no published policy for the gate (it then always needs a mapping). */
  slug: z.string().max(64),
  title: draftText(200),
  audience: z.string().max(16),
});
export type PackagePolicy = z.output<typeof packagePolicySchema>;

const packageSchema = z.strictObject({
  format: z.literal(TRANSFER_FORMAT),
  formatVersion: z.literal(TRANSFER_FORMAT_VERSION),
  exportedAt: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "Use an ISO date."),
  source: z.strictObject({ release: z.string().max(80), label: z.string().max(120) }),
  // Bounded far above the product limit so "51 workflows" is reported as a plain blocking error, not a schema dump.
  workflows: z.array(packageWorkflowSchema).max(500),
  references: z.strictObject({ policies: z.array(packagePolicySchema).max(500) }),
  integrity: z.strictObject({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[0-9a-f]{64}$/) }),
});
export type WorkflowPackage = z.output<typeof packageSchema>;

/* ------------------------------------------------------------------ canonical JSON + digest */

/** Sorted keys (UTF-16 code unit order), no whitespace, standard JSON escaping. Only JSON values are accepted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("not a JSON value");
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const packageDigest = (workflows: unknown, references: unknown) => sha256Hex(canonicalJson({ references, workflows }));

/* ------------------------------------------------------------------ guarded parse */

const refuse = (code: string, message: string, details?: Record<string, string | number | boolean | readonly string[]>) => validation(code, message, details);

/** Max nesting of objects/arrays, scanned on the raw text before JSON.parse (string contents are skipped). */
export function jsonDepth(text: string, limit: number): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > max) max = depth;
      if (max > limit) return max;
    } else if (ch === 0x7d || ch === 0x5d) depth -= 1;
  }
  return max;
}

function walkKeys(value: unknown): void {
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > TRANSFER_MAX_NODES) throw refuse("PACKAGE_TOO_LARGE", "The file has too many entries to import.");
    if (Array.isArray(current)) stack.push(...current);
    else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) {
        if (FORBIDDEN_KEYS.has(key)) throw refuse("PACKAGE_FORBIDDEN_KEY", "The file contains a field name that is not allowed. Export the workflows again from the source installation.");
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
}

export interface ParsedPackage {
  pkg: WorkflowPackage;
  /** Digest recomputed from the raw values (what the file actually contains). */
  digest: string;
  digestMatches: boolean;
}

/** Structural problems throw VALIDATION with a plain message; content problems are reported by `analysePackage`. */
export function parsePackage(packageText: string): ParsedPackage {
  if (Buffer.byteLength(packageText, "utf8") > TRANSFER_MAX_BYTES) throw refuse("PACKAGE_TOO_LARGE", "The file is larger than 2 MB. Export fewer workflows at a time.");
  if (jsonDepth(packageText, TRANSFER_MAX_DEPTH) > TRANSFER_MAX_DEPTH) throw refuse("PACKAGE_TOO_DEEP", "The file is nested too deeply to be a workflow export.");
  let raw: unknown;
  try {
    raw = JSON.parse(packageText);
  } catch {
    throw refuse("PACKAGE_NOT_JSON", "The file is not a valid workflow export (it is not JSON).");
  }
  walkKeys(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw refuse("PACKAGE_INVALID", "The file is not a workflow export.");
  const head = raw as Record<string, unknown>;
  if (head.format !== TRANSFER_FORMAT) throw refuse("PACKAGE_FORMAT_UNSUPPORTED", "The file is not a ReadyPackets workflow export.");
  if (head.formatVersion !== TRANSFER_FORMAT_VERSION)
    throw refuse("PACKAGE_FORMAT_UNSUPPORTED", "The file was made by a version of ReadyPackets this installation cannot read. Update this installation or export again.");
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10);
    throw refuse("PACKAGE_INVALID", "The file does not match the workflow export format. It may have been edited by hand.", {
      issuePaths: issues.map((issue) => issue.path.join(".")),
      issueCodes: issues.map((issue) => issue.code),
    });
  }
  const digest = packageDigest(head.workflows, head.references);
  return { pkg: parsed.data, digest, digestMatches: digest === parsed.data.integrity.digest };
}

/* ------------------------------------------------------------------ analysis */

export interface TransferFinding {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}
export interface TransferBlocking {
  code: string;
  message: string;
}

/** Resolution of package references to local policy document ids (by slug match or administrator mapping). */
export type GateResolution = ReadonlyMap<string, { localPolicyPublicId: string } | { removeGates: true }>;

function markupFindings(value: unknown, path: string, out: TransferFinding[]): void {
  if (typeof value === "string") {
    if (MARKUP.test(value)) out.push({ severity: "error", code: "TEXT_MARKUP", path, message: "Use plain text without markup (for example no < or HTML tags)." });
    return;
  }
  if (Array.isArray(value)) value.forEach((item, index) => markupFindings(item, path ? `${path}.${index}` : String(index), out));
  else if (value && typeof value === "object") for (const key of Object.keys(value)) markupFindings((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, out);
}

/** Package definition → designer draft. Unresolved references get a placeholder id (validation only). */
export function toDraftDefinition(definition: PackageDefinition, resolution: GateResolution | null): WorkflowDraftDefinition {
  const { acceptanceGates, ...rest } = definition;
  const gates = (acceptanceGates ?? []).flatMap((gate) => {
    const { policyRef, ...gateRest } = gate;
    const resolved = resolution?.get(policyRef);
    if (resolved && "removeGates" in resolved) return [];
    return [{ ...gateRest, policyPublicId: resolved ? resolved.localPolicyPublicId : PLACEHOLDER_POLICY_ID }];
  });
  return { ...rest, ...(gates.length ? { acceptanceGates: gates } : {}) };
}

/** Findings for one workflow: markup, unknown references, the designer validator and the publishing schema. */
export function workflowFindings(workflow: PackageWorkflow, knownRefs: ReadonlySet<string>, resolution: GateResolution | null, rulesEnabled: boolean): TransferFinding[] {
  const findings: TransferFinding[] = [];
  const name = workflow.name.trim();
  if (!name || name.length > 120) findings.push({ severity: "error", code: "NAME_INVALID", path: "name", message: "Give the workflow a name of 1 to 120 characters." });
  markupFindings(workflow.name, "name", findings);
  if (workflow.description !== null) markupFindings(workflow.description, "description", findings);
  markupFindings(workflow.definition, "definition", findings);
  (workflow.definition.acceptanceGates ?? []).forEach((gate, index) => {
    if (!knownRefs.has(gate.policyRef))
      findings.push({ severity: "error", code: "GATE_REFERENCE_UNKNOWN", path: `definition.acceptanceGates.${index}.policyRef`, message: `Acceptance gate ${index + 1} points to a policy that is not listed in the file.` });
  });
  const draft = toDraftDefinition(workflow.definition, resolution);
  const issues: WorkflowIssue[] = validateDraft(draft);
  for (const issue of issues) findings.push({ severity: issue.severity, code: issue.code, path: issue.path ? `definition.${issue.path}` : "definition", message: issue.message });
  if (!hasErrors(issues)) {
    const strict = workflowDefinitionSchema.safeParse(toPublishable(draft));
    if (!strict.success)
      for (const issue of strict.error.issues.slice(0, 10))
        findings.push({ severity: "error", code: "DEFINITION_INVALID", path: `definition.${issue.path.join(".")}`.replace(/\.$/, ""), message: "This part of the workflow does not meet the publishing rules." });
    else if (usesWorkflowRules(strict.data) && !rulesEnabled)
      findings.push({ severity: "warning", code: "RULES_DISABLED", path: "definition", message: "Phases and requirements are switched off here. The draft can be imported but not published until they are turned on." });
  }
  return findings;
}

export interface PackageAnalysis {
  blocking: TransferBlocking[];
  /** Every distinct valid key; duplicates and invalid keys are blocking. */
  keys: string[];
  refs: ReadonlySet<string>;
  usedBy: ReadonlyMap<string, string[]>;
}

export function analysePackage(parsed: ParsedPackage): PackageAnalysis {
  const { pkg } = parsed;
  const blocking: TransferBlocking[] = [];
  if (!parsed.digestMatches)
    blocking.push({ code: "DIGEST_MISMATCH", message: "The file was changed or damaged after it was exported, so it cannot be imported. Export it again from the source installation." });
  if (pkg.workflows.length === 0) blocking.push({ code: "NO_WORKFLOWS", message: "The file contains no workflows." });
  if (pkg.workflows.length > TRANSFER_MAX_WORKFLOWS)
    blocking.push({ code: "TOO_MANY_WORKFLOWS", message: `The file contains ${pkg.workflows.length} workflows. At most ${TRANSFER_MAX_WORKFLOWS} can be imported at once.` });
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const workflow of pkg.workflows) {
    if (!WORKFLOW_KEY.test(workflow.key)) {
      blocking.push({ code: "WORKFLOW_KEY_INVALID", message: "A workflow in the file has a key that is not allowed (lowercase letters, digits and underscores, 2 to 48 characters)." });
      continue;
    }
    if (seen.has(workflow.key)) duplicates.add(workflow.key);
    seen.add(workflow.key);
  }
  if (duplicates.size) blocking.push({ code: "DUPLICATE_WORKFLOW_KEY", message: `The file contains the same workflow key more than once: ${[...duplicates].slice(0, 5).join(", ")}.` });
  const refs = new Set<string>();
  let duplicateRef = false;
  for (const policy of pkg.references.policies) {
    if (refs.has(policy.ref)) duplicateRef = true;
    refs.add(policy.ref);
  }
  if (duplicateRef) blocking.push({ code: "DUPLICATE_REFERENCE", message: "The file lists the same policy reference more than once." });
  const usedBy = new Map<string, string[]>();
  for (const workflow of pkg.workflows)
    for (const gate of workflow.definition.acceptanceGates ?? []) {
      const list = usedBy.get(gate.policyRef) ?? [];
      if (!list.includes(workflow.key)) list.push(workflow.key);
      usedBy.set(gate.policyRef, list);
    }
  return { blocking, keys: [...seen], refs, usedBy };
}

/** Unique key for "Create as new workflow": the key itself when free, else `<key>_2`, `<key>_3`, … (≤ 48 chars). */
export function uniqueKey(base: string, taken: (key: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw validation("WORKFLOW_KEY_EXHAUSTED", "No free key could be found for this workflow. Rename existing workflows first.");
}

/** Audit attribute strings are limited (charset, 128 chars): untrusted text is reduced to that, never rejected. */
export function auditSafe(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9 _.,:;/#()+=*~-]/g, "_");
  return cleaned.length > 128 ? `${cleaned.slice(0, 127)}~` : cleaned;
}

export function exportFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `readypackets-workflows-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}.json`;
}
