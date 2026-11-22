import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type * as SlotsModule from "./slots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME_QUERY_KEY, type MeResult } from "@/lib/authApi";
import { __resetRealmTaintForTests, __setHardNavigateForTests, cleanRealmPath, isRealmTainted, markRealmTainted, requestCleanRealm, subscribeRealmTaint } from "@/lib/realmTaint";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { authFeature } from "@/features/auth/routes";
import { AppRoutes } from "./AppRouter";
import { RealmTaintBoundary } from "./RealmTaint";

// Partial mock: keep every real export (new slots stay defined) and silence the network-backed feature slots.
vi.mock("./slots", async (importOriginal) => {
  const real = await importOriginal<typeof SlotsModule>();
  const silent = Object.fromEntries(Object.keys(real).filter((name) => name.endsWith("Slot")).map((name) => [name, () => null]));
  return { ...real, ...silent };
});

const unauthError = () => Object.assign(new Error("UNAUTHENTICATED"), { data: { safe: { domainCode: "UNAUTHENTICATED" } } });
const full: MeResult = {
  user: { publicId: "u1", role: "customer", name: "Avery Privatename", email: "avery@example.test", status: "active" },
  state: "full",
  pendingSteps: [],
  nextStep: null,
};

/** Records every element/text ever committed to the document, so a transient private render cannot slip by. */
function watchCommits() {
  const seen: string[] = [];
  const forms: Element[] = [];
  const navs: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        seen.push(node.textContent ?? "");
        if (node instanceof Element) {
          forms.push(...(node.matches("form") ? [node] : []), ...node.querySelectorAll("form"));
          const shellNav = "nav[aria-label='Primary'], nav[aria-label='Quick navigation'], a[aria-label='ReadyPackets home']";
          navs.push(...(node.matches(shellNav) ? [node] : []), ...node.querySelectorAll(shellNav));
        }
      }
      if (record.type === "characterData") seen.push(record.target.textContent ?? "");
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    text: () => seen.join("\n"),
    forms,
    navs,
    stop: () => observer.disconnect(),
  };
}

const app = () => (
  <RealmTaintBoundary>
    <AppRoutes routes={authFeature.routes} />
  </RealmTaintBoundary>
);

let navigations: Array<[string, string]>;
beforeEach(() => {
  __resetRealmTaintForTests();
  navigations = [];
  __setHardNavigateForTests((mode, url) => navigations.push([mode, url]));
});
afterEach(() => {
  cleanup(); // unmount before resetting module state, so no listener re-renders a dying tree
  __resetRealmTaintForTests();
  __setHardNavigateForTests(null);
  window.history.replaceState(null, "", "/");
});

describe("lib/realmTaint", () => {
  it("is a one-way, in-memory flag with subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRealmTaint(listener);
    expect(isRealmTainted()).toBe(false);
    markRealmTainted("posthog");
    markRealmTainted("posthog");
    expect(isRealmTainted()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("requests at most one clean-realm navigation and strips search/hash", () => {
    expect(requestCleanRealm("replace", "/privacy?token=abc#x")).toBe(true);
    expect(requestCleanRealm("assign", "/sign-in")).toBe(false);
    expect(navigations).toEqual([["replace", "/privacy"]]);
    expect(cleanRealmPath("//evil.example/x")).toBe("/");
    expect(cleanRealmPath("https://evil.example/")).toBe("/");
  });
});

describe("INT-01 render quarantine", () => {
  it("tainted + full session: the private shell never mounts; document is replaced once at the clean path", async () => {
    window.history.replaceState(null, "", "/privacy?utm=x#frag");
    markRealmTainted("clarity");
    const watch = watchCommits();
    renderUi(app(), { path: "/privacy", api: fakeAuthApi({ me: async () => full }) });
    expect(await screen.findByTestId("realm-reloading")).toHaveTextContent("Reloading securely…");
    await act(async () => {});
    watch.stop();
    expect(watch.text()).not.toContain("Avery Privatename");
    expect(watch.text()).not.toContain("avery@example.test");
    expect(watch.navs).toHaveLength(0);
    expect(navigations).toEqual([["replace", "/privacy"]]);
  });

  it("taint during an anonymous visit, then sign-in elsewhere: personalised UI never commits in this realm", async () => {
    window.history.replaceState(null, "", "/privacy");
    const watch = watchCommits();
    const { queryClient } = renderUi(app(), { path: "/privacy", api: fakeAuthApi({ me: () => Promise.reject(unauthError()) }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Portal privacy notice" })).toBeInTheDocument();
    act(() => markRealmTainted("clarity"));
    act(() => {
      queryClient.setQueryData(ME_QUERY_KEY, full);
    });
    expect(await screen.findByTestId("realm-reloading")).toBeInTheDocument();
    await act(async () => {});
    watch.stop();
    expect(watch.text()).not.toContain("Avery Privatename");
    expect(watch.navs).toHaveLength(0);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(navigations).toEqual([["replace", "/privacy"]]);
  });

  it("tainted + anonymous on /privacy and /terms: the public frame renders, no navigation", async () => {
    markRealmTainted("posthog");
    for (const [path, title] of [
      ["/privacy", "Portal privacy notice"],
      ["/terms", "Portal terms of use"],
    ] as const) {
      const view = renderUi(app(), { path, api: fakeAuthApi({ me: () => Promise.reject(unauthError()) }) });
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByRole("contentinfo")).toBeInTheDocument(); // PublicFrame footer
      expect(document.querySelector("nav[aria-label='Quick navigation']")).toBeNull();
      view.unmount();
    }
    expect(navigations).toEqual([]);
  });

  it("tainted: following the sign-in link performs a full navigation; the sign-in form never renders here", async () => {
    markRealmTainted("clarity");
    renderUi(app(), { path: "/privacy", api: fakeAuthApi({ me: () => Promise.reject(unauthError()) }) });
    await screen.findByRole("heading", { level: 1, name: "Portal privacy notice" });
    const watch = watchCommits();
    fireEvent.click(screen.getByRole("link", { name: "ReadyPackets sign in" }));
    await waitFor(() => expect(navigations).toEqual([["assign", "/sign-in"]]));
    await act(async () => {});
    watch.stop();
    expect(watch.forms).toHaveLength(0);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByTestId("realm-reloading")).toBeInTheDocument();
  });

  it("untainted realm is unaffected: a signed-in customer sees /privacy inside the customer shell", async () => {
    renderUi(app(), { path: "/privacy", api: fakeAuthApi({ me: async () => full }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Portal privacy notice" })).toBeInTheDocument();
    expect(navigations).toEqual([]);
    expect(screen.queryByTestId("realm-reloading")).toBeNull();
  });

  it("regression: an anonymous visitor on a public page that reads the session does not refetch-loop", async () => {
    const me = vi.fn(() => Promise.reject(unauthError()));
    renderUi(app(), { path: "/terms", api: fakeAuthApi({ me }) });
    await screen.findByRole("heading", { level: 1, name: "Portal terms of use" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(me).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: "Portal terms of use" })).toBeInTheDocument();
  });
});
