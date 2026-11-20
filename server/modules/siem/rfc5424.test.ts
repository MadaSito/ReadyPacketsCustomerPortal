import { describe, expect, it } from "vitest";
import {
  UTF8_BOM_BYTES,
  computeSyslogPri,
  escapeCefExtensionValue,
  escapeCefHeaderField,
  escapeSdParamValue,
  formatCefSyslogFrame,
  formatJsonlRecord,
  formatOtlpLogsPayload,
  formatRfc3339UtcMs,
  formatRfc5424Message,
  frameOctetCounted,
  neutralizeControls,
  otelSeverityToSyslog,
  sanitizePrintUsAscii,
  sanitizeProjectedEvent,
  truncateUtf8Buffer,
  type ExternalAuditEvent,
} from "./index.js";

function sampleEvent(overrides: Partial<ExternalAuditEvent> = {}): ExternalAuditEvent {
  return {
    schema_version: "rp.audit/1",
    event_id: "01JCXX00000000000000000001",
    chain_seq: 42,
    occurred_at: "2026-11-20T14:05:06.789Z",
    observed_at: "2026-11-20T14:05:06.790Z",
    severity_text: "WARN",
    severity_number: 13,
    category: "security",
    event_name: "auth.login.failed",
    action: "authenticate",
    outcome: "denied",
    reason_code: "INVALID_CREDENTIALS",
    service: "readypackets-portal",
    installation_ref: "inst_abc123",
    release_ref: "2026.11.20",
    deployment_profile: "production",
    origin: "http",
    actor_ref: "act_9f8e7d6c5b4a",
    actor_role: "anonymous",
    resource_type: "session",
    resource_ref: "res_112233445566",
    source_address_class: "public",
    request_id: "req_001",
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    correlation_id: "cor_001",
    parent_correlation_id: null,
    job_id: null,
    package_id: null,
    import_id: null,
    delivery_id: null,
    provider: null,
    duration_ms: 18,
    safe_counts: { attempts: 3 },
    attributes: { mfa_required: true },
    dropped_attributes: 0,
    ...overrides,
  };
}

