import { expect, it } from "vitest";
import { safariInstall } from "./pwaInstallState";

const desktopSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15";
const mobileSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1";

it("separates iPhone and iPad (including desktop mode) from Add to Dock", () => {
  expect(safariInstall(mobileSafari, "iPhone", 5)).toBe("ios");
  expect(safariInstall(desktopSafari, "MacIntel", 5)).toBe("ios");
  expect(safariInstall(desktopSafari, "MacIntel", 0)).toBe("mac");
  expect(safariInstall(desktopSafari.replace("Version/17.2", "Version/16.5"), "MacIntel", 0)).toBeNull();
});

it("does not show Safari instructions in Chromium or iOS Firefox", () => {
  expect(safariInstall(desktopSafari.replace("Version/17.2", "Chrome/129.0"), "MacIntel", 0)).toBeNull();
  expect(safariInstall(mobileSafari.replace("Version/17.2", "FxiOS/130.0"), "iPhone", 5)).toBeNull();
});
