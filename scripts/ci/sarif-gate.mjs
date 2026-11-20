#!/usr/bin/env node
// CI gate over CodeQL SARIF output. Used when results cannot be uploaded to GitHub code scanning
// (private repository without GitHub Code Security), so findings still stop the build.
//
//   node scripts/ci/sarif-gate.mjs <sarif-dir> [min-security-severity=7.0] [baseline.json]
//
// Prints every result (rule, severity, location) and exits 1 when any result has a CVSS-style
// `security-severity` at or above the threshold, or has level "error" with no severity recorded.
// Message text is not printed: it can quote source lines.
//
// The optional baseline is a reviewed list of accepted findings: [{ ruleId, path, justification }].
// A blocking result matching an entry (same rule, same file) is reported as accepted. An entry that
// matches nothing fails the gate, so exceptions are removed as soon as they stop being needed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const threshold = Number(process.argv[3] ?? "7.0");
if (!dir || !Number.isFinite(threshold)) {
  console.error("usage: sarif-gate.mjs <sarif-dir> [min-security-severity]");
  process.exit(2);
}

/** @type {{ ruleId: string, path: string, justification: string, used: boolean }[]} */
const baseline = [];
if (process.argv[4]) {
  const entries = JSON.parse(readFileSync(process.argv[4], "utf8"));
  if (!Array.isArray(entries)) {
    console.error("baseline must be a JSON array");
    process.exit(2);
  }
  for (const entry of entries) {
    const ok = typeof entry?.ruleId === "string" && typeof entry?.path === "string" &&
      typeof entry?.justification === "string" && entry.justification.trim().length >= 40;
    if (!ok) {
      console.error("each baseline entry needs ruleId, path and a justification of at least 40 characters");
      process.exit(2);
    }
    baseline.push({ ruleId: entry.ruleId, path: entry.path, justification: entry.justification, used: false });
  }
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
let accepted = 0;
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
      const uri = String(physical?.artifactLocation?.uri ?? "?");
      const where = `${uri}:${physical?.region?.startLine ?? "?"}`;
      const atThreshold = rule.severity === null ? level === "error" : rule.severity >= threshold;
      const exception = atThreshold ? baseline.find((entry) => entry.ruleId === ruleId && entry.path === uri) : undefined;
      if (exception) {
        exception.used = true;
        accepted += 1;
      } else if (atThreshold) {
        blocking += 1;
      }
      const label = exception ? "ACCEPT" : atThreshold ? "BLOCK " : "note  ";
      const severity = rule.severity === null ? "n/a" : rule.severity.toFixed(1);
      console.log(`${label}  ${ruleId}  severity=${severity} level=${level}  ${where}`);
    }
  }
}

const stale = baseline.filter((entry) => !entry.used);
for (const entry of stale) {
  console.log(`STALE   baseline entry no longer matches a finding: ${entry.ruleId}  ${entry.path}`);
}
console.log(
  `\n${total} result(s): ${blocking} blocking at or above security-severity ${threshold.toFixed(1)}, ` +
    `${accepted} accepted by the reviewed baseline, ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"}.`,
);
process.exit(blocking > 0 || stale.length > 0 ? 1 : 0);