describe("RFC 5424 & RFC 5425 golden vectors", () => {
  it("computes PRI = facility * 8 + severity (fixing legacy facility * 10 bug) with <132> for local0 WARN", () => {
    // Documented golden vector: local0 (16) + WARN (4) = 16 * 8 + 4 = 132 (NOT 16 * 10 + 4 = 164).
    const warnSyslog = otelSeverityToSyslog("WARN");
    expect(warnSyslog).toBe(4);
    expect(computeSyslogPri(16, warnSyslog)).toBe(132);
    expect(computeSyslogPri(16, warnSyslog)).not.toBe(164);

    // Full OTel severity ladder mapping.
    expect(otelSeverityToSyslog("TRACE")).toBe(7);
    expect(otelSeverityToSyslog("DEBUG")).toBe(7);
    expect(otelSeverityToSyslog("INFO")).toBe(6);
    expect(otelSeverityToSyslog("WARN")).toBe(4);
    expect(otelSeverityToSyslog("ERROR")).toBe(3);
    expect(otelSeverityToSyslog("FATAL")).toBe(2);

    const formatted = formatRfc5424Message(sampleEvent(), {
      facility: 16,
      appName: "readypackets",
      hostname: "portal.readypackets.internal",
      procId: "1001",
      enterpriseNumber: null,
      includeBom: false,
    });

    expect(formatted.pri).toBe(132);
    expect(
      formatted.text.startsWith("<132>1 2026-11-20T14:05:06.789Z portal.readypackets.internal readypackets 1001 "),
    ).toBe(true);
  });

  it("emits nilvalue '-' for STRUCTURED-DATA when enterpriseNumber is unset and NEVER appends SD blocks into MSG", () => {
    const formatted = formatRfc5424Message(sampleEvent(), {
      facility: 16,
      appName: "readypackets",
      hostname: "my.readypackets.com",
      procId: "77",
      enterpriseNumber: null,
      includeBom: false,
    });

    // Header has 7 space-delimited tokens: <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA
    const parts = formatted.text.split(" ");
    expect(parts[0]).toBe("<132>1");
    expect(parts[1]).toBe("2026-11-20T14:05:06.789Z");
    expect(parts[2]).toBe("my.readypackets.com");
    expect(parts[3]).toBe("readypackets");
    expect(parts[4]).toBe("77");
    expect(parts[5]).toBe("auth.login.failed");
    expect(parts[6]).toBe("-");

    // MSG begins at parts[7..] as canonical single-line JSON and never embeds an unassigned PEN SD block like "[readypackets@32473 ...]".
    const msgBody = parts.slice(7).join(" ");
    expect(msgBody).toContain('"event_id":"01JCXX00000000000000000001"');
    expect(msgBody).toContain('"outcome":"denied"');
    expect(msgBody).not.toContain("@32473");
    expect(msgBody.startsWith("[")).toBe(false);
    const parsedMsg = JSON.parse(msgBody) as Record<string, unknown>;
    expect(parsedMsg.event_id).toBe("01JCXX00000000000000000001");
    expect(parsedMsg.attributes).toEqual({ mfa_required: true });
  });

  it("disambiguates 40-char attribute keys sharing a 32-char prefix in STRUCTURED-DATA and isolates dynamic attributes in JSON MSG", () => {
    const ev = sampleEvent({
      attributes: {
        shared_prefix_attribute_identifier_alpha: "one",
        shared_prefix_attribute_identifier_bravo: "two role=admin",
      },
    });
    const formatted = formatRfc5424Message(ev, {
      facility: 16,
      enterpriseNumber: 55555,
      sdIdName: "rp",
      includeBom: false,
    });
    const sdStart = formatted.text.indexOf("[rp@55555 ");
    const sdEnd = formatted.text.indexOf("] ");
    const sdSection = formatted.text.slice(sdStart, sdEnd + 1);
    const paramNames = [...sdSection.matchAll(/\s([!-~]+?)="/g)].map((m) => m[1]!);
    // Every PARAM-NAME in the SD-ELEMENT must be <= 32 chars and strictly unique (zero duplicates!).
    expect(new Set(paramNames).size).toBe(paramNames.length);
    expect(paramNames.every((n) => n.length <= 32)).toBe(true);

    // JSON MSG isolates `two role=admin` inside `attributes` so it cannot spoof top-level `role`.
    const jsonPart = formatted.text.slice(sdEnd + 2);
    const parsed = JSON.parse(jsonPart) as { role: string; attributes: Record<string, unknown> };
    expect(parsed.role).toBe("anonymous");
    expect(parsed.attributes.shared_prefix_attribute_identifier_bravo).toBe("two role=admin");
  });

  it("formats private enterprise STRUCTURED-DATA [sdId@PEN ...] and escapes \", \\, and ] in PARAM-VALUE", () => {
    expect(escapeSdParamValue('quote" slash\\ bracket] newline\n nul\u0000')).toBe(
      'quote\\" slash\\\\ bracket\\] newline\\n nul\\0',
    );

    const trickyEvent = sampleEvent({
      reason_code: 'BAD_"TOKEN"\\TEST]INJECT\r\n<0>1 FAKE',
    });

    const formatted = formatRfc5424Message(trickyEvent, {
      facility: 4, // auth/security facility => 4*8 + 4 = 36
      appName: "readypackets",
      hostname: "node-01",
      procId: "42",
      enterpriseNumber: 55555,
      sdIdName: "rp",
      includeBom: true,
    });

    // Must contain zero raw CR or LF bytes anywhere in the syslog message.
    expect(formatted.bytes.includes(0x0a)).toBe(false);
    expect(formatted.bytes.includes(0x0d)).toBe(false);

    expect(
      formatted.text.startsWith("<36>1 2026-11-20T14:05:06.789Z node-01 readypackets 42 auth.login.failed [rp@55555 "),
    ).toBe(true);
    expect(formatted.text).toContain('reason="BAD_\\"TOKEN\\"\\\\TEST\\]INJECT\\r\\n<0>1 FAKE"');

    // Verify UTF-8 BOM immediately precedes MSG after "] ".
    const sdCloseIdx = formatted.bytes.indexOf(Buffer.from("] ", "ascii"));
    expect(sdCloseIdx).toBeGreaterThan(0);
    const bomSlice = formatted.bytes.subarray(sdCloseIdx + 2, sdCloseIdx + 5);
    expect(bomSlice.equals(UTF8_BOM_BYTES)).toBe(true);
  });

  it("enforces PRINTUSASCII and RFC 5424 field length caps on HOSTNAME (255), APP-NAME (48), PROCID (128), MSGID (32)", () => {
    const cleaned = sanitizePrintUsAscii("bad host\r\nname with spaces & émoji 🚀", 255);
    expect(/^[!-~]+$/.test(cleaned)).toBe(true);
    expect(cleaned).not.toContain(" ");
    expect(cleaned).not.toContain("\r");
    expect(cleaned).not.toContain("\n");
    expect(sanitizePrintUsAscii("   ", 48)).toBe("-");
    expect(sanitizePrintUsAscii("x".repeat(300), 48).length).toBe(48);
    expect(sanitizePrintUsAscii("y".repeat(300), 32).length).toBe(32);
    expect(formatRfc3339UtcMs("not-a-date")).toBe("-");
  });

  it("neutralizes C0/C1/DEL and Unicode bidi override control characters", () => {
    const poisoned = "admin\u202Etxt.exe\u0007\u001b[31m\r\n<134>1 SPOOF";
    const safe = neutralizeControls(poisoned);
    expect(safe).not.toContain("\r");
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\u001b");
    expect(safe).not.toContain("\u202e");
    expect(safe).toContain("\\u202e");
    expect(safe).toContain("\\r\\n");
  });

  it("truncates multi-byte UTF-8 messages cleanly on code-point boundaries and frames RFC 5425 octet counts by byte length", () => {
    const multiBytePayload = Buffer.from("🚀".repeat(200), "utf8");
    for (const maxBytes of [480, 481, 482, 483, 484, 500]) {
      const truncated = truncateUtf8Buffer(multiBytePayload, maxBytes);
      expect(truncated.byteLength).toBeLessThanOrEqual(maxBytes);
      const roundTrip = Buffer.from(truncated.toString("utf8"), "utf8");
      expect(roundTrip.equals(truncated)).toBe(true);
    }

    const eventWithUnicode = sampleEvent({
      attributes: { note: "Ångström — 東京 — 🔒".repeat(40) },
    });
    const syslogMsg = formatRfc5424Message(eventWithUnicode, {
      maxMessageBytes: 600,
      includeBom: true,
    });
    expect(syslogMsg.truncated).toBe(true);
    expect(syslogMsg.bytes.byteLength).toBeLessThanOrEqual(600);
    // Valid UTF-8 check: no U+FFFD replacement characters introduced.
    expect(syslogMsg.bytes.toString("utf8")).not.toContain("\uFFFD");

    const framed = frameOctetCounted(syslogMsg.bytes);
    const spaceIdx = framed.indexOf(0x20);
    const declaredByteLen = Number(framed.subarray(0, spaceIdx).toString("ascii"));
    const bodyBytes = framed.subarray(spaceIdx + 1);
    expect(declaredByteLen).toBe(syslogMsg.bytes.byteLength);
    expect(bodyBytes.byteLength).toBe(declaredByteLen);
  });

  it("formats JSON Lines, CEF over syslog, and OTLP/HTTP JSON cleanly without injection or PII leakage", () => {
    const ev = sampleEvent({
      event_name: "pkg| pipe\\ test",
      reason_code: "eq=sign\nnewline\\slash",
    });

    const jsonl = formatJsonlRecord(ev, 8192).toString("utf8");
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.slice(0, -1)).not.toContain("\n");

    expect(escapeCefHeaderField("a|b\\c\nd")).toBe("a\\|b\\\\c\\nd");
    expect(escapeCefExtensionValue("k=v\\x\ny")).toBe("k\\=v\\\\x\\ny");

    const cef = formatCefSyslogFrame(ev, { facility: 16, appName: "readypackets" });
    expect(cef.cefText).toContain("CEF:0|ReadyPackets|readypackets-portal|");
    expect(cef.cefText).toContain("|pkg\\| pipe\\\\ test|");
    expect(cef.cefText).toContain("reason=eq\\=sign\\nnewline\\\\slash");
    expect(cef.frameBytes.includes(0x0a)).toBe(false);

    const otlpBody = formatOtlpLogsPayload([ev]);
    const otlpJson = JSON.parse(otlpBody.toString("utf8")) as {
      resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[];
    };
    const record = otlpJson.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    expect(record.severityNumber).toBe(13);
    expect(record.severityText).toBe("WARN");
    expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record.spanId).toBe("00f067aa0ba902b7");
  });

  it("enforces fixed pseudonymous security projection and strict typed external attribute allowlist", () => {
    const dirtyInput = {
      ...sampleEvent(),
      actor_user_id: 99,
      resource_public_id: "usr_01SECRET",
      session_ref: "ses_raw",
      source_address_ref: "203.0.113.42",
      ipAddress: "203.0.113.42",
      attributes: {
        auth_method: "totp",
        mfa_verified: true,
        version: 3,
        unallowlisted_free_text: "arbitrary customer text",
        arbitrary_amount: 999999,
        user_email: "alice@example.com",
        passwordHash: "$argon2id$secret",
        client_ip: "198.51.100.9",
        nested_text: "contact bob@example.org or 10.20.30.40 now",
      },
    };

    const projected = sanitizeProjectedEvent(dirtyInput);
    const serialized = JSON.stringify(projected);

    expect("actor_user_id" in (projected as unknown as Record<string, unknown>)).toBe(false);
    expect("resource_public_id" in (projected as unknown as Record<string, unknown>)).toBe(false);
    expect("session_ref" in (projected as unknown as Record<string, unknown>)).toBe(false);
    expect("source_address_ref" in (projected as unknown as Record<string, unknown>)).toBe(false);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("198.51.100.9");
    expect(serialized).not.toContain("10.20.30.40");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("bob@example.org");
    expect(serialized).not.toContain("argon2id");
    expect(serialized).not.toContain("arbitrary customer text");
    expect(projected.attributes.auth_method).toBe("totp");
    expect(projected.attributes.mfa_verified).toBe(true);
    expect(projected.attributes.version).toBe(3);
    expect("unallowlisted_free_text" in projected.attributes).toBe(false);
    expect("arbitrary_amount" in projected.attributes).toBe(false);
    expect(projected.dropped_attributes).toBeGreaterThanOrEqual(6);
  });
});
