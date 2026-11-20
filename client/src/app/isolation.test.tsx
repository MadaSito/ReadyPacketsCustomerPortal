import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MeResult } from "@/lib/authApi";
import { ME_QUERY_KEY, useAuthApi } from "@/lib/authApi";
import { identityKey } from "@/lib/cacheIsolation";
import { useSignOut } from "@/lib/signOut";
import { DataTable } from "@/ui";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import MfaEnrolPage from "@/features/auth/pages/MfaEnrolPage";
import { splitHash } from "./AppRouter";
import { IdentityScope } from "./providers";

const meFor = (publicId: string, role: MeResult["user"]["role"] = "customer"): MeResult => ({
  user: { publicId, role, name: publicId, email: `${publicId}@example.test`, status: "active" },
  state: "full",
  pendingSteps: [],
  nextStep: null,
});
const unauthError = () => Object.assign(new Error("UNAUTHENTICATED"), { data: { safe: { domainCode: "UNAUTHENTICATED" } } });
const PRIVATE_KEY = ["rp", "orders", "list"];

function PrivateProbe() {
  const api = useAuthApi();
  const q = useQuery({ queryKey: PRIVATE_KEY, queryFn: () => api.presentation().then((p) => p.supportText) });
  return <p>data:{q.data ?? "none"}</p>;
}

describe("private cache isolation", () => {
  it("purges a previous user's private queries across A → 401 → B (same role) before rendering", async () => {
    let current: MeResult | Error = meFor("alice");
    let owner = "alice-private";
    const api = fakeAuthApi({
      me: async () => (current instanceof Error ? Promise.reject(current) : current),
      presentation: async () => ({ slides: [], slideshow: { autoAdvance: false, intervalSeconds: 8 }, supportText: owner, announcement: null }),
      assuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true, recoveryCodesRemaining: 9 }),
    });
    const { queryClient } = renderUi(
      <IdentityScope>
        <PrivateProbe />
      </IdentityScope>,
      { api },
    );
    expect(await screen.findByText("data:alice-private")).toBeInTheDocument();
    queryClient.setQueryData(["rp", "assurance", "state"], { secret: "alice" });

    current = unauthError();
    await act(() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    await waitFor(() => expect(queryClient.getQueryData(["rp", "assurance", "state"])).toBeUndefined());

    owner = "bob-private";
    current = meFor("bob");
    await act(() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    expect(await screen.findByText("data:bob-private")).toBeInTheDocument();
    expect(screen.queryByText("data:alice-private")).not.toBeInTheDocument();
  });

  it("purges on a direct cross-tab identity swap A → B without a 401 in between", async () => {
    let current = meFor("alice");
    let owner = "alice-private";
    const api = fakeAuthApi({
      me: async () => current,
      presentation: async () => ({ slides: [], slideshow: { autoAdvance: false, intervalSeconds: 8 }, supportText: owner, announcement: null }),
    });
    const { queryClient } = renderUi(
      <IdentityScope>
        <PrivateProbe />
      </IdentityScope>,
      { api },
    );
    expect(await screen.findByText("data:alice-private")).toBeInTheDocument();
    owner = "bob-private";
    current = meFor("bob");
    await act(() => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    expect(await screen.findByText("data:bob-private")).toBeInTheDocument();
  });

  it("identity key covers user, role and session state; unknown states keep the scope", () => {
    expect(identityKey(meFor("a"), "full")).not.toBe(identityKey(meFor("a", "admin"), "full"));
    expect(identityKey(undefined, "anonymous")).toBe("anonymous");
    expect(identityKey(undefined, "loading")).toBeUndefined();
    expect(identityKey(meFor("a"), "error")).toBeUndefined();
  });
});

describe("sign-out", () => {
  function SignOutButton() {
    const signOut = useSignOut();
    return <button onClick={() => void signOut()}>Sign out</button>;
  }

  it("does not pretend to sign out when revocation fails and the session is still live", async () => {
    const api = fakeAuthApi({ signOut: async () => Promise.reject(new Error("network")), me: async () => meFor("alice") });
    const { location, queryClient } = renderUi(<SignOutButton />, { api, path: "/orders" });
    queryClient.setQueryData(PRIVATE_KEY, "secret");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/sign-out didn't complete/i)).toBeInTheDocument();
    expect(location.history?.at(-1)).toBe("/orders");
    expect(queryClient.getQueryData(PRIVATE_KEY)).toBeUndefined();
  });

  it("navigates to sign-in after successful revocation", async () => {
    const api = fakeAuthApi({ signOut: async () => ({ ok: true }) as never });
    const { location } = renderUi(<SignOutButton />, { api, path: "/orders" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe("/sign-in"));
  });
});

describe("MFA enrolment secret handling", () => {
  it("keeps the TOTP seed out of the query and mutation caches", async () => {
    const api = fakeAuthApi({
      me: async () => ({ ...meFor("alice"), state: "remediation", nextStep: "enroll_mfa", pendingSteps: ["enroll_mfa"] }),
      beginTotpEnrollment: async () => ({ secret: "SEEDSEEDSEEDSEED", otpauthUri: "otpauth://totp/x?secret=SEEDSEEDSEEDSEED", qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    const { queryClient } = renderUi(<MfaEnrolPage />, { api, path: "/mfa/enrol" });
    await screen.findByText("SEED SEED SEED SEED");
    const dump = JSON.stringify([queryClient.getQueryCache().getAll().map((q) => q.state.data), queryClient.getMutationCache().getAll().map((m) => m.state.data)]);
    expect(dump).not.toContain("SEEDSEED");
  });
});

describe("DataTable mobile sorting", () => {
  it("offers sort controls sharing the desktop sort state", () => {
    const onSortChange = vi.fn();
    renderUi(
      <DataTable
        caption="Orders"
        columns={[
          { key: "name", header: "Name", cell: (r: { id: string }) => r.id, sortable: true, primary: true },
          { key: "date", header: "Date", cell: () => "today", sortable: true },
        ]}
        rows={[{ id: "a" }]}
        rowKey={(r) => r.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "date" } });
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "date", direction: "asc" });
    fireEvent.click(screen.getByRole("button", { name: /reverse the order/i }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", direction: "desc" });
    expect(screen.getByRole("region", { name: "Orders table" })).toHaveAttribute("tabindex", "0");
  });
});

describe("preview hash routing", () => {
  it("splits a query typed inside the hash from the path", () => {
    expect(splitHash("#/reset-password?token=abc", "")).toEqual({ path: "/reset-password", search: "token=abc" });
    expect(splitHash("#/orders", "?next=%2Fx")).toEqual({ path: "/orders", search: "next=%2Fx" });
    expect(splitHash("", "")).toEqual({ path: "/", search: "" });
  });
});
