#!/usr/bin/env node
// CI gate over CodeQL SARIF output. Used when results cannot be uploaded to GitHub code scanning
// (private repository without GitHub Code Security), so findings still stop the build.
//
//   node scripts/ci/sarif-gate.mjs <sarif-dir> [min-security-severity=7.0]
//
// Prints every result (rule, severity, location) and exits 1 when any result has a CVSS-style
// `security-severity` at or above the threshold, or has level "error" with no severity recorded.
// Message text is not printed: it can quote source lines.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const threshold = Number(process.argv[3] ?? "7.0");
if (!dir || !Number.isFinite(threshold)) {
  console.error("usage: sarif-gate.mjs <sarif-dir> [min-security-severity]");
  process.exit(2);
}

const files = readdirSync(dir).filter((name) => name.endsWith(".sarif"));
if (files.length === 0) {
  console.error(`no .sarif files in ${dir}`);
  process.exit(2);
}

/** @returns {Map<string, { severity: number | null, level: string }>} */
function ruleIndex(run) {
  const rules = new Map();
  const components = [run?.tool?.driver, ...(run?.tool?.extensions ?? [])];
  for (const component of components) {
    for (const rule of component?.rules ?? []) {
      const raw = rule?.properties?.["security-severity"];
      const severity = raw === undefined ? null : Number(raw);
      rules.set(String(rule.id), {
        severity: Number.isFinite(severity) ? severity : null,
        level: String(rule?.defaultConfiguration?.level ?? "warning"),
      });
    }
  }
  return rules;
}

let total = 0;
let blocking = 0;
for (const file of files) {
  const sarif = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const run of sarif.runs ?? []) {
    const rules = ruleIndex(run);
    for (const result of run.results ?? []) {
      total += 1;
      const ruleId = String(result.ruleId ?? result.rule?.id ?? "unknown");
      const rule = rules.get(ruleId) ?? { severity: null, level: "warning" };
      const level = String(result.level ?? rule.level);
      const physical = result.locations?.[0]?.physicalLocation;
      const where = `${physical?.artifactLocation?.uri ?? "?"}:${physical?.region?.startLine ?? "?"}`;
      const blocks = rule.severity === null ? level === "error" : rule.severity >= threshold;
      if (blocks) blocking += 1;
      const severity = rule.severity === null ? "n/a" : rule.severity.toFixed(1);
      console.log(`${blocks ? "BLOCK" : "note "}  ${ruleId}  severity=${severity} level=${level}  ${where}`);
    }
  }
}

console.log(`\n${total} result(s), ${blocking} at or above security-severity ${threshold.toFixed(1)}.`);
process.exit(blocking > 0 ? 1 : 0);
