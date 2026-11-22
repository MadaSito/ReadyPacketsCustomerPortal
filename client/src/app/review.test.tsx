import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PublicPresentation } from "@/lib/authApi";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contrastRatio } from "@/ui/tokens";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import RegisterPage from "@/features/auth/pages/RegisterPage";
import { previewNavigate, splitHash } from "./AppRouter";
import { IDLE_DEFAULTS, absoluteWarningDelay, idleLimitMs, warnBeforeFor } from "./IdleTimeout";
import { PublicFrame } from "./shell/PublicFrame";

// Partial mock: keep every real export (new slots stay defined) and silence the network-backed feature slots.
vi.mock("./slots", async (importOriginal) => {
  const real = await importOriginal<typeof import("./slots")>();
  const silent = Object.fromEntries(Object.keys(real).filter((name) => name.endsWith("Slot")).map((name) => [name, () => null]));
  return { ...real, ...silent };
});

const presentation = (preview: boolean): PublicPresentation => ({ slides: [], slideshow: { autoAdvance: false, intervalSeconds: 8 }, supportText: "", announcement: null, preview });

describe("preview banner (H-3)", () => {
  it("shows a permanent, non-dismissible banner when the server reports the preview profile", async () => {
    renderUi(
      <PublicFrame>
        <h1>x</h1>
      </PublicFrame>,
      { api: fakeAuthApi({ presentation: async () => presentation(true) }) },
    );
    const banner = await screen.findByTestId("preview-banner");
    expect(banner).toHaveTextContent(/synthetic data only/i);
    expect(banner.querySelector("button")).toBeNull();
  });

  it("is absent in the standard profile", async () => {
    renderUi(
      <PublicFrame>
        <h1>x</h1>
      </PublicFrame>,
      { api: fakeAuthApi({ presentation: async () => presentation(false) }) },
    );
    await act(async () => {});
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });
});

describe("register is uniform (C-04)", () => {
  it("never renders a preview verification link, whether or not the server returned one", async () => {
    for (const result of [{ accepted: true as const, previewLink: "/verify-email?token=leak" }, { accepted: true as const }]) {
      const { unmount, container } = renderUi(<RegisterPage />, { path: "/register", api: fakeAuthApi({ register: async () => result, presentation: async () => presentation(true) }) });
      fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: "Avery" } });
      fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: "a@example.test" } });
      fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "correct horse battery staple" } });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: /create/i }));
      await screen.findByRole("heading", { name: /check your email/i });
      expect(container.innerHTML).not.toContain("token=leak");
      expect(screen.queryByRole("link", { name: /verification link/i })).toBeNull();
      unmount();
    }
  });
});

describe("preview hash URLs (C-05)", () => {
  it("navigation writes path and query into the hash and clears stale document search", () => {
    window.history.replaceState(null, "", "/app/?next=%2Fold#/sign-in");
    previewNavigate("/reset-password?token=t");
    expect(window.location.search).toBe("");
    expect(splitHash(window.location.hash, window.location.search)).toEqual({ path: "/reset-password", search: "token=t" });
    previewNavigate("/orders", { replace: true });
    expect(splitHash(window.location.hash, window.location.search)).toEqual({ path: "/orders", search: "" });
  });
});

describe("idle timeout follows server policy", () => {
  it("uses idleTimeoutSeconds when valid, else the fallback; warning never exceeds half the limit", () => {
    expect(idleLimitMs(900)).toBe(900_000);
    expect(idleLimitMs(undefined)).toBe(IDLE_DEFAULTS.idleMs);
    expect(idleLimitMs(5)).toBe(IDLE_DEFAULTS.idleMs);
    expect(warnBeforeFor(30 * 60_000)).toBe(120_000);
    expect(warnBeforeFor(120_000)).toBe(60_000);
  });

  it("schedules the absolute-expiry warning 2 minutes before expiry", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(absoluteWarningDelay("2026-11-20T12:10:00Z", now)).toBe(8 * 60_000);
    expect(absoluteWarningDelay("2026-11-20T12:01:00Z", now)).toBe(0);
    expect(absoluteWarningDelay("2026-11-20T11:59:00Z", now)).toBeNull();
    expect(absoluteWarningDelay("garbage", now)).toBeNull();
    expect(absoluteWarningDelay(undefined, now)).toBeNull();
  });
});

describe("focus ring on navy surfaces", () => {
  it("teal-light focus ring (.rp-on-navy) keeps ≥ 3:1 against navy and navy-elevated in both themes", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../styles/index.css"), "utf8");
    const values = (name: string) => [...css.matchAll(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]!);
    const [ringLight, ringDark] = values("teal-light");
    const [navyLight, navyDark] = values("navy");
    const [elevLight, elevDark] = values("navy-elevated");
    for (const [ring, bg] of [[ringLight, navyLight], [ringLight, elevLight], [ringDark, navyDark], [ringDark, elevDark]] as const) {
      expect(contrastRatio(ring!, bg!)).toBeGreaterThanOrEqual(3);
    }
    expect(css).toContain(".rp-on-navy { --color-focus: var(--color-teal-light); }");
  });
});
