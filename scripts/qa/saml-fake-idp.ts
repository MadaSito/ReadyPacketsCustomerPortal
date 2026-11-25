/**
 * QA-ONLY fake Entra SAML identity provider (increment 07, D10). Never deploy; never point it at production.
 *
 *   node_modules/.bin/tsx scripts/qa/saml-fake-idp.ts --sp http://localhost:5044 --tenant <tenant-guid> --state <private-dir> [--port 5045]
 *
 * 1. Start it. It prints a self-signed certificate. The signing key is kept in --state: a directory only you can
 *    read, outside the repository and outside shared temporary folders (for example ~/.rp-fake-idp).
 * 2. In the portal (/admin/sso): protocol SAML 2.0, tenant = --tenant, add that certificate, enable.
 * 3. Bind your test user to an object id (or use the one shown on the sign-in form).
 * 4. Click "Sign in with Microsoft". The portal redirects to https://login.microsoftonline.com/<tenant>/saml2?SAMLRequest=…
 *    Replace "https://login.microsoftonline.com" with "http://127.0.0.1:<port>" and load it.
 * 5. Choose the identity and claims, submit: the browser POSTs a signed SAMLResponse to the portal's ACS.
 *
 * The signed response is built with the same fixture as the server tests (server/modules/identity/sso/samlTesting.ts).
 */
import { createPrivateKey, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { spUrls } from "../../server/modules/identity/sso/saml.js";
import { buildSignedResponse, createTestIdpKey, type TestIdpKey } from "../../server/modules/identity/sso/samlTesting.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const spOrigin = arg("sp").replace(/\/$/, "");
const tenant = arg("tenant").toLowerCase();
const port = Number(arg("port", "5045"));
const stateDir = arg("state");
const entityOverride = process.argv.includes("--entity-id") ? arg("entity-id") : null;
const sp = spUrls(spOrigin, entityOverride);

function loadKey(): TestIdpKey {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const keyFile = join(stateDir, "key.pem");
  const certFile = join(stateDir, "cert.pem");
  try {
    const certificatePem = readFileSync(certFile, "utf8");
    return { privateKey: createPrivateKey(readFileSync(keyFile, "utf8")), certificatePem, certificateBody: certificatePem.replace(/-----[^-]+-----|\s/g, "") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // First run for this state directory. "wx" creates each file exclusively, so an existing file is never followed
  // or overwritten; a half-written state directory fails loudly instead of being silently replaced.
  const key = createTestIdpKey({ cn: "ReadyPackets QA fake IdP" });
  writeFileSync(keyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600, flag: "wx" });
  writeFileSync(certFile, key.certificatePem, { mode: 0o644, flag: "wx" });
  return key;
}
const key = loadKey();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>` +
  `<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>${esc(title)}</h1>${body}</body></html>`;
const field = (name: string, label: string, value: string) =>
  `<p><label>${esc(label)}<br><input name="${name}" value="${esc(value)}" style="width:100%"></label></p>`;

const MULTIPLE_AUTHN = "http://schemas.microsoft.com/claims/multipleauthn";
const PASSWORD = "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (status: number, html: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(html);
  };
  try {
    if (req.method === "GET" && url.pathname === "/cert.pem") {
      res.writeHead(200, { "content-type": "application/x-pem-file" });
      return res.end(key.certificatePem);
    }
    if (req.method === "GET" && url.pathname === `/${tenant}/saml2`) {
      const raw = url.searchParams.get("SAMLRequest");
      if (!raw) return send(400, page("Missing SAMLRequest", ""));
      const request = inflateRawSync(Buffer.from(raw, "base64")).toString("utf8");
      const id = /\sID="([^"]+)"/.exec(request)?.[1];
      const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(request)?.[1] ?? sp.acsUrl;
      if (!id) return send(400, page("Malformed AuthnRequest", ""));
      if (acs !== sp.acsUrl) return send(400, page("Unexpected ACS URL", `<p>${esc(acs)} is not ${esc(sp.acsUrl)}</p>`));
      const force = /ForceAuthn="true"/.test(request);
      return send(200, page("Fake Entra sign-in (QA only)",
        `<p>Request <code>${esc(id)}</code>${force ? " — ForceAuthn (step-up / link)" : ""}</p>` +
        `<form method="post" action="/respond">` +
        `<input type="hidden" name="irt" value="${esc(id)}">` +
        field("oid", "Object id (bind this to the portal user)", url.searchParams.get("oid") ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") +
        field("email", "E-mail claim", "qa.person@example.test") +
        field("roles", "App roles (comma separated)", "") +
        `<p><label><input type="checkbox" name="mfa" value="1" checked> Include multipleauthn (MFA performed)</label></p>` +
        `<p><label><input type="checkbox" name="stale" value="1"> Old AuthnInstant (10 minutes ago)</label></p>` +
        `<p><label><input type="checkbox" name="tamper" value="1"> Tamper after signing (must be refused)</label></p>` +
        `<button type="submit">Send signed response</button></form>`));
    }
    if (req.method === "POST" && url.pathname === "/respond") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); if (body.length > 10_000) req.destroy(); });
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const now = Date.now();
        const samlResponse = buildSignedResponse({
          sp, key, tenantId: tenant, nowMs: now, inResponseTo: f.get("irt") ?? "",
          objectId: (f.get("oid") ?? randomUUID()).toLowerCase(), email: f.get("email") || null,
          roles: (f.get("roles") ?? "").split(",").map((r) => r.trim()).filter(Boolean),
          methods: f.get("mfa") ? [PASSWORD, MULTIPLE_AUTHN] : [PASSWORD],
          ...(f.get("stale") ? { authnInstantMs: now - 10 * 60_000 } : {}),
          ...(f.get("tamper") ? { tamperAfterSigning: true } : {}),
        });
        send(200, page("Posting to the portal",
          `<form method="post" action="${esc(sp.acsUrl)}"><input type="hidden" name="SAMLResponse" value="${esc(samlResponse)}">` +
          `<button type="submit">Continue</button></form><script>document.forms[0].submit()</script>`));
      });
      return;
    }
    send(404, page("Fake Entra IdP (QA only)", `<p>Certificate: <a href="/cert.pem">/cert.pem</a></p>`));
  } catch (error) {
    send(500, page("Error", `<pre>${esc(String(error))}</pre>`));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Fake Entra SAML IdP (QA only) on http://127.0.0.1:${port}\n` +
    `SP ${sp.entityId}  ACS ${sp.acsUrl}\nTenant ${tenant}\n` +
    `Replace https://login.microsoftonline.com with http://127.0.0.1:${port} in the portal's redirect.\n\n${key.certificatePem}\n`,
  );
});
