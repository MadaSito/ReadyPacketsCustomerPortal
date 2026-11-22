import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Package } from "lucide-react";
import {
  Checklist,
  FilterBar,
  LoadMore,
  checklistSummary,
  CodeSamples,
  CopyField,
  EmptyState,
  Pagination,
  pageWindow,
  PhaseRail,
  SegmentedControl,
  StatCard,
  StatGrid,
  TagInput,
  ThemeControl,
  Timeline,
} from "@/ui";
import { expectNoAxeViolations, renderUi } from "./testing";

describe("SegmentedControl / ThemeControl", () => {
  it("is a radio group with one tab stop and arrow-key selection", async () => {
    const user = userEvent.setup();
    function Demo() {
      const [v, setV] = useState<"a" | "b" | "c">("a");
      return <SegmentedControl label="View" value={v} onValueChange={setV} options={[{ value: "a", label: "List" }, { value: "b", label: "Board" }, { value: "c", label: "Calendar" }]} />;
    }
    const { container } = renderUi(<Demo />);
    const group = screen.getByRole("radiogroup", { name: "View" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Board" }));
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Calendar" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
    await expectNoAxeViolations(container);
  });

  it("ThemeControl switches the html dark class; compact keeps names", async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<ThemeControl variant="compact" />);
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement).not.toHaveClass("dark");
    await expectNoAxeViolations(container);
  });
});

describe("PhaseRail / Checklist", () => {
  it("gives state in text and marks the current step", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = renderUi(
      <PhaseRail
        label="Order phases"
        onStepSelect={onSelect}
        steps={[
          { key: "intake", label: "Intake", state: "done" },
          { key: "draft", label: "Drafting", state: "current" },
          { key: "file", label: "Filing", state: "locked" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Order phases" });
    const items = within(list).getAllByRole("listitem");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[2]).toHaveTextContent("Step 3 of 3: Filing, locked");
    await user.click(screen.getByRole("button", { name: /Intake, completed/ }));
    expect(onSelect).toHaveBeenCalledWith("intake");
    await expectNoAxeViolations(container);
  });

  it("summarises required items and ignores optional ones", async () => {
    const items = [
      { key: "a", label: "Upload ID", state: "done" as const },
      { key: "b", label: "Accept terms", state: "todo" as const },
      { key: "c", label: "Notes", state: "optional" as const },
    ];
    expect(checklistSummary(items)).toBe("1 of 2 done");
    const { container } = renderUi(<Checklist title="Before the next step" items={items} />);
    expect(screen.getByText("1 of 2 done")).toHaveAttribute("role", "status");
    expect(screen.getByText("Accept terms").closest("p")).toHaveTextContent("To do: Accept terms");
    await expectNoAxeViolations(container);
  });
});

describe("Display components", () => {
  it("StatCard, Timeline, CodeSamples and EmptyState pass axe", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    const { container } = renderUi(
      <div>
        <StatGrid label="Referral totals">
          <StatCard label="Total referrals" value={12} icon={Package} tone="info" />
          <StatCard label="Pending" value={3} href="/account/referrals" hint="Awaiting first payment" />
        </StatGrid>
        <Timeline label="History" items={[{ key: "1", title: "Order placed", time: "2026-11-01T10:00:00Z", actor: "Ana" }, { key: "2", title: "Paid", time: "2026-11-02T10:00:00Z" }]} />
        <CodeSamples label="Examples" samples={[{ key: "curl", label: "curl", code: "curl https://example.test", language: "shell" }, { key: "js", label: "JavaScript", code: "fetch('/api/v1')" }]} />
        <EmptyState variant="filtered" title="No matches" onClearFilters={onClear} headingLevel={3} />
      </div>,
    );
    expect(screen.getByRole("list", { name: "History, newest first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pending/ })).toHaveAttribute("href", "/account/referrals");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it("Pagination works in both modes", async () => {
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    const onPage = vi.fn();
    const user = userEvent.setup();
    const { container, unmount } = renderUi(<Pagination label="Orders pages" page={1} pageCount={3} onPageChange={onPage} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPage).toHaveBeenCalledWith(2);
    await expectNoAxeViolations(container);
    unmount();
    const onNext = vi.fn();
    renderUi(<Pagination label="Log pages" hasPrevious={false} hasNext onPrevious={() => {}} onNext={onNext} summary="Showing 1–50" />);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onNext).toHaveBeenCalled();
    expect(screen.getByText("Showing 1–50")).toHaveAttribute("role", "status");
  });
});

describe("Inputs", () => {
  it("CopyField masks a secret until shown", async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<CopyField label="API key" value="rpk_live_abcdef123456" secret monospace />);
    const input = screen.getByRole("textbox", { name: "API key" });
    expect(input).not.toHaveValue("rpk_live_abcdef123456");
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(input).toHaveValue("rpk_live_abcdef123456");
    expect(screen.getByRole("button", { name: "Copy api key" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("TagInput adds, refuses duplicates, removes by button and Backspace", async () => {
    const user = userEvent.setup();
    function Demo() {
      const [tags, setTags] = useState<string[]>(["billing"]);
      return <TagInput label="Tags" value={tags} onValueChange={setTags} max={3} />;
    }
    const { container } = renderUi(<Demo />);
    const input = screen.getByRole("textbox", { name: "Tags" });
    await user.type(input, "Refunds{Enter}");
    expect(screen.getByText("refunds")).toBeInTheDocument();
    expect(screen.getByText("Added refunds.")).toHaveAttribute("role", "status");
    await user.type(input, "billing,");
    expect(screen.getByText('"billing" is already added.')).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Remove tag billing" }));
    expect(screen.queryByRole("button", { name: "Remove tag billing" })).toBeNull();
    await user.type(input, "{Backspace}");
    expect(screen.queryByText("refunds")).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("labels the FilterBar search landmark so it stays unique beside the shell search", () => {
    renderUi(<FilterBar search="" onSearchChange={() => {}} searchLabel="Search orders" />);
    expect(screen.getByRole("search", { name: "Search orders" })).toBeInTheDocument();
  });

  it("LoadMore moves focus to its summary when the final page removes the focused button", async () => {
    const user = userEvent.setup();
    function Pager() {
      const [pages, setPages] = useState(1);
      return <LoadMore hasMore={pages < 2} onLoadMore={() => setPages(2)} summary={`Showing ${pages * 25} records`} />;
    }
    renderUi(<Pager />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Load more" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByText("Showing 50 records")).toHaveFocus();
  });
});
