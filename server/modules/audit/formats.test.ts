/** Export encoding: CSV formula injection, CEF header/extension escaping, JSONL line safety. */
import { describe, expect, it } from "vitest";
import { cefHeader, cefValue, csvCell, toCefLine, toCsvRow, toJsonLine } from "./formats.js";
import type { ExternalAuditEvent } from "./envelope.js";

const base = {
  event_id: "01JD0000000000000000000001",
  occurred_at: "2026-11-20T12:00:00.000Z",
  observed_at: "2026-11-20T12:00:00.000Z",
  severity_text: "WARN",
  category: "security",
  event_name: "auth.login.failed",
  action: "login",
  outcome: "failed",
  reason_code: "BAD_CREDENTIALS",
  actor_role: "anonymous",
  actor_ref: "a".repeat(32),
  request_id: "req-1",
  correlation_id: "corr=1|x",
  chain_seq: 9,
  attributes: { note: "=HYPERLINK(\"http://evil.example.test\")" },
} as unknown as ExternalAuditEvent;

describe("CSV", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "＝1", "＋1", "－1", "＠x", " =1", "\u00A0=1"])("neutralises formula-leading %j", (v) => {
    const cell = csvCell(v);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    expect(unquoted.startsWith("'")).toBe(true);
  });
  it("RFC 4180 quoting for comma, quote and newline", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
  it("object cells (attributes) are JSON then neutralised; a row has exactly one line terminator", () => {
    const row = toCsvRow(base, "external");
    expect(row.endsWith("\r\n")).toBe(true);
    expect(row.slice(0, -2)).not.toMatch(/\r\n/);
    expect(row).toContain("HYPERLINK");
    expect(row).not.toMatch(/,=HYPERLINK/);
  });
});

describe("CEF", () => {
  it("escapes pipe and backslash in headers, strips newlines", () => {
    expect(cefHeader("a|b\\c\nd")).toBe("a\\|b\\\\c d");
  });
  it("escapes equals, backslash and CR/LF in extension values", () => {
    expect(cefValue("k=v\\x\r\ny")).toBe("k\\=v\\\\x\\r\\ny");
  });
  it("one event = one line, hostile values cannot add extension keys", () => {
    const line = toCefLine({ ...base, correlation_id: "x act=forged\nCEF:0|fake" } as ExternalAuditEvent, "1.0|evil");
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(line).toContain("cs5=x act\\=forged\\nCEF:0|fake");
    expect(line.startsWith("CEF:0|ReadyPackets|Portal|1.0\\|evil|")).toBe(true);
    expect(line.match(/ act=/g)).toHaveLength(1);
  });
});

describe("JSONL", () => {
  it("escapes U+2028/U+2029 and control chars so one record is one line", () => {
    const line = toJsonLine({ ...base, correlation_id: "a\u2028b\u2029c\nd" } as ExternalAuditEvent);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\n\r\u2028\u2029]/);
    expect((JSON.parse(line) as { correlation_id: string }).correlation_id).toBe("a\u2028b\u2029c\nd");
  });
});

describe("external projection allowlist", () => {
  it("forwards flags and fixed-vocabulary keys, withholds identifiers and references (counted), keeps them locally", async () => {
    const { projectForExternal } = await import("./envelope.js");
    const { exportRecord } = await import("./formats.js");
    const env = {
      ...base, actor_user_id: 7, resource_public_id: "01JD0000000000000000000009", session_ref: "s".repeat(32), source_address_ref: null,
      durability: "durable", dropped_attributes: 1,
      attributes: { from_status: "open", to_status: "closed", password_updated: true, previous_reference: "RP-1001", owner_public_id: "01JD0000000000000000000002", total_minor: 1200 },
    } as unknown as Parameters<typeof projectForExternal>[0];
    const ext = projectForExternal(env);
    expect(ext.attributes).toEqual({ from_status: "open", to_status: "closed", password_updated: true });
    expect(ext.dropped_attributes).toBe(4);
    expect(JSON.stringify(ext)).not.toContain("RP-1001");
    const local = exportRecord(env, "local");
    expect(local.attributes).toMatchObject({ previous_reference: "RP-1001", total_minor: 1200 });
    expect(local.dropped_attributes).toBe(1);
  });
});
