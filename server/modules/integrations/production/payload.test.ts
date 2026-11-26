/**
 * Exhaustive row-by-row unit tests for P101 & P201 production webhook payload construction,
 * validation, conflict resolution, and staff preview masking.
 *
 * Cross-checked row by row against:
 *  - `docs/source-specs/increment-02/P101_PRODUCTION_WEBHOOK_LOGIC_CORRECTED.txt` (§2, §3A, §3B, §4, §5, §6, §7)
 *  - `docs/source-specs/increment-02/WEBHOOK_TRIGGER_REFERENCE_P101_P201.txt` (Phase I & Phase II examples,
 *    escaped JSON string rule, P201 exact identity parity rule, `order_scope_mode` conflict rule)
 */
import { describe, expect, it } from "vitest";
import {
  buildLaterPhaseFromDeliveredP101,
  buildP101Payload,
  buildP201FromDeliveredP101,
  maskP101PayloadForRole,
  maskSecretWebhookUrl,
  validateLaterPhasePayload,
  validateP101,
  validateP201,
} from "./payload.js";

describe("production webhook payloads — row-by-row verification against P101_CORRECTED & TRIGGER_REFERENCE", () => {
  it("matches Corrected Doc §3A verbatim: Single Packet 1 Premium -> packet='1', tier='Premium', exact 1-entry manifest", () => {
    const built = buildP101Payload({
      customerRef: "RP-CUST-000008",
      orderReference: "RP-C000008-2608-5E4A2D",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "John Wick",
      clientEmail: "test2@readypackets.com",
      releaseStatus: "",
      packets: [{ packetNumber: 1, tier: "Premium" }],
      otherItemCount: 0,
    });

    expect(built).toEqual({
      ok: true,
      errors: [],
      payload: {
        customer_id: "RP-CUST-000008",
        order_id: "RP-C000008-2608-5E4A2D",
        packet: "1",
        tier: "Premium",
        canon_version: "ReadyPackets_Production_v2.0",
        run_mode: "production",
        client_name: "John Wick",
        client_email: "test2@readypackets.com",
        release_status: "",
        bundle_scope_manifest: "{\"packet_1\":\"Premium\"}",
      },
    });
    expect("order_scope_mode" in (built.payload ?? {})).toBe(false);
  });

  it("matches Corrected Doc §3B verbatim: Packet 1 Premium + Packet 2 Basic -> packet='7', tier='Mixed', ascending manifest", () => {
    // Pass packets out of order (2 then 1) to prove deterministic ascending key serialization
    const built = buildP101Payload({
      customerRef: "RP-CUST-000008",
      orderReference: "RP-C000008-2608-5E4A2D",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "John Wick",
      clientEmail: "test2@readypackets.com",
      releaseStatus: "",
      packets: [
        { packetNumber: 2, tier: "Basic" },
        { packetNumber: 1, tier: "Premium" },
      ],
      otherItemCount: 0,
    });

    expect(built).toEqual({
      ok: true,
      errors: [],
      payload: {
        customer_id: "RP-CUST-000008",
        order_id: "RP-C000008-2608-5E4A2D",
        packet: "7",
        tier: "Mixed",
        canon_version: "ReadyPackets_Production_v2.0",
        run_mode: "production",
        client_name: "John Wick",
        client_email: "test2@readypackets.com",
        release_status: "",
        bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_2\":\"Basic\"}",
      },
    });
  });

  it("matches Trigger Reference Doc dev-phasei-v11-test-028 WITH corrected rule (`order_scope_mode` stripped/rejected)", () => {
    // Building from Trigger Reference example (`dev-001`, `dev-phasei-v11-test-028`, P1 Standard + P2 Basic)
    const built = buildP101Payload({
      customerRef: "dev-001",
      orderReference: "dev-phasei-v11-test-028",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "ReadyPackets Dev Test",
      clientEmail: "dev@test.local",
      releaseStatus: "test_v2_p1_standard_p2_basic_zero_start_after_p104_p105_patch",
      packets: [
        { packetNumber: 1, tier: "Standard" },
        { packetNumber: 2, tier: "Basic" },
      ],
      otherItemCount: 0,
    });

    expect(built).toEqual({
      ok: true,
      errors: [],
      payload: {
        customer_id: "dev-001",
        order_id: "dev-phasei-v11-test-028",
        packet: "7",
        tier: "Mixed",
        canon_version: "ReadyPackets_Production_v2.0",
        run_mode: "production",
        client_name: "ReadyPackets Dev Test",
        client_email: "dev@test.local",
        release_status: "test_v2_p1_standard_p2_basic_zero_start_after_p104_p105_patch",
        bundle_scope_manifest: "{\"packet_1\":\"Standard\",\"packet_2\":\"Basic\"}",
      },
    });

    // And pasting the legacy Trigger Reference JSON WITH `order_scope_mode: "multi_packet_partial"` MUST be rejected!
    const withLegacyScopeMode = validateP101({
      ...built.payload,
      order_scope_mode: "multi_packet_partial",
    });
    expect(withLegacyScopeMode.ok).toBe(false);
    expect(withLegacyScopeMode.errors.map((e) => e.code)).toContain("P101_ORDER_SCOPE_MODE_FORBIDDEN");
  });

  it("supports all single packets 1–6 across Basic/Standard/Premium and full 6-packet master bundle as 7/Mixed", () => {
    for (const packetNumber of [1, 2, 3, 4, 5, 6] as const) {
      for (const tier of ["Basic", "Standard", "Premium"] as const) {
        const single = buildP101Payload({
          customerRef: "RP-CUST-000001",
          orderReference: `RP-ORD-${packetNumber}-${tier}`,
          canonVersion: "ReadyPackets_Production_v2.0",
          runMode: "production",
          clientName: "Ada Lovelace",
          clientEmail: "ada@example.com",
          packets: [{ packetNumber, tier }],
          otherItemCount: 0,
        });
        expect(single.ok).toBe(true);
        expect(single.payload?.packet).toBe(String(packetNumber));
        expect(single.payload?.tier).toBe(tier);
        expect(single.payload?.bundle_scope_manifest).toBe(JSON.stringify({ [`packet_${packetNumber}`]: tier }));
      }
    }

    // All 6 packets selected (even when every packet shares the same tier "Premium") -> still multi-packet => "7" / "Mixed"
    const allSix = buildP101Payload({
      customerRef: "RP-CUST-000008",
      orderReference: "RP-ORD-ALL6",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "John Wick",
      clientEmail: "test2@readypackets.com",
      packets: [6, 4, 2, 5, 3, 1].map((packetNumber) => ({ packetNumber, tier: "Premium" as const })),
      otherItemCount: 0,
    });
    expect(allSix.ok).toBe(true);
    expect(allSix.payload?.packet).toBe("7");
    expect(allSix.payload?.tier).toBe("Mixed");
    expect(allSix.payload?.bundle_scope_manifest).toBe(
      "{\"packet_1\":\"Premium\",\"packet_2\":\"Premium\",\"packet_3\":\"Premium\",\"packet_4\":\"Premium\",\"packet_5\":\"Premium\",\"packet_6\":\"Premium\"}",
    );
  });

  it("blocks every invalid combination from Corrected Doc §4 and Trigger Reference formatting rules", () => {
    const validBase = {
      customer_id: "RP-CUST-000008",
      order_id: "RP-C000008-2608-5E4A2D",
      packet: "1",
      tier: "Premium",
      canon_version: "ReadyPackets_Production_v2.0",
      run_mode: "production",
      client_name: "John Wick",
      client_email: "test2@readypackets.com",
      release_status: "",
      bundle_scope_manifest: "{\"packet_1\":\"Premium\"}",
    };

    const invalidMatrix: Array<{ name: string; candidate: unknown; expectedCode: string }> = [
      {
        name: "§4 Row 1: packet=7, tier=Mixed with single-entry manifest {\"packet_1\":\"Premium\"}",
        candidate: { ...validBase, packet: "7", tier: "Mixed", bundle_scope_manifest: "{\"packet_1\":\"Premium\"}" },
        expectedCode: "P101_PACKET_7_SINGLE_MANIFEST_CONTRADICTION",
      },
      {
        name: "§4 Row 2: packet=1, tier=Premium with mismatched manifest {\"packet_2\":\"Basic\"}",
        candidate: { ...validBase, packet: "1", tier: "Premium", bundle_scope_manifest: "{\"packet_2\":\"Basic\"}" },
        expectedCode: "P101_SINGLE_PACKET_MANIFEST_MISMATCH",
      },
      {
        name: "Single packet with mismatched manifest tier {\"packet_1\":\"Basic\"}",
        candidate: { ...validBase, packet: "1", tier: "Premium", bundle_scope_manifest: "{\"packet_1\":\"Basic\"}" },
        expectedCode: "P101_SINGLE_PACKET_MANIFEST_MISMATCH",
      },
      {
        name: "Single packet paired with multi-entry manifest",
        candidate: {
          ...validBase,
          packet: "1",
          tier: "Premium",
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_2\":\"Basic\"}",
        },
        expectedCode: "P101_SINGLE_PACKET_MANIFEST_MISMATCH",
      },
      {
        name: "§4 Row 3: packet=7 paired with normal tier Premium (7 without Mixed)",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Premium",
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_2\":\"Premium\"}",
        },
        expectedCode: "P101_PACKET_7_REQUIRES_MIXED",
      },
      {
        name: "§4 Row 4: packet=1 paired with Mixed tier (Mixed without 7)",
        candidate: { ...validBase, packet: "1", tier: "Mixed", bundle_scope_manifest: "{\"packet_1\":\"Premium\"}" },
        expectedCode: "P101_MIXED_REQUIRES_PACKET_7",
      },
      {
        name: "§4 Row 5a: missing / blank bundle_scope_manifest",
        candidate: { ...validBase, bundle_scope_manifest: "" },
        expectedCode: "P101_MANIFEST_MISSING",
      },
      {
        name: "§4 Row 5b: invalid JSON string in bundle_scope_manifest",
        candidate: { ...validBase, bundle_scope_manifest: "{packet_1:Premium}" },
        expectedCode: "P101_MANIFEST_INVALID_JSON",
      },
      {
        name: "Trigger Reference 'Wrong format to avoid': raw nested object instead of escaped JSON string",
        candidate: { ...validBase, bundle_scope_manifest: { packet_1: "Premium" } },
        expectedCode: "P101_BUNDLE_SCOPE_MANIFEST_NOT_STRING",
      },
      {
        name: "Trigger Reference numeric packet wrong format: packet as number 7 instead of string '7'",
        candidate: {
          ...validBase,
          packet: 7,
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_2\":\"Basic\"}",
        },
        expectedCode: "P101_PACKET_NOT_STRING",
      },
      {
        name: "Empty manifest '{}'",
        candidate: { ...validBase, bundle_scope_manifest: "{}" },
        expectedCode: "P101_MANIFEST_EMPTY",
      },
      {
        name: "Manifest JSON decodes to array instead of object",
        candidate: { ...validBase, bundle_scope_manifest: "[\"packet_1\"]" },
        expectedCode: "P101_MANIFEST_NOT_OBJECT",
      },
      {
        name: "Unknown top-level tier 'Enterprise'",
        candidate: { ...validBase, tier: "Enterprise" },
        expectedCode: "P101_TIER_UNKNOWN",
      },
      {
        name: "Unknown manifest tier 'Mixed' inside manifest",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_1\":\"Mixed\",\"packet_2\":\"Basic\"}",
        },
        expectedCode: "P101_MANIFEST_TIER_UNKNOWN",
      },
      {
        name: "Manifest packet number 0 outside 1–6",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_0\":\"Basic\",\"packet_1\":\"Premium\"}",
        },
        expectedCode: "P101_MANIFEST_KEY_INVALID",
      },
      {
        name: "Manifest packet number 7 outside 1–6",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_7\":\"Basic\"}",
        },
        expectedCode: "P101_MANIFEST_PACKET_OUT_OF_RANGE",
      },
      {
        name: "Manifest packet number 8 (unlisted reserved packet) outside 1–6",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"packet_8\":\"Premium\"}",
        },
        expectedCode: "P101_MANIFEST_PACKET_OUT_OF_RANGE",
      },
      {
        name: "Non-ascending manifest keys packet_2 before packet_1",
        candidate: {
          ...validBase,
          packet: "7",
          tier: "Mixed",
          bundle_scope_manifest: "{\"packet_2\":\"Basic\",\"packet_1\":\"Premium\"}",
        },
        expectedCode: "P101_MANIFEST_KEYS_NOT_ASCENDING",
      },
      {
        name: "order_scope_mode injected inside bundle_scope_manifest",
        candidate: {
          ...validBase,
          bundle_scope_manifest: "{\"packet_1\":\"Premium\",\"order_scope_mode\":\"single\"}",
        },
        expectedCode: "P101_ORDER_SCOPE_MODE_FORBIDDEN",
      },
      {
        name: "Invalid run_mode with uppercase characters",
        candidate: { ...validBase, run_mode: "Production" },
        expectedCode: "P101_RUN_MODE_INVALID",
      },
      {
        name: "Invalid release_status with spaces/injection characters",
        candidate: { ...validBase, release_status: "bad release status!" },
        expectedCode: "P101_RELEASE_STATUS_INVALID",
      },
    ];

    for (const row of invalidMatrix) {
      const result = validateP101(row.candidate);
      expect(result.ok, row.name).toBe(false);
      expect(
        result.errors.map((e) => e.code),
        row.name,
      ).toContain(row.expectedCode);
    }
  });

  it("refuses orders with zero packets, non-packet items, missing customer_ref, Packet 8, or duplicate packets", () => {
    const baseInput = {
      customerRef: "RP-CUST-000008",
      orderReference: "RP-ORD-100",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "John Wick",
      clientEmail: "test2@readypackets.com",
    };

    const emptyOrder = buildP101Payload({ ...baseInput, packets: [], otherItemCount: 0 });
    expect(emptyOrder.ok).toBe(false);
    expect(emptyOrder.errors.map((e) => e.code)).toContain("ORDER_HAS_NO_PACKETS");

    const mixedWithNonPacket = buildP101Payload({
      ...baseInput,
      packets: [{ packetNumber: 1, tier: "Basic" }],
      otherItemCount: 1,
    });
    expect(mixedWithNonPacket.ok).toBe(false);
    expect(mixedWithNonPacket.errors.map((e) => e.code)).toContain("ORDER_HAS_NON_PACKET_ITEMS");

    const packet8Attempt = buildP101Payload({
      ...baseInput,
      packets: [{ packetNumber: 8, tier: "Premium" }],
      otherItemCount: 0,
    });
    expect(packet8Attempt.ok).toBe(false);
    expect(packet8Attempt.errors.map((e) => e.code)).toContain("ORDER_PACKET_OUT_OF_RANGE");

    const duplicatePacket = buildP101Payload({
      ...baseInput,
      packets: [
        { packetNumber: 2, tier: "Basic" },
        { packetNumber: 2, tier: "Premium" },
      ],
      otherItemCount: 0,
    });
    expect(duplicatePacket.ok).toBe(false);
    expect(duplicatePacket.errors.map((e) => e.code)).toContain("ORDER_DUPLICATE_PACKET");

    const missingRef = buildP101Payload({
      ...baseInput,
      customerRef: null,
      packets: [{ packetNumber: 1, tier: "Basic" }],
      otherItemCount: 0,
    });
    expect(missingRef.ok).toBe(false);
    expect(missingRef.errors.map((e) => e.code)).toContain("CUSTOMER_REF_MISSING");
  });

  it("constructs & validates P201 verbatim from delivered P101 and rejects stale/drifted 026 vs 028 order_id", () => {
    // Corrected Doc §5 & Trigger Reference Page 4
    const deliveredP101 = {
      customerId: "dev-001",
      orderId: "dev-phasei-v11-test-028",
      runMode: "production",
    };

    const built = buildP201FromDeliveredP101(deliveredP101);
    expect(built).toEqual({
      ok: true,
      errors: [],
      payload: {
        customer_id: "dev-001",
        order_id: "dev-phasei-v11-test-028",
        run_mode: "production",
      },
    });

    // Trigger Reference failure prevention row: "Do not use an older order_id such as 026 when the Phase I run is 028."
    const driftedOrder = validateP201(
      {
        customer_id: "dev-001",
        order_id: "dev-phasei-v11-test-026",
        run_mode: "production",
      },
      deliveredP101,
    );
    expect(driftedOrder.ok).toBe(false);
    expect(driftedOrder.errors.map((e) => e.code)).toContain("P201_ORDER_ID_MISMATCH");

    const driftedCustomer = validateP201(
      {
        customer_id: "dev-002",
        order_id: "dev-phasei-v11-test-028",
        run_mode: "production",
      },
      deliveredP101,
    );
    expect(driftedCustomer.ok).toBe(false);
    expect(driftedCustomer.errors.map((e) => e.code)).toContain("P201_CUSTOMER_ID_MISMATCH");

    const extraScopeField = validateP201({
      customer_id: "dev-001",
      order_id: "dev-phasei-v11-test-028",
      run_mode: "production",
      order_scope_mode: "multi_packet_partial",
    });
    expect(extraScopeField.ok).toBe(false);
    expect(extraScopeField.errors.map((e) => e.code)).toContain("P201_ORDER_SCOPE_MODE_FORBIDDEN");
  });

  it("masks client_name/client_email for staff previews and masks secret webhook URLs to host + last 4 chars", () => {
    const built = buildP101Payload({
      customerRef: "RP-CUST-000008",
      orderReference: "RP-C000008-2608-5E4A2D",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: "John Wick",
      clientEmail: "test2@readypackets.com",
      packets: [{ packetNumber: 1, tier: "Premium" }],
      otherItemCount: 0,
    });
    expect(built.ok).toBe(true);

    const staffView = maskP101PayloadForRole(built.payload!, "staff");
    expect(staffView.maskedForViewer).toBe(true);
    expect(staffView.payload.client_name).toBe("J*** W***");
    expect(staffView.payload.client_email).toBe("t***@readypackets.com");
    expect(staffView.payload.customer_id).toBe("RP-CUST-000008");

    const adminView = maskP101PayloadForRole(built.payload!, "admin");
    expect(adminView.maskedForViewer).toBe(false);
    expect(adminView.payload.client_name).toBe("John Wick");
    expect(adminView.payload.client_email).toBe("test2@readypackets.com");

    expect(maskSecretWebhookUrl("https://hooks.make.example/wh/super-secret-token-9f3k")).toEqual({
      host: "hooks.make.example",
      last4: "9f3k",
    });
  });

  it("constructs & validates optional P301 and P401 payloads identically to P201 while preserving P201 parity", () => {
    const deliveredP101 = {
      customerId: "RPCUS-9A8B7C6D5",
      orderId: "ORD-2026-0901",
      runMode: "production",
    };

    const p201 = buildP201FromDeliveredP101(deliveredP101);
    const p301 = buildLaterPhaseFromDeliveredP101("P301", deliveredP101);
    const p401 = buildLaterPhaseFromDeliveredP101("P401", deliveredP101);
    expect(p301).toEqual({
      ok: true,
      errors: [],
      payload: {
        customer_id: "RPCUS-9A8B7C6D5",
        order_id: "ORD-2026-0901",
        run_mode: "production",
      },
    });
    expect(p401).toEqual(p301);
    expect(p201).toEqual(p301);

    const driftedP301 = validateLaterPhasePayload(
      "P301",
      { customer_id: "RPCUS-9A8B7C6D5", order_id: "ORD-2026-WRONG", run_mode: "production" },
      deliveredP101,
    );
    expect(driftedP301.ok).toBe(false);
    expect(driftedP301.errors.map((e) => e.code)).toContain("P301_ORDER_ID_MISMATCH");

    const driftedP401 = validateLaterPhasePayload(
      "P401",
      { customer_id: "RPCUS-OTHER", order_id: "ORD-2026-0901", run_mode: "staging" },
      deliveredP101,
    );
    expect(driftedP401.ok).toBe(false);
    expect(driftedP401.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["P401_CUSTOMER_ID_MISMATCH", "P401_RUN_MODE_MISMATCH"]),
    );

    const extraKeyP401 = validateLaterPhasePayload("P401", {
      customer_id: "RPCUS-9A8B7C6D5",
      order_id: "ORD-2026-0901",
      run_mode: "production",
      order_scope_mode: "single",
    });
    expect(extraKeyP401.ok).toBe(false);
    expect(extraKeyP401.errors.map((e) => e.code)).toContain("P401_ORDER_SCOPE_MODE_FORBIDDEN");
  });

  it("accepts a maximum-length D1 composed name (80 + 1 + 80 = 161 UTF-16 code units) in P101 payload validator", () => {
    const maxFirstName = `${"A".repeat(78)}\u{1F31F}`; // 78 + 2 surrogate code units = 80 UTF-16 units
    const maxLastName = `${"B".repeat(78)}\u{1F680}`; // 78 + 2 surrogate code units = 80 UTF-16 units
    expect(maxFirstName.length).toBe(80);
    expect(maxLastName.length).toBe(80);

    const maxComposedName = `${maxFirstName} ${maxLastName}`;
    expect(maxComposedName.length).toBe(161);

    const built = buildP101Payload({
      customerRef: "RP-CUST-000008",
      orderReference: "RP-C000008-2608-MAXNAME",
      canonVersion: "ReadyPackets_Production_v2.0",
      runMode: "production",
      clientName: maxComposedName,
      clientEmail: "maxname@readypackets.com",
      releaseStatus: "",
      packets: [{ packetNumber: 1, tier: "Standard" }],
      otherItemCount: 0,
    });

    expect(built.ok).toBe(true);
    expect(built.errors).toEqual([]);
    expect(built.payload?.client_name).toBe(maxComposedName);
    expect(built.payload?.client_name.length).toBe(161);

    const revalidated = validateP101(built.payload);
    expect(revalidated.ok).toBe(true);
    expect(revalidated.payload?.client_name).toBe(maxComposedName);
  });
});
