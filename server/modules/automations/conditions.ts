/**
 * Pure, deterministic, expression-free condition validator & evaluator (Decision 9).
 * No `eval`, `new Function`, regex from untrusted input, or `personal: true` field evaluation.
 */
import { z } from "zod";
import { validation } from "../../core/errors.js";
import type {
  AutomationConditionGroup,
  AutomationConditionLeaf,
  AutomationConditionTree,
  AutomationScalarValue,
  ConditionOperator,
  TriggerField,
  TriggerFieldType,
} from "./contracts.js";
import {
  AUTOMATION_MAX_CONDITION_GROUPS,
  AUTOMATION_MAX_CONDITIONS_PER_GROUP,
  CONDITION_OPERATORS,
} from "./contracts.js";

export const OPERATORS_BY_FIELD_TYPE: Readonly<Record<TriggerFieldType, readonly ConditionOperator[]>> =
  Object.freeze({
    string: ["eq", "neq", "in", "not_in", "contains", "starts_with", "exists"],
    enum: ["eq", "neq", "in", "not_in", "exists"],
    public_id: ["eq", "neq", "in", "not_in", "exists"],
    number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "exists"],
    money_minor: ["eq", "neq", "gt", "gte", "lt", "lte", "exists"],
    datetime: ["eq", "neq", "gt", "gte", "lt", "lte", "exists"],
    boolean: ["eq", "neq", "is_true", "is_false", "exists"],
  });

const scalarSchema = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
const listValueSchema = z
  .array(z.union([z.string().max(256), z.number().finite()]))
  .min(1)
  .max(50);

export const conditionLeafSchema = z.strictObject({
  field: z.string().trim().min(1).max(80),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([scalarSchema, listValueSchema]).optional(),
});

export const conditionGroupSchema = z.strictObject({
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionLeafSchema).min(1).max(AUTOMATION_MAX_CONDITIONS_PER_GROUP),
});

export const conditionTreeSchema = z.strictObject({
  match: z.enum(["all", "any"]),
  groups: z.array(conditionGroupSchema).max(AUTOMATION_MAX_CONDITION_GROUPS),
});

export const EMPTY_CONDITION_TREE: AutomationConditionTree = Object.freeze({
  match: "all",
  groups: [],
});

export function validateConditionTreeForFields(
  tree: AutomationConditionTree,
  declaredFields: readonly TriggerField[],
): void {
  const byKey = new Map(declaredFields.map((f) => [f.key, f]));

  for (let gi = 0; gi < tree.groups.length; gi += 1) {
    const group = tree.groups[gi]!;
    for (let li = 0; li < group.conditions.length; li += 1) {
      const leaf = group.conditions[li]!;
      const field = byKey.get(leaf.field);
      if (!field) {
        throw validation(
          "UNKNOWN_CONDITION_FIELD",
          `Condition field "${leaf.field}" is not available on the selected trigger.`,
        );
      }
      if (field.personal) {
        throw validation(
          "PERSONAL_FIELD_FORBIDDEN_IN_CONDITION",
          `Personal field "${leaf.field}" is available only in templates and cannot be used in conditions.`,
        );
      }
      const allowedOps = OPERATORS_BY_FIELD_TYPE[field.type];
      if (!allowedOps.includes(leaf.operator)) {
        throw validation(
          "INVALID_CONDITION_OPERATOR",
          `Operator "${leaf.operator}" is not valid for field "${leaf.field}" (${field.type}).`,
        );
      }
      validateConditionLeafValue(leaf, field);
    }
  }
}

