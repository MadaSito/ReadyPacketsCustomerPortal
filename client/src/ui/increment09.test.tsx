import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BRAND, BRAND_ASSET_VERSION, BRAND_ASSETS } from "@shared/brand";
import { BrandLogo, Button, ConfirmDialog, EmailLink, mailtoHref, TOAST_ACTION_MIN_DURATION, useToast } from "@/ui";
import { ThemeProvider } from "./theme";
import { expectNoAxeViolations, renderUi } from "./testing";

describe("increment 09 D1: EmailLink", () => {
  it("renders a mailto link whose text is the address, underlined and wrapping", async () => {
    renderUi(
      <p>
        Contact <EmailLink email=" zeus.greene@example.com " />
      </p>,
    );
    const link = screen.getByRole("link", { name: "zeus.greene@example.com" });
    expect(link).toHaveAttribute("href", "mailto:zeus.greene@example.com");
    expect(link.className).toContain("underline");
    expect(link.className).toContain("[overflow-wrap:anywhere]");
    await expectNoAxeViolations();
  });

  it("uses the visible text as the accessible name (no hidden override)", () => {
    renderUi(<EmailLink email="support@example.com">Email support@example.com</EmailLink>);
    const link = screen.getByRole("link", { name: "Email support@example.com" });
    expect(link).toHaveAttribute("href", "mailto:support@example.com");
    expect(link).not.toHaveAttribute("aria-label");
  });

  it.each([
    "zeus greene@example.com",
    "zeus@example.com?subject=x",
    "zeus@example.com&cc=a@b.c",
    "zeus@example.com\nBcc: a@b.c",
    "zeus@@example.com",
    "javascript:alert(1)@example.com",
    "zeus@localhost",
    "zeus@example..com",
    "zeus@example.com\u202e",
    "",
    `${"a".repeat(250)}@example.com`,
  ])("never links an unsafe or non-plain value: %j", (value) => {
    expect(mailtoHref(value)).toBeNull();
    renderUi(<EmailLink email={value}>{value || "none"}</EmailLink>);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

function ToastActionHarness({ onUndo, duration }: { onUndo: () => void; duration?: number }) {
  const toast = useToast();
  return (
    <Button onClick={() => toast.show({ tone: "success", title: "Order moved to trash", duration, action: { label: "Undo", onClick: onUndo } })}>Trash it</Button>
  );
}

describe("increment 09 D2.7: toast action", () => {
  it("renders a real button inside the live region that runs the action and dismisses the toast", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    renderUi(<ToastActionHarness onUndo={onUndo} />);
    await user.click(screen.getByRole("button", { name: "Trash it" }));
    const region = screen.getByRole("status");
    const undo = within(region).getByRole("button", { name: "Undo" });
    expect(undo.className).toContain("min-h-8");
    await expectNoAxeViolations();
    await user.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(within(region).queryByText("Order moved to trash")).toBeNull();
  });

  it("stays at least 10 seconds when an action is present", () => {
    vi.useFakeTimers();
    try {
      renderUi(<ToastActionHarness onUndo={() => {}} duration={3000} />);
      act(() => screen.getByRole("button", { name: "Trash it" }).click());
      act(() => vi.advanceTimersByTime(TOAST_ACTION_MIN_DURATION - 100));
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("increment 09 D3: BrandLogo (Document-Stack full lockups)", () => {
  it("defaults to the light square lockup with explicit size and the brand accessible name", () => {
    render(
      <ThemeProvider initial="light">
        <BrandLogo />
      </ThemeProvider>,
    );
    const img = screen.getByRole("img", { name: "ReadyPackets \u2014 Your Business, Professionally Packeted" });
    expect(img).toHaveAttribute("src", expect.stringMatching(/brand\/readypackets-square-light-v2026101502\.svg$/));
    expect(img).toHaveAttribute("width", "1024");
    expect(img).toHaveAttribute("height", "1024");
    expect(img).toHaveAttribute("data-brand-lockup", "square");
    expect(img.className).toContain("rp-brand-plate-light");
  });

  it("follows the resolved dark theme and gives the dark file its own forced-colours plate", () => {
    render(
      <ThemeProvider initial="dark">
        <BrandLogo lockup="horizontal" label="" />
      </ThemeProvider>,
    );
    const img = document.querySelector("img[data-brand-lockup]")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("src", expect.stringMatching(/brand\/readypackets-horizontal-dark-v2026101502\.svg$/));
    expect(img).toHaveAttribute("width", "2460");
    expect(img).toHaveAttribute("height", "680");
    expect(img).toHaveAttribute("data-brand-tone", "dark");
    expect(img.className).toContain("rp-brand-plate-dark");
    expect(img.className).not.toContain("rp-brand-plate-light");
  });

  it("uses the light file on a light surface even when the theme is dark (fixed appearance)", () => {
    render(
      <ThemeProvider initial="dark">
        <BrandLogo appearance="light" label="" />
      </ThemeProvider>,
    );
    const img = document.querySelector("img[data-brand-lockup]")!;
    expect(img).toHaveAttribute("src", expect.stringMatching(/square-light-v2026101502\.svg$/));
    expect(img.className).toContain("rp-brand-plate-light");
  });

  it("styles: every lockup plate keeps its own surface colour in forced-colours mode", () => {
    const css = readFileSync(resolve(ROOT, "client/src/styles/index.css"), "utf8");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.rp-brand-plate-dark[^{]*\{[^}]*forced-color-adjust: none;[^}]*var\(--color-navy\)/);
    expect(forced).toMatch(/\.rp-brand-plate-light \{[^}]*forced-color-adjust: none;[^}]*var\(--color-white\)/);
  });
});

const ROOT = resolve(import.meta.dirname, "../../..");
const PUBLIC = resolve(ROOT, "client/public");

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("increment 09 D3: served brand files", () => {
  const images = [
    ...(["light", "dark"] as const).flatMap((tone) => Object.values(BRAND_ASSETS[tone])),
    BRAND_ASSETS.mailLogo, BRAND_ASSETS.documentLogo, BRAND_ASSETS.shareImage,
    ...Object.values(BRAND_ASSETS.utility),
  ];

  it.each(images.map((image) => [image.path, image] as const))("%s exists with a versioned name and its declared size", (_path, image) => {
    expect(image.path).toMatch(new RegExp(`^brand/[a-z0-9-]+-${BRAND_ASSET_VERSION}\\.(svg|png|ico)$`));
    const file = resolve(PUBLIC, image.path);
    expect(existsSync(file)).toBe(true);
    if (image.path.endsWith(".png")) expect(pngSize(file)).toEqual([image.width, image.height]);
    if (image.path.endsWith(".svg")) {
      const svg = readFileSync(file, "utf8");
      expect(svg).toContain(`width="${image.width}" height="${image.height}"`);
    }
    // No 4096 px master or archive under the served root.
    expect(statSync(file).size).toBeLessThan(200_000);
  });

  it("served SVGs carry no active content or external references", () => {
    const svgs = readdirSync(resolve(PUBLIC, "brand")).filter((name) => name.endsWith(".svg"));
    expect(svgs.length).toBeGreaterThanOrEqual(4);
    for (const name of svgs) {
      const svg = readFileSync(resolve(PUBLIC, "brand", name), "utf8");
      expect(svg, name).not.toMatch(/<script|<foreignObject|<image|<use|<iframe|<object|<embed|@import|url\(|\bhref\s*=|javascript:|data:/i);
      expect(svg, name).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg.match(/https?:\/\/[^"]+/g) ?? []).toEqual(["http://www.w3.org/2000/svg"]);
    }
  });

  it("only versioned brand files are served; superseded artwork and masters are gone from the web root", () => {
    const names = readdirSync(resolve(PUBLIC, "brand"));
    expect(names.filter((name) => !name.includes(`-${BRAND_ASSET_VERSION}.`))).toEqual([]);
    expect(names.some((name) => /4096|8192|\.zip$/i.test(name))).toBe(false);
  });

  it("index.html, the manifest and the offline page reference the new package only", () => {
    const html = readFileSync(resolve(ROOT, "client/index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(PUBLIC, "manifest.webmanifest"), "utf8")) as { icons: { src: string; sizes: string; purpose: string }[] };
    const offline = readFileSync(resolve(PUBLIC, "offline.html"), "utf8");
    for (const text of [html, JSON.stringify(manifest), offline]) expect(text).not.toContain("readypackets-approved");
    expect(html).toContain(`brand/readypackets-utility-apple-touch-180-${BRAND_ASSET_VERSION}.png`);
    expect(html).toContain(`<meta property="og:image" content="%BASE_URL%${BRAND_ASSETS.shareImage.path}" />`);
    expect(html).toContain(`<meta name="twitter:image" content="%BASE_URL%${BRAND_ASSETS.shareImage.path}" />`);
    expect(manifest.icons).toEqual([
      { src: BRAND_ASSETS.light.squarePng192.path, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: BRAND_ASSETS.light.squarePng512.path, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: BRAND_ASSETS.utility.maskable512.path, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
    for (const icon of manifest.icons) expect(existsSync(resolve(PUBLIC, icon.src))).toBe(true);
    expect(offline).toContain(`/${BRAND_ASSETS.light.square.path}`);
    expect(offline).toContain(`/${BRAND_ASSETS.dark.square.path}`);
    expect(offline).toContain('width="1024" height="1024"');
  });

  it("the service worker uses a rotated precache name", () => {
    expect(readFileSync(resolve(ROOT, "client/src/pwa/sw.ts"), "utf8")).toContain('setCacheNameDetails({ precache: "precache-v4" })');
  });

  it("brand text: tagline with the exclamation mark and the documented accessible name", () => {
    expect(BRAND.tagline).toBe("Your Business, Professionally Packeted!\u2122");
    expect(BRAND.logoAccessibleName).toBe("ReadyPackets \u2014 Your Business, Professionally Packeted");
  });
});

function ConfirmFocusHarness() {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h2 ref={heading} tabIndex={-1}>Trash</h2>
      <Button onClick={() => setOpen(true)}>Restore</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Restore this order?" confirmLabel="Restore order" onConfirm={() => {}} returnFocusRef={heading} />
    </>
  );
}

describe("increment 09: ConfirmDialog returnFocusRef", () => {
  it("moves focus to the given element on close instead of the opener", async () => {
    const user = userEvent.setup();
    renderUi(<ConfirmFocusHarness />);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.click(await screen.findByRole("button", { name: "Restore order" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trash" })).toHaveFocus());
  });
});

describe("increment 09: selected tab survives forced colours", () => {
  it("marks the selected tab with a Highlight border distinct from the focus outline", () => {
    const css = readFileSync(resolve(ROOT, "client/src/styles/index.css"), "utf8");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\[role="tab"\]\[aria-selected="true"\] \{ color: Highlight; border-bottom: 3px solid Highlight; \}/);
    expect(forced).toMatch(/:focus-visible \{ outline: 3px solid CanvasText; \}/);
  });
});
