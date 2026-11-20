// Input comes from stdin, never from argv. No output may contain credential data.
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

try {
  const profile = process.argv[2];
  const input = readFileSync(0, "utf8").trim();
  if (/\s/u.test(input) || input.includes("#")) throw new Error();
  const url = new URL(input);
  const tls = url.searchParams.getAll("tls");
  const ca = url.searchParams.getAll("tlsCaFile");
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port ? Number(url.port) : 3306;
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname.toLowerCase());
  if (!["database_url", "migrator_database_url", "backup_database_url"].includes(profile) ||
      url.protocol !== "mysql:" || !url.hostname || !username || !password ||
      [username, password, ...ca].some((value) => /[\0\r\n]/.test(value)) ||
      !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) || port < 1 ||
      tls.length > 1 || (tls.length === 1 && !["required", "off"].includes(tls[0])) ||
      ca.length > 1 || (ca.length === 1 && (tls[0] !== "required" || !ca[0].startsWith("/"))) ||
      [...url.searchParams.keys()].some((key) => key !== "tls" && key !== "tlsCaFile") ||
      (tls[0] !== "required" && (profile !== "backup_database_url" || !loopback))) {
    throw new Error();
  }
  if (tls[0] !== "required" && url.hostname.toLowerCase() === "localhost") {
    const resolved = await lookup("localhost", { all: true });
    if (!resolved.length || resolved.some(({ address }) => address !== "127.0.0.1" && address !== "::1")) {
      throw new Error();
    }
  }
} catch {
  console.error("ReadyPackets: invalid database URL or transport policy. See INSTALL.md.");
  process.exitCode = 1;
}
