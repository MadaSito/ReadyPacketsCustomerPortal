import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const base = "/api/trpc/orders.admin.workflows.transfer";
const procedures = ["preview", "applyImport"];
const load = (file: string) => readFileSync(resolve(import.meta.dirname, "../..", file), "utf8");

describe("workflow import edge configuration", () => {
  it.each(["readypackets-portal.conf.template", "my.readypackets.com.conf"])(
    "keeps the 256 KiB default and uses only two exact, POST-only exceptions in %s",
    (name) => {
      const config = load(`deploy/nginx/${name}`);
      expect(config).toMatch(/^ {4}client_max_body_size\s+256k;/m);
      const locations = [...config.matchAll(/^ {4}location = (\S+) \{\n([\s\S]*?)^ {4}\}/gm)]
        .filter(([, , body]) => body?.includes("4352k"));
      expect(locations.map(([, pathname]) => pathname)).toEqual(procedures.map((name) => `${base}.${name}`));
      for (const [, , body = ""] of locations) {
        expect(body).toContain("if ($request_method != POST) { return 405; }");
        expect(body).not.toContain("proxy_set_header ");
        const expression = /^\s+if \(\$request_uri !~ "([^"]+)"\) \{ return 404; \}$/m.exec(body)?.[1];
        expect(expression).toBeTruthy();
        const exact = new RegExp(expression!, "u");
        const ownPath = procedures.find((name) => exact.test(`${base}.${name}`));
        expect(ownPath).toBeTruthy();
        expect(exact.test(`${base}.${ownPath}?other=value`)).toBe(true);
        expect(exact.test(`${base}.${ownPath}/`)).toBe(false);
        expect(exact.test(`${base}.%${ownPath!.charCodeAt(0).toString(16)}${ownPath!.slice(1)}`)).toBe(false);
        const batchGuard = /^\s+if \(\$args ~ "([^"]+)"\) \{ return 400; \}$/m.exec(body)?.[1];
        expect(batchGuard).toBeTruthy();
        const batch = new RegExp(batchGuard!, "u");
        for (const query of ["batch", "batch=0", "batch=", "limit=1&%62atch=1", "%62%61%74%63%68&batch=1"]) {
          expect(batch.test(query), query).toBe(true);
        }
        for (const query of ["", "notbatch=1", "Batch=1", "batching=1", "filter=batch", "q=foo%26batch=1"]) {
          expect(batch.test(query), query).toBe(false);
        }
      }
    },
  );

  it("matches the original path in Caddy, rejects batch queries, and inherits upstream handling", () => {
    const config = load("deploy/docker/Caddyfile");
    expect(config).toMatch(/\bmax_size 256KiB\b/u);
    const matcher = /^[ \t]*@workflow_import \{\s+method POST\b([\s\S]*?)^[ \t]*\}/mu.exec(config)?.[1] ?? "";
    expect(matcher).toMatch(/\bnot query batch=\*/u);
    expect(config).toMatch(/handle @workflow_import \{\s+request_body \{\s+max_size 4352KiB\s+\}\s+import rp_upstream 0s\s+\}/u);
    const upstream = /^\(rp_upstream\) \{([\s\S]*?)^\}/mu.exec(config)?.[1] ?? "";
    expect(upstream).toMatch(/^\s*flush_interval \{args\[0\]\}\s*$/mu);
    expect(upstream).toMatch(/^\s*response_header_timeout 120s\s*$/mu);
    const pattern = /expression \{orig_uri\}\.matches\('([^']+)'\)/u.exec(matcher)?.[1];
    expect(pattern).toBeTruthy();
    const exact = new RegExp(pattern!, "u");
    expect(procedures.map((name) => exact.test(`${base}.${name}`))).toEqual([true, true]);
    for (const variant of ["apply", "Preview", "%70review", "preview/", "preview,identity.passwordPolicy?batch=1"]) {
      expect(exact.test(`${base}.${variant}`), variant).toBe(false);
    }
  });
});
