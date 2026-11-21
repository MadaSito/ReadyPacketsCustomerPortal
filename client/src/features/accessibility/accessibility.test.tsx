import { screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import type { MeResult } from "@/lib/authApi";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { accessibilityFeature } from "./routes";

vi.mock("@/app/slots", () => ({ NotificationSlot: () => null, GlobalSearchSlot: () => null, AnalyticsConsentSlot: () => null }));

const anonymous = () => Promise.reject(Object.assign(new Error("UNAUTHENTICATED"), { data: { safe: { domainCode: "UNAUTHENTICATED" } } }));
const customer: MeResult = {
  user: { publicId: "u1", role: "customer", name: "Avery Example", email: "a@example.test", status: "active" },
  state: "full",
  pendingSteps: [],
  nextStep: null,
};

for (const [role, me] of [["anonymous", anonymous], ["customer", async () => customer]] as const) {
  pageA11y(`/accessibility as ${role}`, async () => {
    const { location } = renderUi(<AppRoutes routes={accessibilityFeature.routes} />, { path: "/accessibility", api: fakeAuthApi({ me }) });
    await screen.findByRole("heading", { level: 1, name: "Accessibility" });
    expect(location.history?.at(-1)).toBe("/accessibility");
    expect(document.title).toContain("Accessibility");
    expect(screen.getByRole("link", { name: "info@readypackets.com" })).toHaveAttribute("href", "mailto:info@readypackets.com");
    expect(screen.getByText(/designed and tested against WCAG 2\.2 AA/)).toBeVisible();
  });
}
