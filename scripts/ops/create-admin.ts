/**
 * Creates the FIRST administrator on a fresh installation.
 *
 *   pnpm admin:create --email admin@example.com --name "Full Name"
 *
 * The password is never accepted on the command line (process lists are public). It is read from
 *   - RP_BOOTSTRAP_ADMIN_PASSWORD_FILE (a root-only file; delete it afterwards), or
 *   - an interactive hidden prompt when run on a terminal.
 * The account is active and must enrol an authenticator app (TOTP) at first sign-in; it must also choose a
 * new password at first sign-in. The command refuses when an active administrator already exists — further
 * administrators are created in the portal (Administration → Staff), which requires step-up.
 *
 * Exit codes: 0 created · 1 failed · 64 usage · 73 an administrator already exists · 78 configuration.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";
import { ConfigError, loadConfig } from "../../server/config/env.js";
import { createContainer } from "../../server/container.js";
import { DomainError } from "../../server/core/errors.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        process.stderr.write("\n");
        resolve(answer);
      });
      muted = true;
    });
  } finally {
    rl.close();
  }
}

/**
 * Reads a one-line secret through a single descriptor: must be a regular file owned by the invoking user (or
 * root), not readable by group/others, and at most 1 KiB. Only one trailing newline is removed — other
 * whitespace is part of the secret. Neither the path nor the content is ever printed.
 */
function readSecretFile(file: string): string {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.uid !== uid && stat.uid !== 0) || stat.size === 0 || stat.size > 1024) {
      throw new Error("unsafe secret file");
    }
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString("utf8").replace(/\r?\n$/, "");
  } finally {
    closeSync(fd);
  }
}

async function readPassword(): Promise<string | null> {
  const file = process.env.RP_BOOTSTRAP_ADMIN_PASSWORD_FILE;
  if (file) return readSecretFile(file);
  if (!process.stdin.isTTY) return null;
  const first = await promptHidden("New administrator password: ");
  const second = await promptHidden("Repeat password: ");
  if (first !== second) {
    console.error("The passwords do not match.");
    return null;
  }
  return first;
}

async function main(): Promise<number> {
  if (process.argv.some((value) => /^--password/.test(value))) {
    console.error("Passwords are not accepted on the command line. Use RP_BOOTSTRAP_ADMIN_PASSWORD_FILE or the interactive prompt.");
    return 64;
  }
  const email = argument("email") ?? process.env.RP_BOOTSTRAP_ADMIN_EMAIL;
  const name = argument("name") ?? process.env.RP_BOOTSTRAP_ADMIN_NAME;
  if (!email || !name) {
    console.error('Usage: pnpm admin:create --email <address> --name "<full name>"');
    return 64;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Configuration could not be loaded.");
    return 78;
  }

  let password: string | null;
  try {
    password = await readPassword();
  } catch {
    console.error("The password file could not be used. It must be a regular file owned by you, with mode 0600, no larger than 1 KiB.");
    return 78;
  }
  if (!password) {
    console.error("No password supplied. Set RP_BOOTSTRAP_ADMIN_PASSWORD_FILE or run on a terminal.");
    return 64;
  }

  const container = createContainer(config);
  try {
    const { services } = container;
    await services.platform.assertSchemaContract();
    const created = await services.db.transaction((tx) =>
      services.identity.provisionLocalAccount(
        { email, name, role: "admin", password: password, mustChangePassword: true },
        { tx, reason: "bootstrap_admin" },
      ),
    );
    console.log(`Administrator created (id ${created.publicId}).`);
    console.log("Next: sign in, choose a new password and enrol an authenticator app. Remove any password file you used.");
    return 0;
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.reasonCode === "ADMIN_EXISTS") {
        console.error("An active administrator already exists. Create further administrators in the portal (Administration → Staff).");
        return 73;
      }
      // Domain errors carry fixed, user-safe messages (policy failures, address in use, busy).
      console.error(`Not created: ${error.safeMessage}`);
      return 1;
    }
    console.error("The administrator could not be created (unexpected error; see the service log for the correlated record).");
    return 1;
  } finally {
    await container.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("The administrator could not be created.");
    process.exit(1);
  },
);
