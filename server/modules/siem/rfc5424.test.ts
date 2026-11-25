import { describe, expect, it } from "vitest";
import {
  EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS,
  EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS,
  EXTERNAL_NUMERIC_ATTRIBUTE_KEYS,
  EXTERNAL_SAFE_COUNT_KEYS,
  EXTERNAL_STRING_ATTRIBUTE_KEYS,
  SIEM_EVENT_CATALOGUE,
  SIEM_NEVER_FORWARDED_ATTRIBUTE_KEYS,
  UTF8_BOM_BYTES,
  computeSyslogPri,
  escapeCefExtensionValue,
  escapeCefHeaderField,
  escapeSdParamValue,
  findSiemCatalogueEntry,
  formatCefSyslogFrame,
  formatJsonlRecord,
  formatOtlpLogsPayload,
  formatRfc3339UtcMs,
  formatRfc5424Message,
  frameOctetCounted,
  isSiemOperationalSelfEvent,
  matchesDestinationFilter,
  neutralizeControls,
  otelSeverityToSyslog,
  projectAuditEnvelopeForSiem,
  sanitizePrintUsAscii,
  sanitizeProjectedEvent,
  truncateUtf8Buffer,
  type AuditEnvelopeLike,
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
      safe_counts: {
        events: 2,
        secret_customer_metric_name: 7,
      },
      attributes: {
        auth_method: "totp",
        role: "SuperSecretToken",
        status: "MixedCaseBearerLikeToken",
        mfa_verified: true,
        arbitrary_boolean_flag_name: true,
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
    expect(serialized).not.toContain("SuperSecretToken");
    expect(serialized).not.toContain("MixedCaseBearerLikeToken");
    expect(projected.safe_counts).toEqual({ events: 2 });
    expect("secret_customer_metric_name" in projected.safe_counts).toBe(false);
    expect(projected.attributes.auth_method).toBe("totp");
    expect(projected.attributes.mfa_verified).toBe(true);
    expect(projected.attributes.version).toBe(3);
    expect("role" in projected.attributes).toBe(false);
    expect("status" in projected.attributes).toBe(false);
    expect("arbitrary_boolean_flag_name" in projected.attributes).toBe(false);
    expect("unallowlisted_free_text" in projected.attributes).toBe(false);
    expect("arbitrary_amount" in projected.attributes).toBe(false);
    expect(projected.dropped_attributes).toBeGreaterThanOrEqual(10);
  });

  it("validates SIEM event catalogue consistency and strict local-only attribute redaction invariants", () => {
    const allowedAttrKeys = new Set<string>([
      ...EXTERNAL_STRING_ATTRIBUTE_KEYS,
      ...EXTERNAL_NUMERIC_ATTRIBUTE_KEYS,
      ...EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS,
      ...EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS,
    ]);

    for (const forbiddenKey of SIEM_NEVER_FORWARDED_ATTRIBUTE_KEYS) {
      expect(allowedAttrKeys.has(forbiddenKey)).toBe(false);
      expect(EXTERNAL_SAFE_COUNT_KEYS.has(forbiddenKey)).toBe(false);
    }

    for (const entry of SIEM_EVENT_CATALOGUE) {
      for (const attr of entry.forwardedAttributes) {
        expect(allowedAttrKeys.has(attr)).toBe(true);
      }
      for (const countKey of entry.forwardedSafeCounts) {
        expect(EXTERNAL_SAFE_COUNT_KEYS.has(countKey)).toBe(true);
      }
      for (const localKey of entry.withheldLocalKeys) {
        expect(allowedAttrKeys.has(localKey)).toBe(false);
      }
    }

    for (const d7Event of [
      "security.incident.opened",
      "security.incident.updated",
      "security.incident.acknowledged",
      "security.incident.closed",
      "security.incident.action",
      "security.ban.created",
      "security.ban.released",
      "security.ban.policy_updated",
    ]) {
      const entry = findSiemCatalogueEntry(d7Event);
      expect(entry).not.toBeNull();
      expect(entry!.category).toBe("security");
      expect(entry!.forwardable).toBe(true);
    }

    expect(findSiemCatalogueEntry("policy.notice.scheduled")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("report.definition.created")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("file.archive.denied")?.defaultSeverity).toBe("WARN");
    expect(findSiemCatalogueEntry("file.archive.ticket_issued")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("file.archive.revoked")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("integration.graph.sites_selected_checked")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("integration.egress.preset_updated")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("integration.production.dispatch.stopped")?.forwardable).toBe(true);
    expect(findSiemCatalogueEntry("siem.delivery.failed")?.forwardable).toBe(false);
    expect(isSiemOperationalSelfEvent("siem.delivery.failed")).toBe(true);
  });

  it("forwards D7 security.incident.* and security.ban.* safe attributes across all wire formats while withholding address_ref, account_ref, and local ULIDs", () => {
    const incidentActionRaw: AuditEnvelopeLike = {
      ...sampleEvent({
        event_id: "01JEINCIDENTEVT00000000001",
        event_name: "security.incident.action",
        action: "ban",
        outcome: "completed",
        severity_text: "WARN",
        category: "security",
        resource_type: "security_incident",
        resource_ref: "9f8e7d6c5b4a39281726354455667788",
        correlation_id: "01JEINCIDENT00000000000001",
      }),
      actor_user_id: 7,
      resource_public_id: "01JEINCIDENT00000000000001",
      source_address_ref: "deadbeef00112233445566778899aabb",
      safe_counts: { events_added: 4 },
      attributes: {
        incident_public_id: "01JEINCIDENT00000000000001",
        ban_public_id: "01JEBAN0000000000000000009",
        address_ref: "deadbeef00112233445566778899aabb",
        account_ref: "cafebabe00112233445566778899aabb",
        rule_key: "password_spraying",
        severity: "high",
        status: "acknowledged",
        event_count: 14,
        account_count: 9,
        address_count: 1,
        action_kind: "ban_ip",
        permanent: false,
      },
      dropped_attributes: 0,
    };

    // Simulate auditPort.projectForExternal stripping attributes that are not yet in audit's older list.
    const narrowerAuditProjector = (raw: AuditEnvelopeLike): ExternalAuditEvent => ({
      ...sampleEvent({
        event_id: raw.event_id,
        event_name: raw.event_name,
        action: raw.action,
        outcome: raw.outcome,
        severity_text: raw.severity_text,
        category: raw.category,
        resource_type: raw.resource_type,
        resource_ref: raw.resource_ref,
        correlation_id: raw.correlation_id,
      }),
      safe_counts: {},
      attributes: { status: "acknowledged", action_kind: "ban_ip" },
      dropped_attributes: 10,
    });

    const projectedIncident = projectAuditEnvelopeForSiem(incidentActionRaw, narrowerAuditProjector);
    expect(projectedIncident.attributes).toEqual({
      rule_key: "password_spraying",
      severity: "high",
      status: "acknowledged",
      event_count: 14,
      account_count: 9,
      address_count: 1,
      action_kind: "ban_ip",
      permanent: false,
    });
    expect(projectedIncident.safe_counts).toEqual({ events_added: 4 });
    expect(projectedIncident.dropped_attributes).toBe(4);
    expect(projectedIncident.correlation_id).toBe("01JEINCIDENT00000000000001");
    expect(
      matchesDestinationFilter(projectedIncident, { minSeverity: "WARN", categories: ["security"] }),
    ).toBe(true);

    const banCreatedRaw: AuditEnvelopeLike = {
      ...sampleEvent({
        event_id: "01JEBANEVT0000000000000002",
        event_name: "security.ban.created",
        action: "create",
        outcome: "completed",
        severity_text: "WARN",
        category: "security",
        resource_type: "signin_ban",
        resource_ref: "11223344556677889900aabbccddeeff",
      }),
      source_address_ref: "deadbeef00112233445566778899aabb",
      attributes: {
        ban_public_id: "01JEBAN0000000000000000009",
        automatic: true,
        address_ref: "deadbeef00112233445566778899aabb",
        reason: "Manual operator reason mentioning 203.0.113.55",
      },
      dropped_attributes: 0,
    };

    const projectedBan = projectAuditEnvelopeForSiem(banCreatedRaw, narrowerAuditProjector);
    expect(projectedBan.attributes).toEqual({ automatic: true });
    expect(projectedBan.dropped_attributes).toBe(3);

    const wirePayloads = [
      formatRfc5424Message(projectedIncident).text,
      formatJsonlRecord(projectedIncident).toString("utf8"),
      formatCefSyslogFrame(projectedIncident).cefText,
      formatOtlpLogsPayload([projectedIncident, projectedBan]).toString("utf8"),
      formatRfc5424Message(projectedBan).text,
      formatJsonlRecord(projectedBan).toString("utf8"),
      formatCefSyslogFrame(projectedBan).cefText,
    ].join("\n");

    expect(wirePayloads).not.toContain("deadbeef00112233445566778899aabb");
    expect(wirePayloads).not.toContain("cafebabe00112233445566778899aabb");
    expect(wirePayloads).not.toContain("01JEBAN0000000000000000009");
    expect(wirePayloads).not.toContain("203.0.113.55");
    expect(wirePayloads).not.toContain("address_ref");
    expect(wirePayloads).not.toContain("account_ref");
    expect(wirePayloads).toContain("password_spraying");

    // Closed-vocabulary enforcement on D7 incident enums: free-text close_reason or unknown rule_key is dropped.
    const invalidVocabIncident = sanitizeProjectedEvent({
      ...sampleEvent({ event_name: "security.incident.closed" }),
      attributes: {
        rule_key: "custom_operator_text_rule",
        close_reason: "Customer called support and explained",
        severity: "critical",
      },
    });
    expect(invalidVocabIncident.attributes).toEqual({ severity: "critical" });
    expect(invalidVocabIncident.dropped_attributes).toBe(2);
  });

  it("projects Increment 06 promotions, reports, workflows, orders, and compliance events cleanly", () => {
    const specSha = "a".repeat(64);
    const reportExport = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "business",
        severity_text: "INFO",
        event_name: "report.exported",
        action: "export",
        outcome: "completed",
      }),
      safe_counts: { rows: 250 },
      attributes: {
        report_key: "payments_discounts",
        dataset: "orders",
        kind: "custom",
        truncated: false,
        spec_hash: specSha,
        definition_public_id: "01JEREPORTDEF0000000000001",
      },
    });
    expect(reportExport.attributes).toEqual({
      report_key: "payments_discounts",
      dataset: "orders",
      kind: "custom",
      truncated: false,
      spec_hash: specSha,
    });
    expect(reportExport.safe_counts).toEqual({ rows: 250 });
    expect(reportExport.dropped_attributes).toBe(1);

    const promoSettings = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "admin",
        severity_text: "WARN",
        event_name: "promotion.settings_updated",
        action: "update",
        outcome: "completed",
      }),
      attributes: {
        enabled: true,
        allow_zero_total: false,
        max_discount_percent: 45.25,
        max_discount_bps: 4525,
        max_fixed_amount_minor: 5000,
        min_order_total_after_discount_minor: 1000,
      },
    });
    expect(promoSettings.attributes).toEqual({
      enabled: true,
      allow_zero_total: false,
      max_discount_percent: 45.25,
      max_discount_bps: 4525,
    });
    expect(promoSettings.dropped_attributes).toBe(2);
  });

  it("projects Increment 07 phase, status catalogue, question, automation, ops alert, webhook, archive, Stripe, SAML, and M365 sync events without leaking local ULIDs, dedupe keys, or bodies", () => {
    const inc07Events: readonly [string, string][] = [
      ["order.stage.advanced", "business"],
      ["order.stage.submitted", "business"],
      ["order.stage.reviewed", "business"],
      ["order.stage.reopened", "admin"],
      ["order.status_catalog.created", "admin"],
      ["order.question.asked", "business"],
      ["order.question.answered", "business"],
      ["order.admin_task.checked", "business"],
      ["order.stage_run.completed", "business"],
      ["order.stage_run.partial_failed", "business"],
      ["order.completion.scheduled", "business"],
      ["automation.rules.reordered", "admin"],
      ["ops.alert.opened", "job"],
      ["ops.alert.escalated", "job"],
      ["ops.alert.acknowledged", "job"],
      ["ops.alert.resolved", "job"],
      ["integration.webhook.lifecycle_queued", "integration"],
      ["file.playback.access", "file"],
      ["file.archive.built", "file"],
      ["payments.attempt.pending_async", "business"],
      ["payment.refund.flagged", "security"],
      ["identity.saml.mfa_mode_changed", "security"],
      ["storage.file_sync.completed", "integration"],
    ];
    for (const [name, expectedCat] of inc07Events) {
      const entry = findSiemCatalogueEntry(name);
      expect(entry, `missing catalogue entry for ${name}`).not.toBeNull();
      expect(entry!.category).toBe(expectedCat);
      expect(entry!.forwardable).toBe(true);
      expect(entry!.increment).toBe("07");
    }

    // D6 operational alert: forwards alert_source, alert_severity, reason_code; strips dedupe_key & alert text.
    const opsAlert = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "job",
        severity_text: "WARN",
        event_name: "ops.alert.opened",
        action: "open",
        outcome: "completed",
        resource_type: "operational_alert",
      }),
      attributes: {
        alert_source: "jobs.dead_letter",
        alert_severity: "critical",
        reason_code: "QUEUE_DEAD_LETTER_THRESHOLD",
        alert_public_id: "01JEALERT00000000000000001",
        dedupe_key: "jobs:dead_letter:order:01JESECRET",
        alert_title: "Customer Alice order sync stuck",
        alert_text: "SharePoint library /sites/Legal/CustomerA failed",
      },
    });
    expect(opsAlert.attributes).toEqual({
      alert_source: "jobs.dead_letter",
      alert_severity: "critical",
      reason_code: "QUEUE_DEAD_LETTER_THRESHOLD",
    });
    expect(opsAlert.dropped_attributes).toBe(4);

    // D2 status catalogue + D4 encrypted phase questions: forwards safe vocab/booleans, strips bodies/labels/ULIDs.
    const statusCreated = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "admin",
        severity_text: "INFO",
        event_name: "order.status_catalog.created",
        outcome: "completed",
      }),
      attributes: {
        status_key: "attorney_review",
        category: "working",
        attention: "staff_review",
        label: "Custom Attorney Review Label",
      },
    });
    expect(statusCreated.attributes).toEqual({
      status_key: "attorney_review",
      category: "working",
      attention: "staff_review",
    });

    const questionAnswered = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "business",
        severity_text: "INFO",
        event_name: "order.question.answered",
        outcome: "completed",
      }),
      attributes: {
        stage_key: "intake_phase",
        answer_version: 2,
        order_public_id: "01JEORDER00000000000000001",
        question_public_id: "01JEQUEST00000000000000001",
        answer_text: "Sensitive customer medical disclosure",
      },
    });
    expect(questionAnswered.attributes).toEqual({
      stage_key: "intake_phase",
      answer_version: 2,
    });

    // D7 webhook target_key: canonical production:P101..P401 allowed; subscription ULIDs & URLs dropped.
    const canonicalWebhook = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "integration",
        severity_text: "INFO",
        event_name: "integration.webhook.lifecycle_queued",
        outcome: "completed",
      }),
      attributes: {
        target_key: "production:P201",
        destination_url: "https://hooks.internal.example/secret",
      },
    });
    expect(canonicalWebhook.attributes).toEqual({ target_key: "production:P201" });

    const subscriptionWebhook = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "integration",
        severity_text: "INFO",
        event_name: "integration.webhook.lifecycle_queued",
        outcome: "completed",
      }),
      attributes: {
        target_key: "subscription:01JESUB0000000000000000001",
      },
    });
    expect(subscriptionWebhook.attributes).toEqual({});

    // D10 SAML login & MFA mode: forwards protocol/method/mfa_source, strips SAML XML assertion.
    const samlLogin = sanitizeProjectedEvent({
      ...sampleEvent({
        category: "security",
        severity_text: "INFO",
        event_name: "auth.login.succeeded",
        outcome: "completed",
      }),
      attributes: {
        auth_method: "saml",
        method: "saml",
        protocol: "saml2",
        mfa_source: "entra_claim",
        assertion: "<saml:Assertion>SECRET</saml:Assertion>",
      },
    });
    expect(samlLogin.attributes).toEqual({
      auth_method: "saml",
      method: "saml",
      protocol: "saml2",
      mfa_source: "entra_claim",
    });

    const wireText = [
      formatRfc5424Message(opsAlert).text,
      formatJsonlRecord(questionAnswered).toString("utf8"),
      formatCefSyslogFrame(samlLogin).cefText,
    ].join("\n");
    expect(wireText).not.toContain("01JESECRET");
    expect(wireText).not.toContain("Customer Alice");
    expect(wireText).not.toContain("Sensitive customer medical disclosure");
    expect(wireText).not.toContain("<saml:Assertion>");
  });
});
