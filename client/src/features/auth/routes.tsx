/** auth feature — public and transition screens. Owner: ui_foundation_engineer. */
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

export const authFeature: FeatureRoutes = {
  routes: [
    { path: "/sign-in", access: "public", title: "Sign in", component: lazy(() => import("./pages/SignInPage")) },
    { path: "/register", access: "public", title: "Create an account", component: lazy(() => import("./pages/RegisterPage")) },
    { path: "/forgot-password", access: "public", title: "Reset your password", component: lazy(() => import("./pages/ForgotPasswordPage")) },
    { path: "/reset-password", access: "public", title: "Choose a new password", component: lazy(() => import("./pages/ResetPasswordPage")) },
    { path: "/activate", access: "public", title: "Activate your account", component: lazy(() => import("./pages/ActivatePage")) },
    { path: "/verify-email", access: "public", title: "Confirm your email", component: lazy(() => import("./pages/VerifyEmailPage")) },
    { path: "/privacy", access: "public", title: "Portal privacy notice", component: lazy(() => import("./pages/PrivacyPage")) },
    { path: "/terms", access: "public", title: "Portal terms of use", component: lazy(() => import("./pages/TermsPage")) },
    { path: "/mfa", access: "transition", title: "Two-step verification", component: lazy(() => import("./pages/MfaChallengePage")) },
    { path: "/mfa/enrol", access: "transition", title: "Set up two-step verification", component: lazy(() => import("./pages/MfaEnrolPage")) },
    { path: "/mfa/recovery-codes", access: "transition", title: "Recovery codes", component: lazy(() => import("./pages/RecoveryCodesPage")) },
    { path: "/change-password", access: "transition", title: "Set a new password", component: lazy(() => import("./pages/ChangePasswordPage")) },
  ],
  nav: [],
};
