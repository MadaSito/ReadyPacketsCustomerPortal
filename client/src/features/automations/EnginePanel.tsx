/**
 * Portal-wide automations switches and limits (`automations.settings.*`). The platform Settings page links here
 * ("Managed on Automations"), so this panel is the one place unattended rules and administrator-run phase bundles
 * are turned on or off independently.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Field, Input, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import type { AutomationSettingsView } from "@server/modules/automations/contracts";
import { useAutomationsApi } from "./api";

type LimitKey = Exclude<keyof AutomationSettingsView, "enabled" | "stageBundlesEnabled">;

const LIMITS: { key: LimitKey; label: string; hint: string; min: number; max: number }[] = [
  { key: "globalRunsPerMinute", label: "All automations: runs per minute", hint: "Whole numbers from 5 to 2000.", min: 5, max: 2000 },
  { key: "defaultPerAutomationRunsPerHour", label: "New automation: runs per hour", hint: "Default for a new automation. 1 to 600.", min: 1, max: 600 },
  { key: "maxPerAutomationRunsPerHour", label: "Highest runs per hour allowed", hint: "Ceiling for any one automation. 5 to 1200.", min: 5, max: 1200 },
  { key: "runRetentionDays", label: "Keep run history (days)", hint: "Older runs are removed. 7 to 365.", min: 7, max: 365 },
];

const REASON = "Changing portal-wide automation settings requires a fresh confirmation.";

export function EnginePanel() {
  const api = useAutomationsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const settings = useQuery(api.settings.get.queryOptions());
  const update = useMutation(api.settings.update.mutationOptions());
  /** Only the fields being edited; everything else shows the saved value. */
  const [edits, setEdits] = useState<Partial<Record<LimitKey, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const current = settings.data;
  const fieldValue = (key: LimitKey) => edits[key] ?? (current ? String(current[key]) : "");

  const save = async (input: Partial<AutomationSettingsView>, done: string) => {
    setProblem(null);
    try {
      await stepUp.run(() => update.mutateAsync(input), { reason: REASON });
      setEdits({});
      toast.show({ title: done, tone: "success" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      setProblem(errorMessage(error));
    } finally {
      await Promise.all([qc.invalidateQueries(api.settings.get.pathFilter()), qc.invalidateQueries(api.catalogue.pathFilter())]);
    }
  };

  const submitLimits = (event: FormEvent) => {
    event.preventDefault();
    if (!current) return;
    const next: Partial<AutomationSettingsView> = {};
    for (const limit of LIMITS) {
      const value = Number(fieldValue(limit.key));
      if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
        setProblem(`${limit.label}: enter a whole number from ${limit.min} to ${limit.max}.`);
        return;
      }
      next[limit.key] = value;
    }
    void save(next, "Limits saved");
  };

  if (settings.isError) {
    return (
      <Callout tone="danger" title="Automation settings could not be loaded" live="assertive"
        actions={<Button size="sm" variant="secondary" onClick={() => void settings.refetch()}>Try again</Button>}>
        {errorMessage(settings.error)}
      </Callout>
    );
  }
  if (!current) return null;

  const stageBundlesOn = current.stageBundlesEnabled === true;

  return (
    <Card
      title="Automations engine"
      description="Control unattended automation rules and administrator-run order phase bundles separately. While a switch is off, you can still configure workflows and rules without running them."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={current.enabled ? "success" : "warning"}>{current.enabled ? "On" : "Off"}</Badge>
          <Badge tone={stageBundlesOn ? "success" : "neutral"}>
            Phase bundles: {stageBundlesOn ? "On" : "Off"}
          </Badge>
        </div>
      }
    >
      <div className="space-y-6">
        {!current.enabled ? (
          <Callout tone="warning" title="Automations are switched off for the whole portal">
            Turn the engine on here when you are ready. Each automation also has its own on/off state and starts off.
          </Callout>
        ) : null}
        {problem ? <Callout tone="danger" live="assertive">{problem}</Callout> : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface-soft p-4 rp-forced-border">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-ink">Unattended rules</p>
              <p className="text-sm text-muted">
                Event, scheduled and manual rules evaluated in deterministic rule order.
              </p>
            </div>
            <div>
              <Button
                variant={current.enabled ? "secondary" : "primary"}
                loading={update.isPending}
                onClick={() =>
                  void save(
                    { enabled: !current.enabled },
                    current.enabled
                      ? "Automations turned off for the portal"
                      : "Automations turned on for the portal",
                  )
                }
              >
                {current.enabled ? "Turn automations off" : "Turn automations on"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface-soft p-4 rp-forced-border">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-ink">Administrator-run phase bundles</p>
              <p className="text-sm text-muted">
                Preview-and-confirm phase actions on an order&apos;s pinned workflow version. Runs even while unattended rules stay off.
              </p>
            </div>
            <div>
              <Button
                variant={stageBundlesOn ? "secondary" : "primary"}
                loading={update.isPending}
                onClick={() =>
                  void save(
                    { stageBundlesEnabled: !stageBundlesOn },
                    stageBundlesOn
                      ? "Administrator-run phase bundles turned off"
                      : "Administrator-run phase bundles turned on",
                  )
                }
              >
                {stageBundlesOn ? "Turn phase bundles off" : "Turn phase bundles on"}
              </Button>
            </div>
          </div>
        </div>

        <form onSubmit={submitLimits} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {LIMITS.map((limit) => (
              <Field key={limit.key} label={limit.label} hint={limit.hint}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={limit.min}
                  max={limit.max}
                  step={1}
                  value={fieldValue(limit.key)}
                  onChange={(event) => setEdits({ ...edits, [limit.key]: event.target.value })}
                />
              </Field>
            ))}
          </div>
          <Button type="submit" variant="secondary" loading={update.isPending}>Save limits</Button>
        </form>
      </div>
    </Card>
  );
}
