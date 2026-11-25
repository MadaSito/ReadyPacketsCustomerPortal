import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowWebhookOptionView } from "@server/modules/integrations/workflowWebhooks/types";
import type * as TrpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { PhaseWebhookSlot, type PhaseWebhookSlotValue } from "./phaseSlots";

const subscriptionId = "01JD0000000000000000000091";
const optionsFixture: WorkflowWebhookOptionView[] = [
  {
    targetKey: "production:P101",
    kind: "production",
    phase: "P101",
    subscriptionPublicId: null,
    label: "Phase I intake (P101)",
    configured: true,
    enabled: true,
    signingEnabled: true,
    portableRef: "production:P101",
  },
  {
    targetKey: "production:P201",
    kind: "production",
    phase: "P201",
    subscriptionPublicId: null,
    label: "Phase II start (P201)",
    configured: true,
    enabled: false,
    signingEnabled: false,
    portableRef: "production:P201",
  },
  {
    targetKey: `subscription:${subscriptionId}`,
    kind: "subscription",
    phase: null,
    subscriptionPublicId: subscriptionId,
    label: "Fulfilment outbox",
    configured: true,
    enabled: true,
    signingEnabled: true,
    portableRef: "Fulfilment outbox",
  },
];

vi.mock("@/lib/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  useTRPC: () => ({
    integrations: {
      workflowWebhooks: {
        listOptions: {
          queryOptions: () => ({
            queryKey: ["integrations", "workflowWebhooks", "listOptions"],
            queryFn: async () => optionsFixture,
          }),
        },
      },
    },
  }),
}));

describe("PhaseWebhookSlot", () => {
  const baseProps = {
    stageKey: "intake",
    stageIndex: 0,
    stageStatusKeys: ["paid"],
    workflowStatusKeys: ["paid", "in_review"],
    idPrefix: "phase-intake",
    disabled: false,
    headingLevel: 3 as const,
    errors: {},
  };

  it("defaults to None, emits targetKey or null, warns when target is paused, and never renders URLs or secrets", async () => {
    const onChange = vi.fn();
    function ControlledHarness() {
      const [current, setCurrent] = useState<PhaseWebhookSlotValue>(null);
      return (
        <PhaseWebhookSlot
          {...baseProps}
          value={current}
          onChange={(next) => {
            onChange(next);
            setCurrent(next);
          }}
        />
      );
    }

    renderUi(<ControlledHarness />);

    const select = screen.getByLabelText("Webhook trigger") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(await screen.findByRole("option", { name: /Fulfilment outbox/ })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "production:P201" } });
    expect(onChange).toHaveBeenCalledWith("production:P201");

    expect(
      await screen.findByText(/Selected webhook target is paused or switched off/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Requires a delivered P101 dispatch and a locked Phase 1 intake/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:\/\/|whsec_/i);

    fireEvent.change(screen.getByLabelText("Webhook trigger"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("preserves an unavailable saved target key, respects disabled, and renders server validation errors", async () => {
    const missingKey = "subscription:01JD0000000000000000000099";
    renderUi(
      <PhaseWebhookSlot
        {...baseProps}
        disabled
        value={missingKey}
        errors={{ "": "Choose an active webhook destination." }}
        onChange={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: /Fulfilment outbox/ });
    const select = screen.getByLabelText("Webhook trigger") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe(missingKey);
    expect(screen.getByText("Choose an active webhook destination.")).toBeInTheDocument();
    expect(screen.getByText(/Selected webhook target was not found/)).toBeInTheDocument();
  });

  pageA11y("PhaseWebhookSlot inside phase form", async () => {
    document.title = "Edit workflow phase";
    renderUi(
      <main id="main">
        <h1>Edit workflow phase</h1>
        <h2>Outbound webhook</h2>
        <PhaseWebhookSlot
          {...baseProps}
          value={`subscription:${subscriptionId}`}
          onChange={vi.fn()}
        />
      </main>,
    );
    await screen.findByText("HMAC-SHA256 signed");
  });
});
