# Page accessibility test API

Every new page gets an axe test in both themes before merge. Import `pageA11y(label: string, prepare: (theme: "light" | "dark") => void | Promise<void>): void` from `@/test/a11y` in the feature’s `*.test.tsx` file. Use a fresh render and synthetic fixtures for each test. It registers independent light and dark cases, emulates the corresponding system theme, asserts that the real theme provider applied it, and scans the full document, including any dialog mounted in a portal.

```tsx
import { screen } from "@testing-library/react";
import { AppRoutes } from "@/app/AppRouter";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { myFeature } from "./routes";

pageA11y("/example ready", async () => {
  renderUi(<AppRoutes routes={myFeature.routes} />, {
    path: "/example",
    api: fakeAuthApi(/* fixture with the intended role and access */),
  });
  await screen.findByRole("heading", { level: 1, name: "Example" });
});
```

Run `scripts/dev/test.sh client/src/features/<feature>/<suite>.test.tsx`. Do not make the suite concurrent, suppress failing rules, or scan only a child widget. Test permission, loading, empty and failure behavior separately; where a dialog or interactive state is central, exercise it with the keyboard and add another `pageA11y` case with that state open.

## How to pass

- **Page structure**: Render through `AppRoutes` when practical. Give the route a meaningful title and one `<h1>` inside its sole `<main>` landmark. Use `PageHeader`, then ordered headings. Wait for the actual page, not the loading skeleton or access-denied screen.
- **Keyboard**: Start at the skip link; confirm visible focus, a sensible tab order and focus at the new heading after navigation. Use labelled controls. Dialogs must trap focus, close on Escape and restore focus. Provide buttons for any drag action.
- **Forms and feedback**: Use `<Field>` and real inputs, appropriate `autocomplete`, errors associated with their fields, and live regions for feedback. Allow paste and password managers. Convey states in words, not just color.
- **Layout and contrast**: Test in both themes at 320 CSS px and 400% zoom. Targets must be at least 24 × 24 CSS px (44 px preferred on touch). Check actual colors: 4.5:1 for ordinary text and 3:1 for large text, UI components and focus indicators. A passing jsdom scan does not check those ratios or layout. Check text spacing, reduced motion and labelled scrolling regions too.
- **Record evidence**: Note the route, theme, state, tool, and result. Say “not checked” whenever you did not test a requirement. An axe pass is not a screen-reader test or certification. See the increment contract §4.2.
