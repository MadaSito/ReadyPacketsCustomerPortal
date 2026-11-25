/** /admin/automations — ordered rule list with reordering controls, state, last run, and starter recipes. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Workflow } from "lucide-react";
import { Link } from "wouter";
import { errorMessage } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  DataTable,
  DateTime,
  EmptyState,
  IconButton,
  PageHeader,
  Section,
  StepUpCancelledError,
  useStepUp,
  useToast,
} from "@/ui";
import { useAutomationsApi } from "./api";
import { BASE, TRIGGER_MODE_LABEL, triggerLabel, type AutomationSummaryView } from "./model";
import { EnginePanel } from "./EnginePanel";
import { EnabledBadge, RunStateBadge } from "./parts";

export default function AutomationsPage() {
  const api = useAutomationsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const catalogue = useQuery(api.catalogue.queryOptions());
  const list = useQuery(api.list.queryOptions({ limit: 100 }));
  const setEnabled = useMutation(api.setEnabled.mutationOptions());
  const duplicate = useMutation(api.duplicate.mutationOptions());
  const reorder = useMutation(api.reorder.mutationOptions());

  const items = list.data?.items;

  const toggle = async (row: AutomationSummaryView) => {
    try {
      await stepUp.run(
        () => setEnabled.mutateAsync({ publicId: row.publicId, expectedVersion: row.version, enabled: !row.enabled }),
        { reason: "Changing an automation requires a fresh confirmation." },
      );
      toast.show({ title: row.enabled ? `"${row.name}" turned off` : `"${row.name}" turned on`, tone: "success" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Not changed", description: errorMessage(error), tone: "danger" });
    } finally {
      await qc.invalidateQueries(api.list.pathFilter());
    }
  };

  const copy = async (row: AutomationSummaryView) => {
    try {
      await stepUp.run(
        () => duplicate.mutateAsync({ publicId: row.publicId }),
        { reason: "Copying an automation requires a fresh confirmation." },
      );
      toast.show({ title: "Copy created", description: "Copies start turned off.", tone: "success" });
      await qc.invalidateQueries(api.list.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Not copied", description: errorMessage(error), tone: "danger" });
    }
  };

  const moveRule = async (row: AutomationSummaryView, delta: -1 | 1) => {
    if (!items) return;
    const index = items.findIndex((item) => item.publicId === row.publicId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    const nextOrder = items.map((item) => item.publicId);
    [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex]!, nextOrder[index]!];
    try {
      await stepUp.run(
        () => reorder.mutateAsync({ orderedPublicIds: nextOrder }),
        { reason: "Reordering automation rules requires a fresh confirmation." },
      );
      toast.show({
        title: `"${row.name}" moved to position ${targetIndex + 1}`,
        tone: "success",
      });
      await qc.invalidateQueries(api.list.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Order not changed", description: errorMessage(error), tone: "danger" });
    }
  };

  const recipes = catalogue.data?.starterRecipes ?? [];
  const indexById = new Map((items ?? []).map((item, idx) => [item.publicId, idx]));

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Automations" }]} />}
        title="Automations"
        description="Send e-mails, notices, completion updates, operational alerts and webhook deliveries when events occur, on a schedule, or by hand. Rules evaluate in the order shown below."
        actions={<Button asChild leadingIcon={<Plus className="size-4" aria-hidden />}><Link href={`${BASE}/new`}>New automation</Link></Button>}
      />
      <div className="space-y-8">
        <EnginePanel />
        <Section
          title="Your automations"
          description="Matching event rules evaluate in deterministic top-to-bottom order. Use the Move up and Move down controls to change priority."
        >
          <DataTable
            caption="Automations"
            rows={items}
            rowKey={(r) => r.publicId}
            loading={list.isPending}
            error={list.error}
            onRetry={() => list.refetch()}
            empty={<EmptyState icon={Workflow} headingLevel={3} title="No automations yet" description="Start from a recipe below or build one from scratch." />}
            columns={[
              {
                key: "order",
                header: "Order",
                cell: (r) => {
                  const pos = (indexById.get(r.publicId) ?? 0) + 1;
                  return <Badge tone="neutral">#{pos}</Badge>;
                },
              },
              {
                key: "name",
                header: "Name",
                primary: true,
                cell: (r) => (
                  <Link className="font-medium text-brand underline-offset-2 hover:underline" href={`${BASE}/${r.publicId}`}>
                    {r.name}
                  </Link>
                ),
              },
              {
                key: "trigger",
                header: "Starts",
                cell: (r) => (
                  <span>
                    <Badge tone="neutral">{TRIGGER_MODE_LABEL[r.trigger.kind]}</Badge>{" "}
                    <span className="ml-1">{triggerLabel(r.trigger, catalogue.data)}</span>
                  </span>
                ),
              },
              { key: "state", header: "State", cell: (r) => <EnabledBadge enabled={r.enabled} /> },
              {
                key: "lastRun",
                header: "Last run",
                cell: (r) =>
                  r.lastRun ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <RunStateBadge state={r.lastRun.state} />
                      <DateTime value={r.lastRun.finishedAt ?? r.lastRun.startedAt ?? r.lastRun.createdAt} format="relative" />
                    </span>
                  ) : (
                    <span className="text-muted">Never</span>
                  ),
              },
            ]}
            rowActions={(r) => {
              const idx = indexById.get(r.publicId) ?? 0;
              const total = items?.length ?? 0;
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  <IconButton
                    label={`Move ${r.name} up`}
                    variant="ghost"
                    disabled={idx <= 0 || reorder.isPending}
                    onClick={() => void moveRule(r, -1)}
                    icon={<ArrowUp aria-hidden="true" />}
                  />
                  <IconButton
                    label={`Move ${r.name} down`}
                    variant="ghost"
                    disabled={idx >= total - 1 || reorder.isPending}
                    onClick={() => void moveRule(r, 1)}
                    icon={<ArrowDown aria-hidden="true" />}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void toggle(r)}
                    aria-label={`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`}
                  >
                    {r.enabled ? "Turn off" : "Turn on"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy(r)}
                    aria-label={`Duplicate ${r.name}`}
                  >
                    Duplicate
                  </Button>
                </div>
              );
            }}
          />
        </Section>
        {recipes.length > 0 ? (
          <Section title="Starter recipes" description="Each recipe opens the builder pre-filled. Nothing is saved until you choose Save.">
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {recipes.map((recipe) => (
                <li key={recipe.key} className="flex">
                  <Card
                    as="article"
                    headingLevel={3}
                    title={recipe.name}
                    description={recipe.description}
                    className="flex w-full flex-col"
                    footer={
                      <Button asChild size="sm" variant="secondary">
                        <Link href={`${BASE}/new?recipe=${encodeURIComponent(recipe.key)}`} aria-label={`Use recipe: ${recipe.name}`}>
                          Use recipe
                        </Link>
                      </Button>
                    }
                  >
                    <p className="text-sm text-muted">{triggerLabel(recipe.trigger, catalogue.data)}</p>
                  </Card>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </>
  );
}