function validateConditionLeafValue(leaf: AutomationConditionLeaf, field: TriggerField): void {
  const op = leaf.operator;
  if (op === "is_true" || op === "is_false" || op === "exists") {
    if (leaf.value !== undefined && leaf.value !== null) {
      throw validation(
        "UNEXPECTED_CONDITION_VALUE",
        `Operator "${op}" on "${field.key}" does not take a comparison value.`,
      );
    }
    return;
  }

  if (op === "in" || op === "not_in") {
    if (!Array.isArray(leaf.value) || leaf.value.length === 0) {
      throw validation(
        "INVALID_CONDITION_VALUE",
        `Operator "${op}" on "${field.key}" requires a non-empty list of values.`,
      );
    }
    for (const item of leaf.value) {
      if (field.type === "number" || field.type === "money_minor") {
        if (typeof item !== "number" || !Number.isFinite(item)) {
          throw validation("INVALID_CONDITION_VALUE", `Field "${field.key}" expects numeric values.`);
        }
      } else {
        if (typeof item !== "string") {
          throw validation("INVALID_CONDITION_VALUE", `Field "${field.key}" expects text values.`);
        }
        if (field.type === "enum" && field.enumValues && !field.enumValues.includes(item)) {
          throw validation(
            "INVALID_CONDITION_ENUM",
            `Value "${item}" is not valid for "${field.key}".`,
          );
        }
      }
    }
    return;
  }

  if (leaf.value === undefined || leaf.value === null || Array.isArray(leaf.value)) {
    throw validation(
      "INVALID_CONDITION_VALUE",
      `Operator "${op}" on "${field.key}" requires a single comparison value.`,
    );
  }

  switch (field.type) {
    case "number":
    case "money_minor":
      if (typeof leaf.value !== "number" || !Number.isFinite(leaf.value)) {
        throw validation("INVALID_CONDITION_VALUE", `Field "${field.key}" requires a numeric value.`);
      }
      break;
    case "boolean":
      if (typeof leaf.value !== "boolean") {
        throw validation("INVALID_CONDITION_VALUE", `Field "${field.key}" requires a boolean value.`);
      }
      break;
    case "enum":
      if (
        typeof leaf.value !== "string" ||
        (field.enumValues && !field.enumValues.includes(leaf.value))
      ) {
        throw validation("INVALID_CONDITION_ENUM", `Invalid option for "${field.key}".`);
      }
      break;
    case "datetime":
      if (typeof leaf.value !== "string" || Number.isNaN(Date.parse(leaf.value))) {
        throw validation(
          "INVALID_CONDITION_DATETIME",
          `Field "${field.key}" requires an ISO-8601 date/time string.`,
        );
      }
      break;
    default:
      if (typeof leaf.value !== "string") {
        throw validation("INVALID_CONDITION_VALUE", `Field "${field.key}" requires a string value.`);
      }
      break;
  }
}

export function evaluateConditionLeaf(
  leaf: AutomationConditionLeaf,
  actual: AutomationScalarValue | undefined,
): boolean {
  const op = leaf.operator;
  if (op === "exists") {
    return actual !== undefined && actual !== null && actual !== "";
  }
  if (op === "is_true") {
    return actual === true;
  }
  if (op === "is_false") {
    return actual === false;
  }
  if (actual === undefined || actual === null) {
    return false;
  }

  if (op === "in" || op === "not_in") {
    if (!Array.isArray(leaf.value)) return false;
    const hit = leaf.value.some((candidate) => candidate === actual);
    return op === "in" ? hit : !hit;
  }

  const target = leaf.value;
  if (target === undefined || target === null || Array.isArray(target)) {
    return false;
  }

  switch (op) {
    case "eq":
      return actual === target;
    case "neq":
      return actual !== target;
    case "contains":
      return typeof actual === "string" && typeof target === "string" && actual.includes(target);
    case "starts_with":
      return typeof actual === "string" && typeof target === "string" && actual.startsWith(target);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const aNum =
        typeof actual === "number"
          ? actual
          : typeof actual === "string"
            ? Date.parse(actual)
            : Number.NaN;
      const bNum =
        typeof target === "number"
          ? target
          : typeof target === "string"
            ? Date.parse(target)
            : Number.NaN;
      if (Number.isNaN(aNum) || Number.isNaN(bNum)) return false;
      if (op === "gt") return aNum > bNum;
      if (op === "gte") return aNum >= bNum;
      if (op === "lt") return aNum < bNum;
      return aNum <= bNum;
    }
    default:
      return false;
  }
}

export interface EvaluatedConditionDetails {
  matched: boolean;
  groupResults: {
    groupIndex: number;
    match: "all" | "any";
    matched: boolean;
    leafResults: {
      field: string;
      operator: ConditionOperator;
      actualValue: AutomationScalarValue | undefined;
      matched: boolean;
    }[];
  }[];
}

export function evaluateConditionTree(
  tree: AutomationConditionTree,
  fields: Readonly<Record<string, AutomationScalarValue>>,
): EvaluatedConditionDetails {
  if (tree.groups.length === 0) {
    return { matched: true, groupResults: [] };
  }

  const groupResults = tree.groups.map((group: AutomationConditionGroup, groupIndex: number) => {
    const leafResults = group.conditions.map((leaf) => {
      const actualValue = fields[leaf.field];
      const matched = evaluateConditionLeaf(leaf, actualValue);
      return {
        field: leaf.field,
        operator: leaf.operator,
        actualValue,
        matched,
      };
    });
    const matched =
      group.match === "all"
        ? leafResults.every((r) => r.matched)
        : leafResults.some((r) => r.matched);
    return {
      groupIndex,
      match: group.match,
      matched,
      leafResults,
    };
  });

  const matched =
    tree.match === "all"
      ? groupResults.every((g) => g.matched)
      : groupResults.some((g) => g.matched);

  return { matched, groupResults };
}
