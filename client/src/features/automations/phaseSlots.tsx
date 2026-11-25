/**
 * Increment 07 Package G (D5) — `PhaseActionsSlot` for the shared workflow phase form (`@/ui/phases/slotTypes`).
 *
 * Rendered inside `<Region title="Administrator-run phase actions">` by `PhaseForm` via lazy glob in `app/slots.tsx`.
 * Edits the phase's `stageActions` bundle EXCEPT `webhookTargetKey` (owned by integrations `PhaseWebhookSlot`),
 * preserving any unknown keys in `onChange`. Controlled only — zero network writes.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { BUILT_IN_STATUS_CATALOG, type StatusCatalogItem } from "@shared/orderStatusCatalog";
import {
  STAGE_ALERT_SEVERITIES,
  STAGE_ALERT_TEXT_MAX,
  STAGE_COMPLETION_DELAY_MAX_MINUTES,
  type StageAlertSeverity,
  type StageCompletion,
} from "@shared/workflowStages";
import { useTRPC } from "@/lib/trpc";
import { Callout, Field, Input, Select, Textarea } from "@/ui";
import type { PhaseActionsSlotValue, PhaseSlotProps } from "@/ui/phases/slotTypes";
import { formatMinutes } from "./model";

interface PhaseMailTemplateOption {
  templateKey: string;
  name: string;
  vars?: readonly string[];
}

interface PhaseActionLookupBridge {
  mailTemplates: {
    listForPhaseActions: {
      queryOptions(
        input?: undefined,
        opts?: Record<string, unknown>,
      ): UseQueryOptions<PhaseMailTemplateOption[], unknown, PhaseMailTemplateOption[], readonly unknown[]>;
    };
  };
  orders: {
    statusCatalog: {
      list: {
        queryOptions(
          input?: { includeRetired?: boolean; includeUsage?: boolean },
          opts?: Record<string, unknown>,
        ): UseQueryOptions<StatusCatalogItem[], unknown, StatusCatalogItem[], readonly unknown[]>;
      };
    };
  };
}

const ALERT_SEVERITY_LABELS: Record<StageAlertSeverity, string> = {
  warning: "Warning",
  error: "Error",
  critical: "Critical",
};

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function PhaseActionsSlot({
  value,
  onChange,
  workflowStatusKeys,
  idPrefix,
  disabled,
  headingLevel,
  errors,
}: PhaseSlotProps<PhaseActionsSlotValue>) {
  const trpc = useTRPC() as unknown as PhaseActionLookupBridge;
  const templatesQuery = useQuery(
    trpc.mailTemplates.listForPhaseActions.queryOptions(undefined, { retry: false, staleTime: 60_000 }),
  );
  const statusesQuery = useQuery(
    trpc.orders.statusCatalog.list.queryOptions({ includeRetired: true }, { retry: false, staleTime: 60_000 }),
  );

  const id = (part: string) => `${idPrefix}-${part}`;
  const Heading = `h${headingLevel}` as const;

  const current = (value ?? {}) as PhaseActionsSlotValue & Record<string, unknown>;
  const {
    emailTemplateKey,
    setStatusKey,
    completion,
    dashboardAlert,
    ...unknownKeys
  } = current;

  const emit = (patch: {
    emailTemplateKey?: string | undefined;
    setStatusKey?: string | undefined;
    completion?: StageCompletion | undefined;
    dashboardAlert?: { severity: StageAlertSeverity; text: string } | undefined;
  }) => {
    const nextEmail = "emailTemplateKey" in patch ? patch.emailTemplateKey : emailTemplateKey;
    const nextStatus = "setStatusKey" in patch ? patch.setStatusKey : setStatusKey;
    const nextCompletion = "completion" in patch ? patch.completion : completion;
    const nextAlert = "dashboardAlert" in patch ? patch.dashboardAlert : dashboardAlert;

    const next: Record<string, unknown> = { ...unknownKeys };
    if (nextEmail) next.emailTemplateKey = nextEmail;
    if (nextStatus) next.setStatusKey = nextStatus;
    if (nextCompletion) next.completion = nextCompletion;
    if (nextAlert) next.dashboardAlert = nextAlert;
    onChange(next as PhaseActionsSlotValue);
  };

  /* ---- 1. Customer e-mail options ---- */
  const templateItems = templatesQuery.data ?? [];
  const emailOptions = [
    { value: "", label: "No customer e-mail" },
    ...templateItems.map((tpl) => ({
      value: tpl.templateKey,
      label: `${tpl.name} (${tpl.templateKey})`,
    })),
  ];
  if (emailTemplateKey && !emailOptions.some((opt) => opt.value === emailTemplateKey)) {
    emailOptions.push({
      value: emailTemplateKey,
      label: `Current template (${emailTemplateKey})`,
    });
  }

  /* ---- 2. Workflow status options ---- */
  const statusMap = new Map<string, { staffLabel: string; customerLabel: string; retired?: boolean }>();
  for (const seed of BUILT_IN_STATUS_CATALOG) {
    statusMap.set(seed.key, { staffLabel: seed.staffLabel, customerLabel: seed.customerLabel });
  }
  for (const item of statusesQuery.data ?? []) {
    statusMap.set(item.key, {
      staffLabel: item.staffLabel,
      customerLabel: item.customerLabel,
      retired: item.retired,
    });
  }
  const candidateStatusKeys = [...new Set(workflowStatusKeys)];
  const statusOptions = [
    { value: "", label: "Do not change status" },
    ...candidateStatusKeys.map((key) => {
      const meta = statusMap.get(key);
      const label = meta
        ? meta.staffLabel === meta.customerLabel
          ? `${meta.staffLabel} (${key})`
          : `${meta.staffLabel} — customer sees "${meta.customerLabel}"`
        : `${humanizeKey(key)} (${key})`;
      return { value: key, label };
    }),
  ];
  if (setStatusKey && !statusOptions.some((opt) => opt.value === setStatusKey)) {
    statusOptions.push({
      value: setStatusKey,
      label: `${humanizeKey(setStatusKey)} (${setStatusKey}) — not in workflow`,
    });
  }

  /* ---- 3. Completion policy state ---- */
  const completionMode: "none" | "fixed" | "range" = completion?.kind ?? "none";
  const completionDelayMode: "immediate" | "delayed" =
    completion && completion.delayMinutes > 0 ? "delayed" : "immediate";
  const rangeOrderError =
    completion?.kind === "range" && completion.min > completion.max
      ? "The lowest percentage must not be above the highest."
      : undefined;
  const completionSummaryError = errors.completion ?? errors["completion.kind"] ?? rangeOrderError;

  /* ---- 4. Dashboard alert state ---- */
  const alertMode: "none" | "alert" = dashboardAlert ? "alert" : "none";

  return (
    <div className="grid min-w-0 gap-4">
      {errors[""] ? (
        <Callout tone="danger" title="Phase actions need attention">
          {errors[""]}
        </Callout>
      ) : null}

      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
        <Field
          id={id("email-template")}
          label="Customer e-mail"
          hint="Published templates restricted to order reference, phase label, status label and order link."
          error={errors.emailTemplateKey}
        >
          <Select
            value={emailTemplateKey ?? ""}
            disabled={disabled}
            options={emailOptions}
            onChange={(event) =>
              emit({ emailTemplateKey: event.currentTarget.value || undefined })
            }
          />
        </Field>

        <Field
          id={id("set-status")}
          label="Order status update"
          hint="Moves the order to a status in this workflow when an administrator confirms the phase run."
          error={errors.setStatusKey}
        >
          <Select
            value={setStatusKey ?? ""}
            disabled={disabled}
            options={statusOptions}
            onChange={(event) =>
              emit({ setStatusKey: event.currentTarget.value || undefined })
            }
          />
        </Field>
      </div>

      <div className="grid min-w-0 gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-3 rp-forced-border">
        <Heading id={id("completion-heading")} className="text-sm font-semibold text-ink">
          Order completion percentage
        </Heading>
        <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
          <Field
            id={id("completion-mode")}
            label="Completion update"
            hint="Fixed percentage or a single cryptographically sampled value inside a range."
            error={completionSummaryError}
          >
            <Select
              value={completionMode}
              disabled={disabled}
              options={[
                { value: "none", label: "Do not set completion" },
                { value: "fixed", label: "Fixed percentage" },
                { value: "range", label: "Random range" },
              ]}
              onChange={(event) => {
                const mode = event.currentTarget.value as "none" | "fixed" | "range";
                if (mode === "none") {
                  emit({ completion: undefined });
                } else if (mode === "fixed") {
                  const prevPercent =
                    completion?.kind === "fixed"
                      ? completion.percent
                      : completion?.kind === "range"
                        ? completion.min
                        : 50;
                  emit({
                    completion: {
                      kind: "fixed",
                      percent: prevPercent,
                      delayMinutes: completion?.delayMinutes ?? 0,
                    },
                  });
                } else {
                  const base = completion?.kind === "fixed" ? completion.percent : 40;
                  emit({
                    completion: {
                      kind: "range",
                      min: Math.min(base, 100),
                      max: Math.min(Math.max(base + 20, base), 100),
                      delayMinutes: completion?.delayMinutes ?? 0,
                    },
                  });
                }
              }}
            />
          </Field>

          {completion ? (
            <Field
              id={id("completion-timing")}
              label="When to apply"
              hint={`Delayed updates can be scheduled up to 30 days (${STAGE_COMPLETION_DELAY_MAX_MINUTES.toLocaleString()} minutes) and superseded by newer updates.`}
            >
              <Select
                value={completionDelayMode}
                disabled={disabled}
                options={[
                  { value: "immediate", label: "Apply immediately" },
                  { value: "delayed", label: "Apply after a delay" },
                ]}
                onChange={(event) => {
                  const nextDelay =
                    event.currentTarget.value === "delayed"
                      ? Math.max(1, completion.delayMinutes || 60)
                      : 0;
                  emit({ completion: { ...completion, delayMinutes: nextDelay } });
                }}
              />
            </Field>
          ) : null}
        </div>

        {completion?.kind === "fixed" ? (
          <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
            <Field
              id={id("completion-percent")}
              label="Completion percentage (0–100%)"
              required
              error={errors["completion.percent"]}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                disabled={disabled}
                value={String(completion.percent)}
                onChange={(event) =>
                  emit({
                    completion: {
                      ...completion,
                      percent: clampInt(event.currentTarget.value, 0, 100, 0),
                    },
                  })
                }
              />
            </Field>

            {completionDelayMode === "delayed" ? (
              <Field
                id={id("completion-delay")}
                label="Delay (minutes)"
                required
                hint={`1 to ${STAGE_COMPLETION_DELAY_MAX_MINUTES.toLocaleString()} minutes (${formatMinutes(completion.delayMinutes)}).`}
                error={errors["completion.delayMinutes"]}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={STAGE_COMPLETION_DELAY_MAX_MINUTES}
                  step={1}
                  disabled={disabled}
                  value={String(completion.delayMinutes)}
                  onChange={(event) =>
                    emit({
                      completion: {
                        ...completion,
                        delayMinutes: clampInt(
                          event.currentTarget.value,
                          1,
                          STAGE_COMPLETION_DELAY_MAX_MINUTES,
                          60,
                        ),
                      },
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        {completion?.kind === "range" ? (
          <div className="grid min-w-0 gap-3 @2xl:grid-cols-3">
            <Field
              id={id("completion-min")}
              label="Lowest percentage (0–100%)"
              required
              error={errors["completion.min"] ?? rangeOrderError}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                disabled={disabled}
                value={String(completion.min)}
                onChange={(event) =>
                  emit({
                    completion: {
                      ...completion,
                      min: clampInt(event.currentTarget.value, 0, 100, 0),
                    },
                  })
                }
              />
            </Field>

            <Field
              id={id("completion-max")}
              label="Highest percentage (0–100%)"
              required
              error={errors["completion.max"]}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                disabled={disabled}
                value={String(completion.max)}
                onChange={(event) =>
                  emit({
                    completion: {
                      ...completion,
                      max: clampInt(event.currentTarget.value, 0, 100, 100),
                    },
                  })
                }
              />
            </Field>

            {completionDelayMode === "delayed" ? (
              <Field
                id={id("completion-delay")}
                label="Delay (minutes)"
                required
                hint={`1 to ${STAGE_COMPLETION_DELAY_MAX_MINUTES.toLocaleString()} minutes (${formatMinutes(completion.delayMinutes)}).`}
                error={errors["completion.delayMinutes"]}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={STAGE_COMPLETION_DELAY_MAX_MINUTES}
                  step={1}
                  disabled={disabled}
                  value={String(completion.delayMinutes)}
                  onChange={(event) =>
                    emit({
                      completion: {
                        ...completion,
                        delayMinutes: clampInt(
                          event.currentTarget.value,
                          1,
                          STAGE_COMPLETION_DELAY_MAX_MINUTES,
                          60,
                        ),
                      },
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-3 rp-forced-border">
        <Heading id={id("alert-heading")} className="text-sm font-semibold text-ink">
          Operational dashboard alert
        </Heading>
        <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
          <Field
            id={id("alert-mode")}
            label="Dashboard alert"
            hint="Opens an operational alert on the console dashboard when this phase bundle runs."
            error={errors.dashboardAlert}
          >
            <Select
              value={alertMode}
              disabled={disabled}
              options={[
                { value: "none", label: "No dashboard alert" },
                { value: "alert", label: "Create operational alert" },
              ]}
              onChange={(event) => {
                if (event.currentTarget.value === "alert") {
                  emit({
                    dashboardAlert: dashboardAlert ?? {
                      severity: "warning",
                      text: "",
                    },
                  });
                } else {
                  emit({ dashboardAlert: undefined });
                }
              }}
            />
          </Field>

          {dashboardAlert ? (
            <Field
              id={id("alert-severity")}
              label="Alert severity"
              required
              error={errors["dashboardAlert.severity"]}
            >
              <Select
                value={dashboardAlert.severity}
                disabled={disabled}
                options={STAGE_ALERT_SEVERITIES.map((sev) => ({
                  value: sev,
                  label: ALERT_SEVERITY_LABELS[sev],
                }))}
                onChange={(event) =>
                  emit({
                    dashboardAlert: {
                      ...dashboardAlert,
                      severity: event.currentTarget.value as StageAlertSeverity,
                    },
                  })
                }
              />
            </Field>
          ) : null}
        </div>

        {dashboardAlert ? (
          <div className="grid min-w-0 gap-1.5">
            <Field
              id={id("alert-text")}
              label="Alert message"
              required
              hint={`Plain text without markup, up to ${STAGE_ALERT_TEXT_MAX} characters. Visible to staff and administrators only.`}
              error={errors["dashboardAlert.text"]}
            >
              <Textarea
                rows={2}
                maxLength={STAGE_ALERT_TEXT_MAX}
                disabled={disabled}
                value={dashboardAlert.text}
                onChange={(event) =>
                  emit({
                    dashboardAlert: {
                      ...dashboardAlert,
                      text: event.currentTarget.value,
                    },
                  })
                }
              />
            </Field>
            <p className="text-xs text-muted" aria-live="polite">
              {dashboardAlert.text.length} of {STAGE_ALERT_TEXT_MAX} characters
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
