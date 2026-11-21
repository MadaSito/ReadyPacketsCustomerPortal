import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderUi } from "@/ui/testing";
import { expectAccessiblePage, pageA11y } from "./a11y";

function Example({ children }: { children?: ReactNode }) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Example · ReadyPackets";
    return () => { document.title = previousTitle; };
  }, []);
  return <main><h1>Example</h1>{children}</main>;
}

pageA11y("synthetic ready route", async (theme) => {
  renderUi(<Example />);
  expect(await screen.findByRole("heading", { level: 1, name: "Example" })).toBeVisible();
  expect(document.documentElement.style.colorScheme).toBe(theme);
});

it("rejects a spinner without a real page heading", async () => {
  renderUi(<main><span role="status">Loading page</span></main>);
  await expect(expectAccessiblePage("pending", "light")).rejects.toThrow("single h1");
});

it("detects an unnamed button in content portaled outside the rendered container", async () => {
  const lang = document.documentElement.getAttribute("lang");
  document.documentElement.lang = "en";
  try {
    renderUi(<Example>{createPortal(<div role="dialog" aria-label="Example dialog"><button type="button" /></div>, document.body)}</Example>);
    await expect(expectAccessiblePage("broken dialog", "light")).rejects.toThrow("button-name");
  } finally {
    if (lang === null) document.documentElement.removeAttribute("lang");
    else document.documentElement.lang = lang;
  }
});
