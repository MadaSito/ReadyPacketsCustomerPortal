import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useLocation } from "wouter";
import { RouteTabPanel, RouteTabs, routeTabId, type RouteTabItem } from "./index";
import { expectNoAxeViolations, renderUi } from "./testing";

const base = "/admin/orders/ORD1";
const labels = ["Overview", "Phases", "Intake", "Files", "Messages", "Automation", "SharePoint sync", "Invoices", "Refund", "Order history", "Acceptances", "Sharing"];
const items: RouteTabItem[] = labels.map((label, index) => {
  const value = index === 0 ? "overview" : label.toLowerCase().replace(/ /g, "-");
  return {
    value,
    label,
    href: index === 0 ? base : `${base}/${value}`,
    count: label === "SharePoint sync" ? 3 : label === "Acceptances" ? 120 : undefined,
    disabled: label === "Refund" ? true : undefined,
  };
});

function Page({ remount = false }: { remount?: boolean }) {
  const [path] = useLocation();
  const value = items.find((item) => item.href === path)?.value ?? "overview";
  return (
    <main>
      <h1>Order</h1>
      <RouteTabs key={remount ? value : "strip"} idBase="order-tabs" items={items} value={value} label="Order sections" />
      <RouteTabPanel idBase="order-tabs" value={value}>
        <p>Panel {value}</p>
      </RouteTabPanel>
    </main>
  );
}

describe("RouteTabs", () => {
  it("is one tablist of link tabs, each with its own URL, a single tab stop and a named panel", async () => {
    const { container } = renderUi(<Page />, { path: `${base}/files` });
    const lists = screen.getAllByRole("tablist");
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveAccessibleName("Order sections");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(12);
    expect(tabs.map((tab) => tab.textContent)).toEqual(labels.map((label) => (label === "SharePoint sync" ? "SharePoint sync3" : label === "Acceptances" ? "Acceptances99+" : label)));
    const files = screen.getByRole("tab", { name: "Files" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveAttribute("href", `${base}/files`);
    expect(screen.getByRole("tab", { name: "Phases" })).toHaveAttribute("href", `${base}/phases`);
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([files]);
    expect(screen.getByRole("tab", { name: "Refund" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("tabpanel", { name: "Files" })).toHaveTextContent("Panel files");
    expect(files).toHaveAttribute("aria-controls", "order-tabs-panel");
    await expectNoAxeViolations(container);
  });

  it("roving focus: arrows wrap and skip disabled tabs, Home/End, and only Enter or Space navigates", async () => {
    const user = userEvent.setup();
    const { location } = renderUi(<Page />, { path: `${base}/invoices` });
    await user.tab();
    expect(screen.getByRole("tab", { name: "Invoices" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Order history" })).toHaveFocus(); // Refund (disabled) skipped
    expect(location.history?.at(-1)).toBe(`${base}/invoices`); // arrowing does not navigate
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Sharing" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Sharing" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([screen.getByRole("tab", { name: "Overview" })]);
    await user.keyboard("{ArrowRight}{Enter}");
    await waitFor(() => expect(location.history?.at(-1)).toBe(`${base}/phases`));
    expect(screen.getByRole("tab", { name: "Phases" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight} ");
    await waitFor(() => expect(location.history?.at(-1)).toBe(`${base}/intake`));
    expect(screen.getByRole("tab", { name: "Intake" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Intake" })).toHaveTextContent("Panel intake");
  });

  it("keeps focus on the opened tab when the page remounts the strip on the URL change", async () => {
    const user = userEvent.setup();
    const { location } = renderUi(<Page remount />, { path: base });
    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    await waitFor(() => expect(location.history?.at(-1)).toBe(`${base}/intake`));
    await waitFor(() => expect(document.getElementById(routeTabId("order-tabs", "intake"))).toHaveFocus());
    await user.click(screen.getByRole("tab", { name: "Messages" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Messages" })).toHaveFocus());
    expect(location.history?.at(-1)).toBe(`${base}/messages`);
  });

  it("narrow screens: a labelled select lists the same tabs (with counts) and changes the route", async () => {
    const user = userEvent.setup();
    const { location } = renderUi(<Page />, { path: base });
    const select = screen.getByRole("combobox", { name: "Order sections" });
    expect(select).toHaveValue("overview");
    const options = Array.from((select as HTMLSelectElement).options);
    expect(options.map((option) => option.textContent)).toContain("SharePoint sync (3)");
    expect(options.find((option) => option.value === "refund")?.disabled).toBe(true);
    await user.selectOptions(select, "order-history");
    await waitFor(() => expect(location.history?.at(-1)).toBe(`${base}/order-history`));
    expect(select).toHaveValue("order-history");
  });

  it("scroll buttons are named pointer controls outside the Tab order and appear only on the overflowing side", async () => {
    renderUi(<Page />, { path: base });
    const list = screen.getByRole("tablist");
    const start = screen.getByRole("button", { name: "Scroll tabs left", hidden: true });
    const end = screen.getByRole("button", { name: "Scroll tabs right", hidden: true });
    for (const button of [start, end]) expect(button).toHaveAttribute("tabindex", "-1");
    // jsdom has no layout: nothing overflows, so both are hidden.
    expect(start).toHaveClass("hidden");
    expect(end).toHaveClass("hidden");
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: 1200 });
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 400 });
    act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(end).not.toHaveClass("hidden");
    expect(start).toHaveClass("hidden");
    act(() => {
      end.click();
    });
    expect(list.scrollLeft).toBeGreaterThan(0);
    expect(start).not.toHaveClass("hidden");
  });

  it("labelContent replaces the strip label (and its accessible name) while the select keeps the static label", () => {
    const live = items.map((item) => (item.value === "sharepoint-sync" ? { ...item, count: undefined, label: "File sync", labelContent: "SharePoint sync (2)" } : item));
    renderUi(<RouteTabs idBase="live" items={live} value="overview" label="Order sections" />, { path: base });
    expect(screen.getByRole("tab", { name: "SharePoint sync (2)" })).toHaveAttribute("href", `${base}/sharepoint-sync`);
    const options = Array.from((screen.getByRole("combobox", { name: "Order sections" }) as HTMLSelectElement).options);
    expect(options.map((option) => option.textContent)).toContain("File sync");
  });

  it("compact select: focus returns to the select when the page remounts on the route change", async () => {
    const user = userEvent.setup();
    const { location } = renderUi(<Page remount />, { path: base });
    await user.selectOptions(screen.getByRole("combobox", { name: "Order sections" }), "files");
    await waitFor(() => expect(location.history?.at(-1)).toBe(`${base}/files`));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Order sections" })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Order sections" })).toHaveValue("files");
  });

  it("an arrow-focused tab is scrolled clear of the overlaid scroll buttons", async () => {
    const user = userEvent.setup();
    renderUi(<Page />, { path: base });
    const list = screen.getByRole("tablist");
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({}) });
    list.getBoundingClientRect = () => rect(0, 400);
    screen.getByRole("tab", { name: "Phases" }).getBoundingClientRect = () => rect(330, 60); // right edge 390, under the right button
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Phases" })).toHaveFocus();
    expect(list.scrollLeft).toBe(30); // 390 - (400 - 40)
  });
});
