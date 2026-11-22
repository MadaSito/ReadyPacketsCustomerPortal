import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DataTable } from "@/ui";
import { expectNoAxeViolations, renderUi } from "./testing";

interface Row {
  id: string;
  name: string;
  locked?: boolean;
}
const rows: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma", locked: true },
];

function Demo({ onChange }: { onChange?: (keys: string[]) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  return (
    <DataTable
      caption="Workflows"
      rows={rows}
      rowKey={(r) => r.id}
      columns={[{ key: "name", header: "Name", primary: true, cell: (r) => r.name }]}
      selection={{
        selectedKeys: sel,
        onSelectedKeysChange: (next) => {
          setSel(next);
          onChange?.([...next].sort());
        },
        rowLabel: (r) => `Select workflow ${r.name}`,
        isSelectable: (r) => !r.locked,
        noun: "workflows",
      }}
    />
  );
}

describe("DataTable selection", () => {
  it("selects rows, toggles all selectable rows with a mixed state and announces the count", async () => {
    const user = userEvent.setup();
    const seen: string[][] = [];
    const { container } = renderUi(<Demo onChange={(k) => seen.push(k)} />);
    const table = screen.getByRole("table");
    const all = within(table).getByRole("checkbox", { name: "Select all workflows on this page" });
    expect(within(table).getByRole("checkbox", { name: "Select workflow Gamma" })).toBeDisabled();
    await user.click(within(table).getByRole("checkbox", { name: "Select workflow Alpha" }));
    expect(all).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("1 of 2 workflows selected")).toBeInTheDocument();
    await user.click(all);
    expect(seen.at(-1)).toEqual(["a", "b"]);
    expect(all).toHaveAttribute("aria-checked", "true");
    await user.click(all);
    expect(seen.at(-1)).toEqual([]);
    const list = screen.getByRole("list", { name: "Workflows" });
    expect(within(list).getByRole("checkbox", { name: "Select workflow Beta" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
