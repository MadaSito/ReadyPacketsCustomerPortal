/**
 * Recover an existing active administrator from a private host terminal. No web listener.
 * Exit codes: 0 recovered · 1 refused or failed · 64 usage/confirmation · 78 configuration.
 */
import readline from "node:readline";
import { ConfigError, loadConfig } from "../../server/config/env.js";
import { createContainer } from "../../server/container.js";
import { DomainError } from "../../server/core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../server/core/requestContext.js";
import { emailSchema } from "../../server/modules/identity/normalize.js";
import { recoverAdministrator } from "./lib/recoverAdmin.js";

async function confirm(email: string): Promise<string | undefined> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const input = prompt[Symbol.asyncIterator]();
    process.stderr.write(`Recover ${email}? This revokes sessions and clears all local factors.\nRetype the email exactly: `);
    return (await input.next()).value;
  } finally {
    prompt.close();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const email = emailSchema.safeParse(args[1]);
  if (args.length !== 2 || args[0] !== "--email" || !email.success) {
    console.error("Usage: node dist/ops/recover-admin.js --email <address>");
    return 64;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    console.error("Recovery requires a private interactive terminal; do not pipe input or redirect output.");
    return 64;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Configuration could not be loaded.");
    return 78;
  }
  const typed = await confirm(email.data);
  if (typed !== email.data) {
    console.error("The typed email did not match. Nothing was changed.");
    return 64;
  }

  const request = newRequestContext("cli");
  const container = createContainer(config);
  try {
    const { services } = container;
    await services.platform.assertSchemaContract();
    const { password } = await runWithRequestContext(request, () => recoverAdministrator(services, email.data, typed));
    process.stdout.write(`Temporary password (shown once): ${password}\n`);
    process.stderr.write(`Recovery completed (${request.requestId}). Sign in locally, enroll TOTP and replace the password.\n`);
    return 0;
  } catch (error) {
    const message = error instanceof DomainError ? error.safeMessage : "Unexpected recovery error.";
    console.error(`Recovery did not complete (${request.requestId}): ${message}`);
    return 1;
  } finally {
    await container.close().catch(() => undefined);
  }
}

main().then(
  (code) => { process.exitCode = code; },
  () => { console.error("Administrator recovery failed."); process.exitCode = 1; },
);
