import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const load = (name: string) => readFileSync(resolve(import.meta.dirname, "../../deploy", name), "utf8");
const id = "01J00000000000000000000001";
const upload = `/api/files/upload/${id}`;
const doc = `/api/files/orders/${id}/${id}/document`;

function verifyPaths([pattern, full, ...invalid]: string[]) {
  const regex = new RegExp(pattern!, "u");
  expect(regex.test(full!)).toBe(true);
  for (const path of [...invalid, `${full}/`, `${full}/extra`, full!.replace("/api/files", "/api/Files")]) {
    expect(regex.test(path), path).toBe(false);
  }
}

it.each(["nginx/readypackets-portal.conf.template", "nginx/my.readypackets.com.conf"])(
  "scopes large requests and prevents long PWA cache in %s",
  (name) => {
    const config = load(name);
    expect(config).toMatch(/^ {4}client_max_body_size\s+256k;/m);
    expect(config).not.toMatch(/location \^~ \/api\/ \{/u);
    const exceptions = [...config.matchAll(/^ {4}location ~ "([^"]+)" \{\n([\s\S]*?)^ {4}\}/gm)];
    const recording = exceptions.find(([, , body]) => body?.includes("client_max_body_size 256m;"));
    const editor = exceptions.find(([, , body]) => body?.includes("client_max_body_size 10256k;"));
    expect(recording?.[2]).toContain("$request_method != POST");
    expect(editor?.[2]).toContain("^(GET|HEAD|POST)$");
    verifyPaths([recording![1]!, upload, doc, "/api/files/upload/invalid"]);
    verifyPaths([editor![1]!, doc, upload, `/api/files/orders/invalid/${id}/document`]);
    for (const asset of ["/sw.js", "/manifest.webmanifest"]) {
      const block = config.split(`location = ${asset} {`)[1]?.split("}")[0];
      expect(block).toContain("expires off;");
      expect(block).toContain("proxy_cache off;");
      expect(block).not.toMatch(/proxy_hide_header|add_header|proxy_ignore_headers/u);
    }
  },
);

it("keeps a 256 KiB Caddy default and canonical POST-only file exceptions", () => {
  const config = load("docker/Caddyfile");
  expect(config).toContain("max_size 256KiB");
  for (const [name, cap, full, invalid] of [
    ["file_upload", "256MiB", upload, doc],
    ["document_save", "10256KiB", doc, upload],
  ]) {
    const pattern = config.split(`@${name} {`)[1]?.match(/method POST\s+path_regexp "([^"]+)"/u)?.[1];
    expect(pattern).toBeTruthy();
    expect(config.split(`handle @${name} {`)[1]).toMatch(new RegExp(`^\\s+request_body \\{\\s+max_size ${cap}\\b`, "u"));
    verifyPaths([pattern!, full!, invalid!]);
  }
});
