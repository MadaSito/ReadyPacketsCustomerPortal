/**
 * Redaction corpus + log-injection tests for the operational logger. All values are synthetic and
 * assembled at runtime so no credential-shaped literal is committed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { newRequestContext, runWithRequestContext } from "../core/requestContext.js";
import { buildLogLine, createLogger, MAX_LINE_BYTES, setLogSink, type LoggerConfig } from "./logger.js";
import { neutraliseControl, redact, safeString, scanValue, SENSITIVE_KEY } from "./redact.js";

const cfg: LoggerConfig = { logLevel: "info", serviceName: "readypackets-test", releaseRef: "test", deploymentProfile: "production" };
const repeat = (s: string, n: number) => Array.from({ length: n }, () => s).join("");
const fakeJwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2lnbmF0dXJlLXRlc3Q"].join(".");
const fakePem = "-----BEGIN " + "PRIVATE KEY-----\nTUlJQ2V4YW1wbGU=\n-----END " + "PRIVATE KEY-----";
const fakeCard = ["4111", "1111", "1111", "1111"].join(" "); // Luhn-valid test PAN
const fakeToken = repeat("Ab3_", 12);

const VALUE_CORPUS: { name: string; input: string; leak: string }[] = [
  { name: "jwt", input: `token in text ${fakeJwt} end`, leak: fakeJwt },
  { name: "pem", input: `key:\n${fakePem}`, leak: "TUlJQ2V4YW1wbGU=" },
  { name: "bearer", input: `Authorization: Bearer ${"syntheticbearer"}123456`, leak: "syntheticbearer123456" },
  { name: "basic", input: `Basic ${"dXNlcjpwYXNz"}`, leak: "dXNlcjpwYXNz" },
  { name: "url-credentials", input: `mysql://svc:${"hunter2-example"}@db.example.test/app`, leak: "hunter2-example" },
  { name: "kv-secret", input: `password=${"Correct-Horse-Example"}&x=1`, leak: "Correct-Horse-Example" },
  { name: "api_key kv", input: `api_key: ${"k-example-123"}`, leak: "k-example-123" },
  { name: "encrypted envelope", input: `blob rpenc:v1:${"kid1:abcDEF123+/="}`, leak: "abcDEF123" },
  { name: "email", input: "contact person@customer.example.test now", leak: "person@customer.example.test" },
  { name: "card", input: `pan ${fakeCard}`, leak: fakeCard },
  { name: "long token", input: `x ${fakeToken} y`, leak: fakeToken },
];

describe("redaction corpus", () => {
  for (const c of VALUE_CORPUS) {
    it(`redacts ${c.name}`, () => {
      const out = safeString(c.input);
      expect(out).not.toContain(c.leak);
      expect(out).toMatch(/\[redacted/);
    });
  }

  it("does not flag non-Luhn digit runs or ordinary words", () => {
    expect(scanValue("order 1234 5678 9012 3456").hits).not.toContain("card");
    expect(scanValue("the order was reassigned to staff").hits).toEqual([]);
  });

  it("redacts sensitive KEYS wholesale at any depth, but keeps public session ids", () => {
    const out = redact({
      password: "x",
      nested: { apiKey: "x", Authorization: "x", totp: "123456", recoveryCode: "x", csrfSecret: "x", deep: { client_secret: "x" } },
      sessionId: "sess_public",
      session_ref: "ref",
      sessionToken: "x",
      cookie: "x",
      databaseUrl: "x",
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.sessionToken).toBe("[redacted]");
    expect(out.cookie).toBe("[redacted]");
    expect(out.databaseUrl).toBe("[redacted]");
    expect(out.sessionId).toBe("sess_public");
    expect(out.session_ref).toBe("ref");
    const nested = out.nested as Record<string, unknown>;
    for (const k of ["apiKey", "Authorization", "totp", "recoveryCode", "csrfSecret"]) expect(nested[k]).toBe("[redacted]");
    expect((nested.deep as Record<string, unknown>).client_secret).toBe("[redacted]");
    expect(SENSITIVE_KEY.test("orderId")).toBe(false);
  });

  it("is bounded: depth, keys, arrays, string length, cycles, class instances", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect((redact(cyclic) as Record<string, unknown>).self).toBe("[circular]");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i += 1) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[depth-limit]");
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect((redact(many) as Record<string, unknown>)._truncated_keys).toBe(40);
    expect((redact(Array.from({ length: 80 }, () => 1)) as unknown[]).length).toBe(51);
    expect(String(redact("a".repeat(5000))).length).toBeLessThan(1100);
    class Secretive { get boom(): never { throw new Error("getter invoked"); } }
    expect(redact(new Secretive())).toBe("[object Secretive]");
    expect(redact(Buffer.from("raw-bytes"))).toBe("[binary 9 bytes]");
  });

  it("errors: name + safe codes only; message/stack only when stacks are allowed, and still scanned", () => {
    const err = Object.assign(new Error(`failed for person@customer.example.test with ${fakeJwt}`), { code: "ER_DUP_ENTRY" });
    const prod = redact(err) as Record<string, unknown>;
    expect(prod).toEqual({ error_name: "Error", error_code: "ER_DUP_ENTRY" });
    const dev = redact(err, { includeStacks: true }) as Record<string, unknown>;
    expect(String(dev.error_message)).not.toContain("person@customer.example.test");
    expect(String(dev.error_message)).not.toContain(fakeJwt);
  });
});

describe("log injection", () => {
  it("neutralises CR/LF/U+2028/ESC so a value cannot forge a second line", () => {
    const evil = "ok\r\n{\"severity_text\":\"INFO\",\"body\":\"forged\"}\u2028\u001b[31m";
    const n = neutraliseControl(evil);
    // eslint-disable-next-line no-control-regex -- asserting control characters are gone
    expect(n).not.toMatch(/[\r\n\u2028\u001b]/);
    const line = buildLogLine(cfg, "info", evil, {}, { field: evil });
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.body).not.toMatch(/[\r\n]/);
    expect(String(parsed.field)).not.toMatch(/[\r\n\u2028]/);
  });

  it("reserved envelope keys in context cannot overwrite correlation fields", () => {
    const ctx = newRequestContext("http", { correlationId: "corr-real" });
    const line = runWithRequestContext(ctx, () => buildLogLine(cfg, "info", "m", {}, { request_id: "forged", severity_text: "FATAL", correlation_id: "forged" }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.request_id).toBe(ctx.requestId);
    expect(parsed.trace_id).toBe(ctx.traceId);
    expect(parsed.correlation_id).toBe("corr-real");
    expect(parsed.severity_text).toBe("INFO");
    expect(parsed.severity_number).toBe(9);
    expect(parsed.ctx_request_id).toBe("forged");
  });

  it("caps oversized lines without splitting them", () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "word ".repeat(200)]));
    const line = buildLogLine(cfg, "warn", "big", {}, big);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect((JSON.parse(line) as Record<string, unknown>).attributes_truncated).toBe(true);
  });
});

describe("createLogger", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("filters by level, applies bindings, and writes OTel-shaped JSON", () => {
    const lines: string[] = [];
    restore = setLogSink({ write: (_level, line) => lines.push(line) });
    const log = createLogger(cfg, { module: "audit" }).child({ component: "chain" });
    log.debug("hidden");
    log.info("visible", { count: 3, password: "nope" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ severity_text: "INFO", service_name: "readypackets-test", module: "audit", component: "chain", count: 3, password: "[redacted]" });
  });

  it("never throws to its caller even if the sink fails", () => {
    let calls = 0;
    restore = setLogSink({ write: () => { calls += 1; throw new Error("sink down"); } });
    expect(() => createLogger(cfg).error("x")).not.toThrow();
    expect(calls).toBe(2);
  });
});
