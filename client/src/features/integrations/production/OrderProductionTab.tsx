/**
 * Console-only "Production" tab on `/admin/orders/:orderId/production`.
 * Renders Phase I (P101) and Phase II (P201) status, payload previews, manual triggers,
 * mandatory Phase I artifact confirmation, dispatch history, and admin step-up re-send.
 * Customers never see or mount this tab (`access: "staff"` + explicit `area === "console"` guard).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Section,
  Skeleton,
  StepUpCancelledError,
  Textarea,
  useStepUp,
  useToast,
} from "@/ui";
import { useProductionClient, useProductionTRPC } from "./api";
import {
  auditCorrelationHref,
  DISPATCH_STATE_META,
  PHASE_LABELS,
  PRODUCTION_PIPELINE_PATH,
  RELEASE_STATUS_RE,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionPhase,
} from "./model";

export interface OrderProductionTabProps {
  orderId: string;
  area: "customer" | "console";
}

function PhaseStateBadge({
  activeState,
  alreadyDelivered,
  fallbackLabel,
  fallbackTone = "neutral",
}: {
  activeState: ProductionDispatchState | null;
  alreadyDelivered: boolean;
  fallbackLabel: string;
  fallbackTone?: "neutral" | "info" | "warning" | "danger";
}) {
  if (activeState) {
    const meta = DISPATCH_STATE_META[activeState];
    return <Badge tone={meta.tone}>{meta.label}</Badge>;
  }
  if (alreadyDelivered) {
    return <Badge tone="success">Delivered</Badge>;
  }
  return <Badge tone={fallbackTone}>{fallbackLabel}</Badge>;
}

export default function OrderProductionTab({ orderId, area }: OrderProductionTabProps) {
  if (area !== "console") return null;
  return <ConsoleOrderProductionPanel orderId={orderId} />;
}

function ConsoleOrderProductionPanel({ orderId }: { orderId: string }) {
  const prodTrpc = useProductionTRPC();
  const prodClient = useProductionClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const { me } = useSession();
  const isAdmin = me?.user.role === "admin";

  const [releaseStatus, setReleaseStatus] = useState("");
  const [phase1ArtifactsConfirmed, setPhase1ArtifactsConfirmed] = useState(false);
  const [confirmStartPhase, setConfirmStartPhase] = useState<ProductionPhase | null>(null);
  const [actionError, setActionError] = useState<string>();

  // Admin re-send dialog state
  const [resendPhase, setResendPhase] = useState<ProductionPhase | null>(null);
  const [resendReason, setResendReason] = useState("");
  const [resendArtifactsConfirmed, setResendArtifactsConfirmed] = useState(false);
  const [resendError, setResendError] = useState<string>();
  const [resending, setResending] = useState(false);

  const trimmedRelease = releaseStatus.trim();
  const releaseStatusError =
    trimmedRelease && !RELEASE_STATUS_RE.test(trimmedRelease)
      ? "Use only letters, digits, underscores, dots, or hyphens (up to 120 characters)."
      : undefined;

  const previewInput = {
    orderPublicId: orderId,
    ...(trimmedRelease && !releaseStatusError ? { releaseStatus: trimmedRelease } : {}),
  };

  const preview = useQuery({
    ...prodTrpc.order.preview.queryOptions(previewInput),
    placeholderData: (previousData) => previousData,
  });
  const history = useQuery(prodTrpc.order.history.queryOptions({ orderPublicId: orderId }));

  if (preview.isError || history.isError) {
    return (
      <ErrorState
        error={preview.error ?? history.error}
        title="Production pipeline status unavailable"
        onRetry={() => {
          void preview.refetch();
          void history.refetch();
        }}
      />
    );
  }

  if (preview.isPending || history.isPending || !preview.data || !history.data) {
    return (
      <div aria-busy="true">
        <Skeleton lines={5} />
      </div>
    );
  }

  const { featureConfigured, featureEnabled, p101, p201 } = preview.data;

  const refreshOrderProduction = async () => {
    await queryClient.invalidateQueries({ queryKey: prodTrpc.order.pathKey() });
    await Promise.all([preview.refetch(), history.refetch()]);
  };

  const canStartP101 =
    featureEnabled &&
    p101.eligible &&
    p101.validationErrors.length === 0 &&
    !releaseStatusError;

  const canStartP201 =
    featureEnabled &&
    p201.eligible &&
    p201.p101Delivered &&
    phase1ArtifactsConfirmed &&
    p201.validationErrors.length === 0;

  const canResendP101 =
    isAdmin &&
    featureEnabled &&
    (p101.alreadyDelivered || p101.activeState === "dead" || p101.activeState === "failed");

  const canResendP201 =
    isAdmin &&
    featureEnabled &&
    p201.p101Delivered &&
    (p201.alreadyDelivered || p201.activeState === "dead" || p201.activeState === "failed");

  const executeStartPhase = async (phase: ProductionPhase) => {
    setActionError(undefined);
    try {
      if (phase === "P101") {
        await prodClient.order.requestP101.mutate({
          orderPublicId: orderId,
          ...(trimmedRelease ? { releaseStatus: trimmedRelease } : {}),
        });
        toast.show({
          tone: "success",
          title: "Phase I (P101) dispatch queued",
          description: "The outbox worker will deliver the intake payload.",
        });
      } else {
        await prodClient.order.requestP201.mutate({
          orderPublicId: orderId,
          phase1ArtifactsConfirmed: true,
        });
        toast.show({
          tone: "success",
          title: "Phase II (P201) dispatch queued",
          description: "The outbox worker will deliver the Phase II continuation payload.",
        });
      }
      setConfirmStartPhase(null);
      await refreshOrderProduction();
    } catch (err) {
      setActionError(errorMessage(err, `Could not start ${PHASE_LABELS[phase]}.`));
      throw err;
    }
  };

  const openResendDialog = (phase: ProductionPhase) => {
    setResendPhase(phase);
    setResendReason("");
    setResendArtifactsConfirmed(false);
    setResendError(undefined);
  };

  const onSubmitResend = async (event: FormEvent) => {
    event.preventDefault();
    if (!resendPhase || resending) return;
    const cleanedReason = resendReason.trim();
    if (cleanedReason.length < 8) {
      setResendError("Enter a reason of at least 8 characters for the audit record.");
      return;
    }
    if (resendPhase === "P201" && !resendArtifactsConfirmed) {
      setResendError(
        "Confirm the Phase I final output artifacts exist before re-sending Phase II.",
      );
      return;
    }

    setResending(true);
    setResendError(undefined);
    try {
      await stepUp.run(
        () =>
          prodClient.order.resend.mutate({
            orderPublicId: orderId,
            phase: resendPhase,
            reason: cleanedReason,
            ...(resendPhase === "P101" && trimmedRelease
              ? { releaseStatus: trimmedRelease }
              : {}),
            ...(resendPhase === "P201" ? { phase1ArtifactsConfirmed: true } : {}),
          }),
        {
          reason: "Re-sending a production pipeline webhook requires administrator verification.",
        },
      );
      toast.show({
        tone: "success",
        title: `${PHASE_LABELS[resendPhase]} re-send queued`,
      });
      setResendPhase(null);
      await refreshOrderProduction();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setResendError(errorMessage(err, "Could not queue the re-send."));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 pt-2">
      {!featureConfigured || !featureEnabled ? (
        <Callout
          tone="warning"
          title={
            !featureConfigured
              ? "Production pipeline not configured"
              : "Production pipeline disabled"
          }
          actions={
            isAdmin ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={PRODUCTION_PIPELINE_PATH}>Configure production pipeline</Link>
              </Button>
            ) : undefined
          }
        >
          {!featureConfigured
            ? "An administrator must configure the Phase I (P101) URL, Phase II (P201) URL, and canon version before triggers can be sent."
            : "Production pipeline webhooks are currently switched off in Integrations."}
        </Callout>
      ) : null}

      {actionError ? (
        <Callout tone="danger" live="assertive" title="Production trigger refused">
          {actionError}
        </Callout>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          as="section"
          className="min-w-0"
          title={PHASE_LABELS.P101}
          description="Sends canonical packet, tier, and escaped bundle_scope_manifest metadata to start Phase I."
          actions={
            <PhaseStateBadge
              activeState={p101.activeState}
              alreadyDelivered={p101.alreadyDelivered}
              fallbackLabel={p101.validationErrors.length > 0 ? "Not eligible" : "Not started"}
              fallbackTone={p101.validationErrors.length > 0 ? "danger" : "neutral"}
            />
          }
        >
          <div className="flex flex-col gap-4">
            {p101.validationErrors.length > 0 ? (
              <Callout tone="danger" title="Order cannot be sent to Phase I">
                <ul className="list-disc space-y-1 pl-5">
                  {p101.validationErrors.map((err) => (
                    <li key={err.code}>{err.message}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {!p101.alreadyDelivered ? (
              <Field
                label="Release status label"
                hint="Optional operator tracking label sent as release_status (letters, digits, _, ., -)."
                error={releaseStatusError}
              >
                <Input
                  value={releaseStatus}
                  onChange={(e) => setReleaseStatus(e.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            ) : null}

            {p101.payload ? (
              <div className="flex flex-col gap-2">
                <CodeBlock label="Phase I (P101) payload preview" copyable wrap>
                  {JSON.stringify(p101.payload, null, 2)}
                </CodeBlock>
                {p101.maskedForViewer ? (
                  <p className="text-xs text-muted">
                    Client name and email are masked in this preview for staff; the server sends
                    the order owner&apos;s canonical contact details.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                disabled={!canStartP101}
                onClick={() => {
                  setActionError(undefined);
                  setConfirmStartPhase("P101");
                }}
              >
                Start Phase I
              </Button>

              {canResendP101 ? (
                <Button variant="secondary" onClick={() => openResendDialog("P101")}>
                  Re-send Phase I
                </Button>
              ) : null}
            </div>
          </div>
        </Card>

        <Card
          as="section"
          className="min-w-0"
          title={PHASE_LABELS.P201}
          description="Reuses the exact customer_id, order_id, and run_mode stored on the delivered Phase I record."
          actions={
            <PhaseStateBadge
              activeState={p201.activeState}
              alreadyDelivered={p201.alreadyDelivered}
              fallbackLabel={
                p201.p101Delivered ? "Ready after artifact check" : "Waiting for Phase I delivery"
              }
              fallbackTone={p201.p101Delivered ? "info" : "neutral"}
            />
          }
        >
          <div className="flex flex-col gap-4">
            {!p201.p101Delivered ? (
              <Callout tone="info" title="Phase I delivery required first">
                Phase II (P201) becomes available only after Phase I (P101) has been delivered for
                this order and its output artifacts exist.
              </Callout>
            ) : null}

            {p201.validationErrors.length > 0 ? (
              <Callout tone="danger" title="Order cannot be sent to Phase II">
                <ul className="list-disc space-y-1 pl-5">
                  {p201.validationErrors.map((err) => (
                    <li key={err.code}>{err.message}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {p201.payload ? (
              <CodeBlock label="Phase II (P201) payload preview" copyable wrap>
                {JSON.stringify(p201.payload, null, 2)}
              </CodeBlock>
            ) : null}

            {!p201.alreadyDelivered ? (
              <Checkbox
                label="I confirm the Phase I final output artifacts exist for this order ID"
                description="ReadyPackets cannot see external pipeline folders. Verify Final_Merge outputs (Phase1A_Merged.txt, Phase1B_Adjudication.json, Phase1B_DeepResearch_Evidence.txt, PhaseI_InterviewGuidance.txt) exist before starting Phase II."
                checked={phase1ArtifactsConfirmed}
                onCheckedChange={setPhase1ArtifactsConfirmed}
                disabled={!p201.p101Delivered}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                disabled={!canStartP201}
                onClick={() => {
                  setActionError(undefined);
                  setConfirmStartPhase("P201");
                }}
              >
                Start Phase II
              </Button>

              {canResendP201 ? (
                <Button variant="secondary" onClick={() => openResendDialog("P201")}>
                  Re-send Phase II
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      <Section
        title="Dispatch history"
        description="Recorded Phase I (P101) and Phase II (P201) outbox dispatches for this order."
      >
        <DataTable<ProductionDispatchItem>
          caption="Order production dispatches"
          rows={history.data.items}
          rowKey={(row) => row.publicId}
          empty={
            <EmptyState
              title="No production dispatches for this order"
              description="Phase I and Phase II triggers started for this order are recorded here with their correlation references."
              headingLevel={3}
            />
          }
          columns={[
            {
              key: "phase",
              header: "Phase",
              primary: true,
              cell: (row) => (
                <div>
                  <span className="font-medium text-ink">{PHASE_LABELS[row.phase]}</span>
                  {row.packet && row.tier ? (
                    <div className="text-xs text-muted">
                      Packet {row.packet} · {row.tier}
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              key: "state",
              header: "State",
              cell: (row) => {
                const meta = DISPATCH_STATE_META[row.state];
                return (
                  <div>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <div className="mt-1 tabular-nums text-xs text-muted">
                      Attempts: {row.attemptCount} of {row.maxAttempts}
                    </div>
                  </div>
                );
              },
            },
            {
              key: "identity",
              header: "Run identity",
              cell: (row) => (
                <div className="break-all font-mono text-xs text-body">
                  {row.identityTriple.customerId} · {row.identityTriple.orderId} ·{" "}
                  {row.identityTriple.runMode}
                </div>
              ),
            },
            {
              key: "response",
              header: "Receiver response",
              cell: (row) => (
                <div className="min-w-0">
                  <span className="tabular-nums text-sm text-body">
                    {row.httpStatus !== null ? `HTTP ${row.httpStatus}` : "No HTTP response"}
                  </span>
                  {row.lastReasonCode ? (
                    <div className="break-all text-xs text-muted">{row.lastReasonCode}</div>
                  ) : null}
                  {row.responseSummary ? (
                    <div className="mt-0.5 break-words text-xs text-muted">
                      {row.responseSummary}
                    </div>
                  ) : null}
                  {row.resendReason ? (
                    <div className="mt-0.5 break-words text-xs text-muted">
                      Re-send reason: {row.resendReason}
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              key: "requestedAt",
              header: "Requested",
              cell: (row) => (
                <div>
                  <DateTime value={row.createdAt} />
                  {row.deliveredAt ? (
                    <div className="mt-0.5 text-xs text-muted">
                      Delivered <DateTime value={row.deliveredAt} />
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              key: "correlation",
              header: "Audit trail",
              cell: (row) => (
                <Button asChild variant="link">
                  <Link
                    href={auditCorrelationHref(row.correlationId)}
                    aria-label={`Open audit correlation ${row.correlationId}`}
                  >
                    Audit correlation
                  </Link>
                </Button>
              ),
            },
          ]}
        />
      </Section>

      <ConfirmDialog
        open={confirmStartPhase !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmStartPhase(null);
        }}
        title={
          confirmStartPhase === "P101" ? "Start Phase I (P101)?" : "Start Phase II (P201)?"
        }
        description={
          confirmStartPhase === "P101"
            ? "This queues the canonical Phase I intake webhook (including the order owner's name and email) for delivery to the production pipeline."
            : "This queues the Phase II start webhook using the exact customer_id, order_id, and run_mode from Phase I."
        }
        confirmLabel={confirmStartPhase === "P101" ? "Start Phase I" : "Start Phase II"}
        onConfirm={() =>
          confirmStartPhase ? executeStartPhase(confirmStartPhase) : Promise.resolve()
        }
      />

      <Dialog
        open={resendPhase !== null}
        onOpenChange={(open) => {
          if (!open) setResendPhase(null);
        }}
        title={resendPhase ? `Re-send ${PHASE_LABELS[resendPhase]}` : "Re-send webhook"}
        description="Re-sending creates a new audited dispatch and requires administrator multi-factor verification."
      >
        <form onSubmit={(e) => void onSubmitResend(e)} noValidate className="flex flex-col gap-4">
          {resendError ? (
            <Callout tone="danger" live="assertive">
              {resendError}
            </Callout>
          ) : null}

          <Field
            label="Reason for re-send"
            hint="Recorded in the durable audit log (minimum 8 characters)."
            required
          >
            <Textarea
              value={resendReason}
              onChange={(e) => setResendReason(e.target.value)}
              maxLength={280}
              rows={3}
            />
          </Field>

          {resendPhase === "P201" ? (
            <Checkbox
              label="I confirm the Phase I final output artifacts exist for this order ID"
              checked={resendArtifactsConfirmed}
              onCheckedChange={setResendArtifactsConfirmed}
            />
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setResendPhase(null)}
              disabled={resending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={resending}>
              {resendPhase === "P101" ? "Confirm Phase I re-send" : "Confirm Phase II re-send"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
