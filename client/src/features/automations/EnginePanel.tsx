/**
 * Portal-wide automations switch and limits (`automations.settings.*`). The platform Settings page links here
 * ("Managed on Automations"), so this panel is the one place the engine is turned on or off.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Field, Input, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import type { AutomationSettingsView } from "@server/modules/automations/contracts";
import { useAutomationsApi } from "./api";

type LimitKey = Exclude<keyof AutomationSettingsView, "enabled">;

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

  return (
    <Card
      title="Automations engine"
      description="One switch for the whole portal. While it is off you can still build and test automations, but none of them run."
      actions={<Badge tone={current.enabled ? "success" : "warning"}>{current.enabled ? "On" : "Off"}</Badge>}
    >
      <div className="space-y-6">
        {!current.enabled ? (
          <Callout tone="warning" title="Automations are switched off for the whole portal">
            Turn the engine on here when you are ready. Each automation also has its own on/off state and starts off.
          </Callout>
        ) : null}
        {problem ? <Callout tone="danger" live="assertive">{problem}</Callout> : null}
        <div>
          <Button
            variant={current.enabled ? "secondary" : "primary"}
            loading={update.isPending}
            onClick={() => void save({ enabled: !current.enabled }, current.enabled ? "Automations turned off for the portal" : "Automations turned on for the portal")}
          >
            {current.enabled ? "Turn automations off" : "Turn automations on"}
          </Button>
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
