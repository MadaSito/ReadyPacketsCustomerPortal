import { describe, expect, it } from "vitest";
import { emptyValue, parseNumberInput, serverFieldErrors, validateValue, withChild, type SettingFieldDescription } from "./fieldForm";

const base = { required: true, nullable: false } as const;
const obj: SettingFieldDescription = {
  ...base, type: "object", label: "X",
  fields: [
    { ...base, key: "n", type: "integer", label: "N", minimum: 1, maximum: 5 },
    { ...base, key: "s", type: "string", label: "S", maxLength: 3, required: false, nullable: true },
    { ...base, key: "list", type: "array", label: "L", maxItems: 2, uniqueItems: true, items: { ...base, type: "enum", label: "L", options: [{ value: "a", label: "A" }] } },
  ],
};

describe("fieldForm", () => {
  it("validates bounds, types, lists and required keys by dot path", () => {
    expect(validateValue(obj, { n: 3, list: ["a"] })).toEqual({});
    expect(validateValue(obj, { n: 9, s: "long", list: ["a", "a", "b"] })).toEqual({
      n: "Between 1 and 5.",
      s: "Enter at most 3 characters.",
      list: "Entries must be unique.",
      "list.2": "Choose one of the options.",
    });
    expect(validateValue(obj, { n: "x" })).toMatchObject({ n: "Enter a number.", list: "This field is required." });
    expect(validateValue(obj, null)).toEqual({ _: "This field is required." });
  });

  it("maps empties, numbers, children and server paths", () => {
    expect(emptyValue({ ...base, type: "string", label: "s" })).toBe("");
    expect(emptyValue({ ...base, type: "integer", label: "n", required: false, nullable: true })).toBeNull();
    expect(emptyValue({ ...base, type: "integer", label: "n", required: false })).toBeUndefined();
    expect(parseNumberInput(" 12 ")).toBe(12);
    expect(parseNumberInput("1e")).toBe("1e");
    expect(withChild({ a: 1, b: 2 }, "a", undefined)).toEqual({ b: 2 });
    expect(serverFieldErrors(["a.b", ""])).toEqual({ "a.b": "The server did not accept this value.", _: "The server did not accept this value." });
  });
});
