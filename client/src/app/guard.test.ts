import { describe, expect, it } from "vitest";
import { TRANSITION_STEPS } from "@shared/domain";
import { decideRoute, safeNextPath, stepPath, type SessionView } from "./guard";

const anon: SessionView = { status: "anonymous" };
const full = (role: "customer" | "staff" | "admin"): SessionView => ({ status: "full", role });

describe("route guard", () => {
  it("loading never renders protected content", () => {
    for (const access of ["public", "transition", "customer", "staff", "admin"] as const) expect(decideRoute(access, "/x", { status: "loading" }).kind).toBe("loading");
  });
  it("anonymous: public renders, everything else goes to sign-in with a safe next", () => {
    expect(decideRoute("public", "/sign-in", anon)).toEqual({ kind: "render" });
    expect(decideRoute("customer", "/orders/01H", anon)).toEqual({ kind: "redirect", to: "/sign-in?next=%2Forders%2F01H" });
    expect(decideRoute("customer", "/", anon)).toEqual({ kind: "redirect", to: "/sign-in" });
    expect(decideRoute("admin", "/admin/audit", anon)).toEqual({ kind: "redirect", to: "/sign-in?next=%2Fadmin%2Faudit" });
    expect(decideRoute("transition", "/mfa", anon)).toEqual({ kind: "redirect", to: "/sign-in" });
  });
  it("remediation: always the nextStep screen, never data, no loops", () => {
    for (const step of TRANSITION_STEPS) {
      const s: SessionView = { status: "remediation", role: "customer", nextStep: step };
      const target = stepPath(step);
      expect(decideRoute("transition", target, s)).toEqual({ kind: "render" });
      for (const [access, path] of [["customer", "/orders"], ["staff", "/admin"], ["admin", "/admin/siem"], ["public", "/sign-in"], ["transition", "/change-password-other"]] as const) {
        const d = decideRoute(access, path, s);
        expect(d).toEqual({ kind: "redirect", to: target });
        // following the redirect renders (no loop)
        expect(decideRoute("transition", (d as { to: string }).to, s)).toEqual({ kind: "render" });
      }
    }
    const staffRem: SessionView = { status: "remediation", role: "admin", nextStep: "mfa_challenge" };
    expect(decideRoute("admin", "/admin", staffRem)).toEqual({ kind: "redirect", to: "/mfa" });
  });
  it("wrong transition screen redirects to the correct one", () => {
    const s: SessionView = { status: "remediation", role: "customer", nextStep: "enroll_mfa" };
    expect(decideRoute("transition", "/mfa", s)).toEqual({ kind: "redirect", to: "/mfa/enrol" });
    const ack: SessionView = { status: "remediation", role: "customer", nextStep: "acknowledge_recovery_codes" };
    expect(decideRoute("transition", "/mfa/enrol", ack)).toEqual({ kind: "render" });
  });
  it("full session: transition and entry screens redirect home; role gates", () => {
    expect(decideRoute("transition", "/mfa", full("customer"))).toEqual({ kind: "redirect", to: "/" });
    expect(decideRoute("public", "/sign-in", full("admin"))).toEqual({ kind: "redirect", to: "/admin" });
    expect(decideRoute("public", "/privacy", full("customer"))).toEqual({ kind: "render" });
    expect(decideRoute("customer", "/orders", full("customer"))).toEqual({ kind: "render" });
    expect(decideRoute("staff", "/admin", full("customer"))).toEqual({ kind: "not-found" });
    expect(decideRoute("staff", "/admin", full("staff"))).toEqual({ kind: "render" });
    expect(decideRoute("admin", "/admin/siem", full("staff"))).toEqual({ kind: "not-found" });
    expect(decideRoute("admin", "/admin/siem", full("admin"))).toEqual({ kind: "render" });
  });
  it("server unavailable never renders protected screens", () => {
    expect(decideRoute("customer", "/orders", { status: "error" })).toEqual({ kind: "unavailable" });
    expect(decideRoute("public", "/sign-in", { status: "error" })).toEqual({ kind: "render" });
  });
  it("safeNextPath rejects open redirects and auth screens", () => {
    for (const bad of ["https://evil.example.test", "//evil.example.test", "/\\evil", "javascript:alert(1)", "/sign-in", "/mfa", "/x\u0000"]) expect(safeNextPath(bad)).toBeNull();
    expect(safeNextPath("/orders/01H?tab=files")).toBe("/orders/01H?tab=files");
  });
});
