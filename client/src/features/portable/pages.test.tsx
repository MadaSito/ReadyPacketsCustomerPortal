// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import ImportDetails from "./pages/ImportDetails";
import NewExport from "./pages/NewExport";
import Transfers from "./pages/Transfers";

const ID = "01JAFJ8VEGZ9GPVRR2S9KTYZME";
const when = new Date("2025-03-01T12:00:00.000Z");
const detail = {
  phase: "reconciled", state: "completed",
  planDigest: "a".repeat(64), planExpiresAt: when,
  plan: { counts: { creates: 2, links: 0, conflicts: 0, heldUnknown: 1 }, samples: [] },
  reconciliation: { inventory: 3, imported: 2, linked: 0, heldUnknown: 1, verifiedObjects: 1, objects: 1, discrepancies: 0 },
  held: [{ type: "policy-acceptances", portableId: ID, reasonCode: "PORTABLE_HISTORICAL_EVIDENCE" }],
  steps: [{ phase: "reconciled", operationId: ID, occurredAt: when }],
};

vi.mock("@/lib/trpc", () => {
  const empty = { items: [], nextCursor: null };
  const query = (key: string, result: unknown) => ({
    queryOptions: (_input: unknown, options: object) => ({
      ...options, queryKey: ["portable-test", key], queryFn: async () => result,
    }),
  });
  return {
    errorMessage: (_error: unknown, fallback: string) => fallback,
    useTRPCClient: () => ({}),
    useTRPC: () => ({ portable: { admin: {
      listExports: query("exports", empty), listImports: query("imports", empty), getImport: query("detail", detail),
    } } }),
  };
});

afterEach(cleanup);

describe("portable administrative screens", () => {
  it("shows both histories with a labeled quarantine upload control", async () => {
    const { container } = renderUi(<Transfers />, { path: "/admin/portable" });
    await screen.findByText("No exports yet");
    await expectNoAxeViolations(container);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Imports" }), { button: 0, ctrlKey: false });
    await screen.findByText("No imports yet");
    expect(screen.getByRole("button", { name: "Upload to quarantine" })).toHaveProperty("disabled", true);
    await expectNoAxeViolations(container);
  });

  it("moves focus to the export review step and labels both password fields", async () => {
    const { container } = renderUi(<NewExport />, { path: "/admin/portable/export/new" });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose scope" }));
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review and encrypt" }));
    expect(screen.getByLabelText(/^Transfer passphrase/)).toHaveProperty("type", "password");
    expect(screen.getByLabelText(/^Confirm transfer passphrase/)).toHaveProperty("type", "password");
    await expectNoAxeViolations(container);
  });

  it("lists held content and reconciliation and requires an explicit acceptance attestation", async () => {
    const { container } = renderUi(<ImportDetails />, { path: `/admin/portable/import/${ID}` });
    await screen.findByRole("heading", { name: "Reconciliation" });
    expect(screen.getByRole("heading", { name: "Held content" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Import progress" })).toBeTruthy();
    const accept = screen.getByRole("button", { name: "Accept reconciled import" });
    expect(accept).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /independently confirmed/ }));
    expect(accept).toHaveProperty("disabled", false);
    await expectNoAxeViolations(container);
  });
});
