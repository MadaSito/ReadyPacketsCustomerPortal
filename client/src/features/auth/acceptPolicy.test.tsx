/** Increment 06 D13: the accept_policy transition screen (identity_engineer). */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import { STEP_PATHS, stepPath } from "@/app/guard";
import type { MeResult } from "@/lib/authApi";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import SignInPage from "./pages/SignInPage";
import { authFeature } from "./routes";

let slotFails = false;
vi.mock("@/app/slots", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CookieConsentSlot: () => null,
  CustomerMaintenanceSlot: () => null,
  SsoSignInSlot: () => null,
  PolicyRemediationSlot: () => (slotFails ? null : <section aria-labelledby="pol"><h2 id="pol">Terms of service, version 4</h2></section>),
}));

const me: MeResult = {
  user: { publicId: "u1", role: "customer", name: "Avery Example", email: "avery@example.test", status: "active" },
  state: "remediation",
  pendingSteps: ["accept_policy"],
  nextStep: "accept_policy",
};

function render(signOut = vi.fn(async () => ({}))) {
  renderUi(<AppRoutes routes={authFeature.routes} />, { path: "/accept-policy", api: fakeAuthApi({ me: async () => me, signOut }) });
  return signOut;
}

it("routes the accept_policy step to /accept-policy", () => {
  expect(stepPath("accept_policy")).toBe("/accept-policy");
  expect(STEP_PATHS.accept_policy).toEqual(["/accept-policy"]);
});

it("hosts the compliance forms and always offers Sign out, even when the forms fail to load", async () => {
  slotFails = true;
  const signOut = render();
  await screen.findByRole("heading", { level: 1, name: "Review and accept updated policy" });
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  slotFails = false;
});

pageA11y("/accept-policy", async () => {
  render();
  await screen.findByRole("heading", { level: 1, name: "Review and accept updated policy" });
  await screen.findByRole("heading", { level: 2, name: "Terms of service, version 4" });
});

it("D7: sign-in shows the retry countdown from a rate-limited response and never resubmits", async () => {
  const limited = Object.assign(new Error("rate limited"), {
    data: { safe: { domainCode: "RATE_LIMITED", reasonCode: "RATE_LIMITED", safeMessage: "Too many attempts. Please wait and try again." } },
    meta: { response: new Response(null, { status: 429, headers: { "Retry-After": "90" } }) },
  });
  const signIn = vi.fn(async () => Promise.reject(limited));
  renderUi(<SignInPage />, { path: "/sign-in", api: fakeAuthApi({ signIn }) });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "avery@example.test" } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "correct horse battery staple" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  expect(await screen.findByText("Try again in 1 min 30 sec.")).toBeInTheDocument();
  expect(signIn).toHaveBeenCalledTimes(1);
});
