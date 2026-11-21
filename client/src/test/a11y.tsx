/** Import only from tests. Never include axe or this harness in a production bundle. */
import { cleanup } from "@testing-library/react";
import axe from "axe-core";
import { expect, it, vi } from "vitest";
import type { ResolvedTheme } from "@/ui/theme";

export const PAGE_A11Y_THEMES = ["light", "dark"] as const satisfies readonly ResolvedTheme[];
export const PAGE_A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] as const;

export async function expectAccessiblePage(label: string, theme: ResolvedTheme): Promise<void> {
  const root = document.documentElement;
  expect(root.classList.contains("dark"), `${label}: actual document theme`).toBe(theme === "dark");
  const landmarks = root.querySelectorAll("main, [role='main']");
  expect(landmarks, `${label}: main landmark`).toHaveLength(1);
  const headings = root.querySelectorAll("h1");
  expect(headings, `${label}: single h1`).toHaveLength(1);
  expect(landmarks[0]).toContainElement(headings[0] ?? null);
  expect(headings[0]).toBeVisible();
  expect(document.title.trim(), `${label}: nonempty page title`).not.toBe("");

  const { violations } = await axe.run(document, {
    runOnly: { type: "tag", values: [...PAGE_A11Y_TAGS] },
    rules: { "color-contrast": { enabled: false } }, // jsdom has no layout or reliable computed color contrast.
  });
  const summary = violations.map(({ id, help, nodes }) => `${id}: ${help} (${nodes.map(({ target }) => target.join(" ")).join(", ")})`);
  if (summary.length) throw new Error(`${label} (${theme}): axe violations\n${summary.join("\n")}`);
}

/** Registers two independent test cases. `prepare` must render a ready page and await its heading or data. */
export function pageA11y(label: string, prepare: (theme: ResolvedTheme) => void | Promise<void>): void {
  for (const theme of PAGE_A11Y_THEMES) {
    it(`${label} has no page-level axe violations (${theme})`, async () => {
      const root = document.documentElement;
      const previous = { dark: root.classList.contains("dark"), scheme: root.style.colorScheme, lang: root.getAttribute("lang"), title: document.title };
      const themeColor = document.querySelector('meta[name="theme-color"]');
      const previousThemeColor = themeColor?.getAttribute("content");
      const originalMedia = window.matchMedia.bind(window);
      const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
        const fallback = originalMedia(query);
        if (query === "(prefers-color-scheme: dark)") {
          Object.defineProperty(fallback, "matches", { value: theme === "dark", configurable: true });
        }
        return fallback;
      });
      try {
        // jsdom does not load client/index.html. Real-browser QA checks the actual document language.
        if (!root.hasAttribute("lang")) root.lang = "en";
        document.title = "";
        await prepare(theme);
        await expectAccessiblePage(label, theme);
      } finally {
        cleanup();
        media.mockRestore();
        root.classList.toggle("dark", previous.dark);
        root.style.colorScheme = previous.scheme;
        if (previous.lang === null) root.removeAttribute("lang");
        else root.setAttribute("lang", previous.lang);
        if (previousThemeColor === null || previousThemeColor === undefined) themeColor?.removeAttribute("content");
        else themeColor?.setAttribute("content", previousThemeColor);
        document.title = previous.title;
      }
    });
  }
}
