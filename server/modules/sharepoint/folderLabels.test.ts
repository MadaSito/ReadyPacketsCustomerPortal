import { describe, expect, it } from "vitest";
import { SEGMENT_MAX, cleanText, customerFolderLabel, disambiguate, labelKey, orderFolderLabel, safeSegment } from "./folderLabels.js";

const graphemeCount = (s: string) => Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(s)).length;

describe("folder labels", () => {
  it("builds customer labels from the first two first-name characters, full last name and reference", () => {
    expect(customerFolderLabel({ firstName: "Avery", lastName: "Example", customerReference: "CUST-0042" })).toBe("AvExample_CUST-0042");
    expect(customerFolderLabel({ firstName: "Mary Ann", lastName: "O'Brien-Smith", customerReference: "C 7" })).toBe("MaOBrienSmith_C-7");
    expect(customerFolderLabel({ firstName: null, lastName: "Example", customerReference: null })).toBe("Example");
    expect(customerFolderLabel({ firstName: null, lastName: null, customerReference: null })).toBe("Customer");
    expect(customerFolderLabel({ firstName: "<>", lastName: "**", customerReference: "R1" })).toBe("Customer_R1");
  });

  it("keeps Unicode letters, never splits grapheme clusters, and normalises to NFC", () => {
    expect(customerFolderLabel({ firstName: "Zoë", lastName: "Ångström", customerReference: "R-1" })).toBe("ZoÅngström_R-1");
    // decomposed input (e + combining diaeresis) is composed first
    expect(customerFolderLabel({ firstName: "E\u0308lise", lastName: "Doe", customerReference: null })).toBe("\u00cblDoe");
    expect(customerFolderLabel({ firstName: "李小龍", lastName: "王", customerReference: "X" })).toBe("李小王_X");
    expect(customerFolderLabel({ firstName: "\u{1F469}\u200D\u{1F4BB}ab", lastName: "Q", customerReference: null })).toBe("abQ");
  });

  it("removes control, bidi and invalid path characters", () => {
    expect(cleanText("a\u202Eb\u0000c\u200Bd", 80)).toBe("abcd");
    expect(orderFolderLabel({ reference: "RP-2026-0001", projectName: "../../etc/passwd" })).toBe("RP-2026-0001 etc passwd");
    expect(orderFolderLabel({ reference: "RP-1", projectName: 'A:"B"*<C>?|D\\E' })).toBe("RP-1 A B C D E");
    expect(orderFolderLabel({ reference: "RP-1", projectName: "  ...trailing dots...  " })).toBe("RP-1 trailing dots");
    expect(orderFolderLabel({ reference: "RP-1", projectName: null })).toBe("RP-1");
    expect(orderFolderLabel({ reference: "", projectName: "" })).toBe("Order");
  });

  it("guards reserved names", () => {
    expect(safeSegment("CON")).toBe("_CON");
    expect(safeSegment("lpt1.txt")).toBe("_lpt1.txt");
    expect(safeSegment("my_vti_folder")).toBe("_my_vti_folder");
    expect(safeSegment("")).toBe("Folder");
  });

  it("bounds length in graphemes", () => {
    const label = orderFolderLabel({ reference: "RP-2026-0001", projectName: "é".repeat(500) });
    expect(graphemeCount(label)).toBeLessThanOrEqual(SEGMENT_MAX);
    const long = customerFolderLabel({ firstName: "Al", lastName: "x".repeat(300), customerReference: "y".repeat(300) });
    expect(graphemeCount(long)).toBeLessThanOrEqual(SEGMENT_MAX);
    expect(long.startsWith("Alxxxx")).toBe(true);
  });

  it("disambiguates collisions case- and compatibility-insensitively", () => {
    const taken = new Set([labelKey("AvExample_CUST-1"), labelKey("avexample_cust-1 (2)")]);
    expect(disambiguate("AVEXAMPLE_CUST-1", (k) => taken.has(k))).toBe("AVEXAMPLE_CUST-1 (3)");
    expect(labelKey("Ｆｕｌｌ") === labelKey("full")).toBe(true);
    expect(disambiguate("Fresh", () => false)).toBe("Fresh");
    const long = "z".repeat(SEGMENT_MAX);
    const result = disambiguate(long, (k) => k === labelKey(long));
    expect(result.endsWith(" (2)")).toBe(true);
    expect(graphemeCount(result)).toBeLessThanOrEqual(SEGMENT_MAX);
    expect(() => disambiguate("x", () => true, 5)).toThrow();
  });
});
