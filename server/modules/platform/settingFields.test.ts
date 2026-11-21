import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeSchema, describeSettingFields, humanizeKey } from "./settingFields.js";
import { defineSecret, defineSetting } from "./settingsRegistry.js";

describe("describeSchema", () => {
  it("describes scalars, enums, bounds, defaults, optional and nullable fields", () => {
    const schema = z.strictObject({
      host: z.string().min(1).max(253).describe("SMTP host name"),
      port: z.number().int().min(1).max(65535).default(587),
      ratio: z.number().gt(0).lt(1),
      tls: z.enum(["none", "starttls", "implicit"]),
      level: z.union([z.literal(1), z.literal(2)]),
      enabled: z.boolean(),
      note: z.string().max(40).nullable().optional(),
    });
    const field = describeSchema(schema, { label: "Mail transport", fields: { port: { label: "Port", help: "Usually 587." } } });
    expect(field).toMatchObject({ type: "object", label: "Mail transport", required: true, nullable: false });
    if (field.type !== "object") throw new Error("expected object");
    const byKey = Object.fromEntries(field.fields.map((f) => [f.key, f]));
    expect(byKey.host).toMatchObject({ type: "string", label: "Host", help: "SMTP host name", minLength: 1, maxLength: 253, required: true });
    expect(byKey.port).toMatchObject({ type: "integer", label: "Port", help: "Usually 587.", minimum: 1, maximum: 65535, default: 587, required: false });
    expect(byKey.ratio).toMatchObject({ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 });
    expect(byKey.tls).toMatchObject({ type: "enum", options: [{ value: "none" }, { value: "starttls" }, { value: "implicit", label: "Implicit" }] });
    expect(byKey.level).toMatchObject({ type: "enum", options: [{ value: 1 }, { value: 2 }] });
    expect(byKey.enabled).toMatchObject({ type: "boolean", required: true });
    expect(byKey.note).toMatchObject({ type: "string", nullable: true, required: false, maxLength: 40 });
  });

  it("describes nested objects with dot-path labels and arrays of scalars", () => {
    const schema = z.object({
      routing: z.object({ replyTo: z.email() }),
      domains: z.array(z.string().max(10)).max(5),
      tags: z.array(z.enum(["a", "b"])).min(1),
    });
    const field = describeSchema(schema, { label: "X", fields: { "routing.replyTo": { label: "Reply-to address" } } });
    if (field.type !== "object") throw new Error("expected object");
    const routing = field.fields.find((f) => f.key === "routing");
    expect(routing).toMatchObject({ type: "object", fields: [{ key: "replyTo", type: "string", label: "Reply-to address", format: "email" }] });
    expect(field.fields.find((f) => f.key === "domains")).toMatchObject({ type: "array", maxItems: 5, items: { type: "string", maxLength: 10 } });
    expect(field.fields.find((f) => f.key === "tags")).toMatchObject({ type: "array", minItems: 1, items: { type: "enum" } });
  });

  it("marks shapes a form cannot express as unsupported (JSON editor fallback)", () => {
    const schema = z.object({
      map: z.record(z.string(), z.number()),
      rows: z.array(z.object({ a: z.string() })),
      either: z.union([z.string(), z.number()]),
      tuple: z.tuple([z.string(), z.number()]),
    });
    const field = describeSchema(schema, { label: "X" });
    if (field.type !== "object") throw new Error("expected object");
    for (const f of field.fields) expect([f.key, f.type]).toEqual([f.key, "unsupported"]);
    expect(describeSchema(z.custom<string>(() => true), { label: "Y" }).type).toBe("unsupported");
  });

  it("treats a root boolean / number / string as a single field", () => {
    expect(describeSchema(z.boolean(), { label: "On" })).toMatchObject({ type: "boolean", label: "On", required: true });
    expect(describeSchema(z.number().int().min(0), { label: "N" })).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("humanizes keys", () => {
    expect(humanizeKey("retentionDays")).toBe("Retention days");
    expect(humanizeKey("audit_copy")).toBe("Audit copy");
  });
});

describe("defineSetting extras", () => {
  it("exposes descriptions for value settings only, never for secrets", () => {
    const value = defineSetting({
      key: "test_fields.sample",
      owner: "platform",
      group: "general",
      label: "Sample",
      description: "d",
      schema: z.strictObject({ days: z.number().int().min(1).max(30) }),
      default: { days: 7 },
      fields: { days: { label: "Days", help: "How long." } },
      writeCapability: "mail.manage",
      managedBy: { href: "/admin/mail", label: "E-mail delivery" },
    });
    expect(value.writeCapability).toBe("mail.manage");
    expect(describeSettingFields(value)).toMatchObject({ type: "object", fields: [{ key: "days", label: "Days", help: "How long." }] });
    const secret = defineSecret({ key: "test_fields.secret", owner: "platform", group: "general", label: "S", description: "d" });
    expect(describeSettingFields(secret)).toBeUndefined();
  });

  it("rejects bad field paths, unknown capabilities and off-console links", () => {
    const base = { owner: "platform", group: "general" as const, label: "L", description: "d", schema: z.number(), default: 1 };
    expect(() => defineSetting({ ...base, key: "test_fields.bad_path", fields: { "a..b": { label: "x" } } })).toThrow(/field path/);
    expect(() => defineSetting({ ...base, key: "test_fields.bad_cap", writeCapability: "nope" as never })).toThrow(/capability/);
    expect(() => defineSetting({ ...base, key: "test_fields.bad_href", managedBy: { href: "https://evil.example", label: "x" } })).toThrow(/href/);
    expect(() => defineSetting({ ...base, key: "test_fields.bad_href2", managedBy: { href: "//evil.example/admin", label: "x" } })).toThrow(/href/);
  });
});
