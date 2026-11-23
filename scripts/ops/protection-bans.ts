/** Local break-glass command; run using the deployment's authorized operations service account. */
import { pathToFileURL } from "node:url";
import { createContainer } from "../../server/container.js";
import { loadConfig } from "../../server/config/env.js";

const USAGE = "Usage: protection-bans list | clear <publicId> | clear --all";

export function parseBanCommand(args: readonly string[]) {
  if (args.length === 1 && args[0] === "list") return { action: "list" } as const;
  if (args.length === 2 && args[0] === "clear") {
    if (args[1] === "--all") return { action: "clear" } as const;
    if (args[1] && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(args[1])) return { action: "clear", publicId: args[1] } as const;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const command = parseBanCommand(args);
  if (!command) {
    if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${USAGE}\n`); return 0; }
    process.stderr.write(`${USAGE}\n`);
    return 64;
  }
  const container = createContainer(loadConfig());
  try {
    await container.services.platform.assertSchemaContract();
    const protection = container.services.protection;
    if (command.action === "list") {
      // No plaintext network or operator reason in terminal output or shell logs.
      const items = await protection.operatorListSignInBans();
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return 0;
    }
    const cleared = await protection.operatorClearSignInBans("publicId" in command ? command.publicId : undefined);
    process.stdout.write(`Cleared ${cleared} sign-in ban(s).\n`);
    return "publicId" in command && cleared === 0 ? 1 : 0;
  } finally {
    await container.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write("The protection command failed. Check the runtime configuration and database access.\n");
    process.exitCode = 1;
  });
}
