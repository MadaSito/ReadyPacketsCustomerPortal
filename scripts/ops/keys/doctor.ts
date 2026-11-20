/**
 * Validates the service configuration without starting the server.
 *   pnpm tsx scripts/ops/keys/doctor.ts [--json]
 * Reports variable NAMES and rules only — never values. Exit codes: 0 ok · 78 configuration errors.
 */
import { doctor } from "./lib.js";

const report = doctor(process.env);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report));
} else {
  for (const p of report.errors) console.log(`ERROR   ${p.variable}: ${p.rule}`);
  for (const p of report.warnings) console.log(`WARNING ${p.variable}: ${p.rule}`);
  console.log(report.ok ? "Configuration OK." : `Configuration invalid (${report.errors.length} error(s)).`);
}
process.exitCode = report.ok ? 0 : 78;
