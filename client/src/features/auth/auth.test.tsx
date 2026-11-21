import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeResult } from "@/lib/authApi";
import { clearRecoveryBatch } from "@/lib/recoveryBatch";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { recoveryCodesText } from "./components/RecoveryCodesPanel";
import ActivatePage from "./pages/ActivatePage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import MfaChallengePage from "./pages/MfaChallengePage";
import MfaEnrolPage, { groupKey } from "./pages/MfaEnrolPage";
import RecoveryCodesPage from "./pages/RecoveryCodesPage";
import RegisterPage from "./pages/RegisterPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import SignInPage, { SIGN_IN_FAILED } from "./pages/SignInPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";

const remediationMe = (nextStep: MeResult["nextStep"]): MeResult => ({
  user: { publicId: "u1", role: "customer", name: "Avery Example", email: "avery@example.test", status: "active" },
  state: "remediation",
  pendingSteps: nextStep ? [nextStep] : [],
  nextStep,
});
const assurance = { mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true, recoveryCodesRemaining: 10 };
const LONG_PASSWORD = "correct horse battery staple";

function type(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("auth screens — accessibility (axe, WCAG 2.2 A/AA rules; contrast covered by tokens.test)", () => {
  const cases: Array<[string, () => React.ReactElement, string]> = [
    ["sign-in", () => <SignInPage />, "/sign-in"],
    ["register", () => <RegisterPage />, "/register"],
    ["forgot-password", () => <ForgotPasswordPage />, "/forgot-password"],
    ["reset-password (token)", () => <ResetPasswordPage />, "/reset-password?token=abc"],
    ["reset-password (no token)", () => <ResetPasswordPage />, "/reset-password"],
    ["activate", () => <ActivatePage />, "/activate?token=abc"],
    ["verify-email (no token)", () => <VerifyEmailPage />, "/verify-email"],
    ["change-password", () => <ChangePasswordPage />, "/change-password"],
  ];
  for (const [name, el, path] of cases) {
    it(`${name} has no axe violations`, async () => {
      const { container } = renderUi(el(), { path, api: fakeAuthApi({ me: async () => remediationMe("change_password") }) });
      await screen.findByRole("heading", { level: 1 });
      await expectNoAxeViolations(container);
    });
  }

  it("mfa challenge and enrolment have no axe violations", async () => {
    const api = fakeAuthApi({
      me: async () => remediationMe("mfa_challenge"),
      assuranceState: async () => ({ ...assurance, passkeyCount: 1 }),
      beginTotpEnrollment: async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    const a = renderUi(<MfaChallengePage />, { path: "/mfa", api });
    await screen.findByRole("radiogroup");
    await expectNoAxeViolations(a.container);
    a.unmount();
    const b = renderUi(<MfaEnrolPage />, { path: "/mfa/enrol", api: { ...api, me: async () => remediationMe("enroll_mfa") } });
    await screen.findByText("JBSW Y3DP EHPK 3PXP");
    await expectNoAxeViolations(b.container);
  });
});

describe("sign-in behaviour", () => {
  it("shows one uniform, announced message for any credential failure (no account enumeration)", async () => {
    for (const domainCode of ["INVALID_CREDENTIALS", "ACCOUNT_LOCKED", "NOT_FOUND"]) {
      const err = Object.assign(new Error("server text that must not leak"), { data: { safe: { domainCode } } });
      const { unmount } = renderUi(<SignInPage />, { path: "/sign-in", api: fakeAuthApi({ signIn: async () => Promise.reject(err) }) });
      type(/^email/i, "who@example.test");
      type(/^password/i, "x");
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(await screen.findByText(SIGN_IN_FAILED)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent("server text that must not leak");
      unmount();
    }
  });

  it("validates empty fields locally without calling the server", async () => {
    const signIn = vi.fn();
    renderUi(<SignInPage />, { path: "/sign-in", api: fakeAuthApi({ signIn }) });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/enter your email and password/i)).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("navigates to the next transition step returned by the server", async () => {
    const { location } = renderUi(<SignInPage />, {
      path: "/sign-in",
      api: fakeAuthApi({ signIn: async () => ({ nextStep: "mfa_challenge" }), me: async () => remediationMe("mfa_challenge") }),
    });
    type(/^email/i, "who@example.test");
    type(/^password/i, LONG_PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe("/mfa"));
  });

  it("ignores an unsafe ?next= destination (open-redirect guard)", async () => {
    const me = remediationMe(null);
    const { location } = renderUi(<SignInPage />, {
      path: "/sign-in?next=//evil.example",
      api: fakeAuthApi({ signIn: async () => ({ nextStep: null }), me: async () => ({ ...me, state: "full" }) }),
    });
    type(/^email/i, "who@example.test");
    type(/^password/i, LONG_PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe("/"));
  });

  it("forced change: names the temporary password, and a wrong one is reported on that field, not on the new password", async () => {
    const changePassword = vi.fn(async () => {
      throw Object.assign(new Error("denied"), {
        data: { safe: { domainCode: "VALIDATION", reasonCode: "CURRENT_PASSWORD_INCORRECT", safeMessage: "Your current password is incorrect." } },
      });
    });
    const { container } = renderUi(<ChangePasswordPage />, {
      path: "/change-password",
      api: fakeAuthApi({ me: async () => remediationMe("change_password"), changePassword }),
    });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/haven't used here before/i)).not.toBeInTheDocument();
    const temporary = screen.getByLabelText(/^Temporary password/);
    expect(temporary).toHaveAttribute("autocomplete", "current-password");
    expect(temporary).toHaveAccessibleDescription(/just signed in with/i);
    // The sign-in name is present for password managers, and invisible to everyone else.
    await waitFor(() => expect(container.querySelector('input[autocomplete="username"]')).toHaveValue("avery@example.test"));
    expect(container.querySelector('input[autocomplete="username"]')).toHaveAttribute("aria-hidden", "true");
    type(/^Temporary password/, "a password saved for the old site");
    type(/^New password/, LONG_PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith({ currentPassword: "a password saved for the old site", newPassword: LONG_PASSWORD }));
    await waitFor(() => expect(temporary).toHaveAttribute("aria-invalid", "true"));
    expect(temporary).toHaveAccessibleDescription(/not the temporary password you signed in with/i);
    expect(screen.getByLabelText(/^New password/)).not.toHaveAttribute("aria-invalid", "true");
    await expectNoAxeViolations(container);
  });

  it("password show/hide toggle is a labelled button that flips the input type and allows paste", () => {
    renderUi(<SignInPage />, { path: "/sign-in" });
    const input = screen.getByLabelText(/^password/i);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).not.toHaveAttribute("onpaste");
    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input).toHaveAttribute("type", "text");
  });

  it("offers a Create an account link", () => {
    renderUi(<SignInPage />, { path: "/sign-in" });
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");
  });
});

describe("account recovery flows", () => {
  it("forgot-password returns the same accepted message and shows the preview link callout", async () => {
    renderUi(<ForgotPasswordPage />, { path: "/forgot-password", api: fakeAuthApi({ requestPasswordReset: async () => ({ accepted: true, previewLink: "/reset-password?token=t1" }) }) });
    type(/^email/i, "who@example.test");
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
    expect(await screen.findByRole("heading", { name: /check your email/i })).toBeInTheDocument();
    expect(screen.getByText(/a password reset link is on its way/i)).toBeInTheDocument();
    expect(screen.getByText(/preview environment/i)).toBeInTheDocument();
  });

  it("reset-password strips the token from the URL and rejects short passwords locally", async () => {
    const resetPassword = vi.fn(async () => ({ accepted: true as const }));
    window.history.replaceState(null, "", "/reset-password?token=secret-token");
    renderUi(<ResetPasswordPage />, { path: "/reset-password?token=secret-token", api: fakeAuthApi({ resetPassword }) });
    await waitFor(() => expect(window.location.search).not.toContain("secret-token"));
    type(/new password/i, "short");
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByText(/please choose a longer password/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
    type(/new password/i, LONG_PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(await screen.findByRole("heading", { name: /password updated/i })).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledWith({ token: "secret-token", password: LONG_PASSWORD });
  });

  it("verify-email calls the server exactly once per token", async () => {
    const verifyEmail = vi.fn(async () => ({ accepted: true as const }));
    renderUi(<VerifyEmailPage />, { path: "/verify-email?token=v1", api: fakeAuthApi({ verifyEmail }) });
    expect(await screen.findByRole("heading", { name: /email confirmed/i })).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledTimes(1);
  });
});

describe("MFA", () => {
  it("challenge offers passkey only when the user has one", async () => {
    const api = fakeAuthApi({ me: async () => remediationMe("mfa_challenge"), assuranceState: async () => assurance });
    renderUi(<MfaChallengePage />, { path: "/mfa", api });
    await screen.findByRole("radiogroup");
    expect(screen.queryByRole("radio", { name: /passkey/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /authenticator app/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /recovery code/i })).toBeInTheDocument();
  });

  it("enrolment → recovery codes shown once → explicit acknowledgment → continue", async () => {
    clearRecoveryBatch();
    const acknowledgeRecoveryCodes = vi.fn(async (_: { recoverySetId: string }) => ({ ok: true as const }));
    const codes = ["AAAAA-BBBBB", "CCCCC-DDDDD"];
    let step: MeResult["nextStep"] = "enroll_mfa";
    const api = fakeAuthApi({
      me: async () => remediationMe(step),
      beginTotpEnrollment: async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
      confirmTotpEnrollment: async () => {
        step = "acknowledge_recovery_codes";
        return { recoveryCodes: codes, recoverySetId: "set-1" };
      },
      acknowledgeRecoveryCodes,
    });
    const { location } = renderUi(<MfaEnrolPage />, { path: "/mfa/enrol", api });
    await screen.findByAltText(/qr code/i);
    type(/6-digit code/i, "123 456");
    fireEvent.click(screen.getByRole("button", { name: /verify and continue/i }));
    const list = await screen.findByRole("list", { name: /recovery codes/i });
    expect(list).toHaveTextContent("AAAAA-BBBBB");
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /i have saved/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(acknowledgeRecoveryCodes).toHaveBeenCalledWith({ recoverySetId: "set-1" });
    await waitFor(() => expect(location.history?.at(-1)).toBe("/"));
  });

  it("never calls beginTotpEnrollment again after confirmation (remount with a staged batch or TOTP already set)", async () => {
    clearRecoveryBatch();
    let step: MeResult["nextStep"] = "enroll_mfa";
    const beginTotpEnrollment = vi.fn(async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
    const api = fakeAuthApi({
      me: async () => remediationMe(step),
      beginTotpEnrollment,
      confirmTotpEnrollment: async () => {
        step = "acknowledge_recovery_codes";
        return { recoveryCodes: ["AAAAA-BBBBB"], recoverySetId: "set-1" };
      },
    });
    const first = renderUi(<MfaEnrolPage />, { path: "/mfa/enrol", api });
    await screen.findByAltText(/qr code/i);
    type(/6-digit code/i, "123456");
    fireEvent.click(screen.getByRole("button", { name: /verify and continue/i }));
    await screen.findByRole("list", { name: /recovery codes/i });
    first.unmount();
    // Remount (as after the session refresh) while the batch is staged.
    const second = renderUi(<MfaEnrolPage />, { path: "/mfa/enrol", api });
    await screen.findByRole("list", { name: /recovery codes/i });
    second.unmount();
    // Batch gone, but the session says TOTP is already set.
    clearRecoveryBatch();
    const third = renderUi(<MfaEnrolPage />, { path: "/mfa/enrol", api });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    third.unmount();
    expect(beginTotpEnrollment).toHaveBeenCalledTimes(1);
  });

  it("recovery-codes page without a staged batch asks to verify for a reissue", async () => {
    clearRecoveryBatch();
    renderUi(<RecoveryCodesPage />, { path: "/mfa/recovery-codes", api: fakeAuthApi({ assuranceState: async () => assurance }) });
    expect(await screen.findByRole("heading", { name: /get new recovery codes/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /issue new codes/i })).toBeInTheDocument();
  });

  it("helpers format the setup key and the downloadable text file", () => {
    expect(groupKey("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    const text = recoveryCodesText(["A", "B"], new Date("2026-01-01T00:00:00Z"));
    expect(text).toContain("2026-01-01T00:00:00.000Z");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["A", "B"]));
  });
});
