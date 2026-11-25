import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { shouldRegisterServiceWorker, UpdateAvailablePrompt } from "./PwaUpdatePrompt";

describe("PWA update prompt (07.2)", () => {
  it("registers the worker only in a supported production build", () => {
    expect(shouldRegisterServiceWorker({ dev: false, preview: false, supported: true })).toBe(true);
    expect(shouldRegisterServiceWorker({ dev: true, preview: false, supported: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ dev: false, preview: true, supported: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ dev: false, preview: false, supported: false })).toBe(false);
  });

  it("explains the server update, what Reload and Later do, and is a named status with 44px buttons", async () => {
    const onReload = vi.fn();
    const { container } = renderUi(<UpdateAvailablePrompt onReload={onReload} />);
    const prompt = screen.getByRole("status", { name: "ReadyPackets was updated on the server" });
    expect(prompt).toHaveTextContent("This tab is still running the previous version.");
    expect(prompt).toHaveTextContent("Reload switches to the new version; you stay signed in, but unsaved input on this page is lost.");
    expect(prompt).toHaveTextContent("Later keeps the previous version in this tab until you reload.");
    expect(prompt).not.toHaveTextContent(/A new version of ReadyPackets is available/);
    // Above the phone tab bar below md, bottom-right corner from md (where the tab bar is hidden).
    expect(prompt.className).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom))]");
    expect(prompt.className).toContain("md:bottom-5");
    const later = within(prompt).getByRole("button", { name: "Later" });
    const reload = within(prompt).getByRole("button", { name: "Reload" });
    for (const b of [later, reload]) expect(b.className).toContain("min-h-11");
    reload.focus();
    expect(reload).toHaveFocus();
    fireEvent.click(reload);
    expect(onReload).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });

  it("Later hides it only until the next in-app navigation; it never reloads by itself", () => {
    const onReload = vi.fn();
    const { location } = renderUi(<UpdateAvailablePrompt onReload={onReload} />, { path: "/admin/workflows" });
    const navigate = (to: string) => location.navigate(to);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("pwa-update-prompt")).toBeNull();
    act(() => navigate("/admin/orders"));
    expect(screen.getByTestId("pwa-update-prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("pwa-update-prompt")).toBeNull();
    // Returning to a page dismissed earlier still counts as a navigation.
    act(() => navigate("/admin/workflows"));
    expect(screen.getByTestId("pwa-update-prompt")).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
  });
});
