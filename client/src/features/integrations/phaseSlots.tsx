/**
 * Increment 07 Package K (D7) — `PhaseWebhookSlot` for the shared workflow phase form (`@/ui/phases/slotTypes`).
 *
 * Rendered inside the phase editor's Webhook region via lazy glob in `client/src/app/slots.tsx`.
 * Controlled only — zero network writes. Never displays webhook URLs, hostnames, or signing secrets.
 */
import { useQuery } from "@tanstack/react-query";
import type { WorkflowWebhookOptionView } from "@server/modules/integrations/workflowWebhooks/types";
import { useTRPC } from "@/lib/trpc";
import { Badge, Callout, Field, Select } from "@/ui";
import type { PhaseSlotProps, PhaseWebhookSlotValue } from "@/ui/phases/slotTypes";

export type { PhaseWebhookSlotValue };

const EMPTY_ERRORS: Readonly<Record<string, string>> = {};

function formatOptionLabel(option: WorkflowWebhookOptionView): string {
  const kindPrefix = option.kind === "production" ? "Production pipeline" : "Subscription";
  const readiness = !option.configured
    ? " — not configured"
    : !option.enabled
      ? " — paused or switched off"
      : "";
  return `${kindPrefix}: ${option.label}${readiness}`;
}

export function PhaseWebhookSlot({
  value,
  onChange,
  idPrefix = "phase-webhook",
  disabled = false,
  errors = EMPTY_ERRORS,
}: PhaseSlotProps<PhaseWebhookSlotValue>) {
  const trpc = useTRPC();
  const optionsQuery = useQuery(
    trpc.integrations.workflowWebhooks.listOptions.queryOptions(
      { kind: "all" },
      { retry: false, staleTime: 30_000 },
    ),
  );

  const options = optionsQuery.data ?? [];
  const selectedKey = value ?? "";
  const selectedOption = selectedKey
    ? options.find((item) => item.targetKey === selectedKey) ?? null
    : null;

  const selectOptions = [
    { value: "", label: "None" },
    ...options.map((option) => ({
      value: option.targetKey,
      label: formatOptionLabel(option),
    })),
    ...(selectedKey && !selectedOption
      ? [
          {
            value: selectedKey,
            label: `${selectedKey} — target no longer available`,
          },
        ]
      : []),
  ];

  const selectId = `${idPrefix}-webhook-target`;
  const fieldError = errors[""] ?? errors.webhookTargetKey;

  return (
    <div className="min-w-0 space-y-3">
      <Field
        id={selectId}
        label="Webhook trigger"
        hint="Optional managed production phase endpoint or outbound webhook subscription queued when phase actions run."
        error={fieldError}
      >
        <Select
          disabled={disabled}
          value={selectedKey}
          options={selectOptions}
          onChange={(event) => {
            const next = event.target.value.trim();
            onChange(next ? next : null);
          }}
        />
      </Field>

      {selectedOption ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge
            tone={
              !selectedOption.configured
                ? "warning"
                : selectedOption.enabled
                  ? "success"
                  : "neutral"
            }
          >
            {!selectedOption.configured
              ? "Not configured"
              : selectedOption.enabled
                ? "Ready"
                : "Paused or switched off"}
          </Badge>
          <Badge tone={selectedOption.signingEnabled ? "info" : "neutral"}>
            {selectedOption.signingEnabled ? "HMAC-SHA256 signed" : "Unsigned"}
          </Badge>
          {selectedOption.phase === "P201" ? (
            <span>Requires a delivered P101 dispatch and a locked Phase 1 intake.</span>
          ) : null}
        </div>
      ) : null}

      {selectedOption && (!selectedOption.configured || !selectedOption.enabled) ? (
        <Callout
          tone="warning"
          title={
            !selectedOption.configured
              ? "Selected webhook target is not configured"
              : "Selected webhook target is paused or switched off"
          }
        >
          {!selectedOption.configured
            ? "An administrator must configure the destination URL in Integrations before phase runs can deliver to this target."
            : "This target is currently paused or disabled in Integrations. Phase runs will record a skipped or disabled outcome until it is turned on."}
        </Callout>
      ) : null}

      {selectedKey && !optionsQuery.isPending && !selectedOption ? (
        <Callout tone="warning" title="Selected webhook target was not found">
          Choose an active production endpoint or webhook subscription, or select None before publishing this workflow.
        </Callout>
      ) : null}
    </div>
  );
}
