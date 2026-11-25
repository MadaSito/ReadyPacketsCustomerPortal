/**
 * Console-only "Automation" tab on `/admin/orders/:orderId/automation` (Increment 04 Part B, B4).
 *
 * Layout:
 * - Full-width top slot for `audit_engineer`'s `OrderWorkflowStageActionsPanel` ("Workflow stage actions")
 * - Two columns at >= 900 px (`min-[900px]:grid-cols-2`), one column below 900 px down to 320 px:
 *   - Left column: Phase I (P101) and Phase II (P201) cards with payload previews, start actions,
 *     explicit disabled reasons, and an administrator link to `/admin/integrations/production`.
 *   - Right column: "Webhook rules" note, optional Phase III (P301) / Phase IV (P401) start controls
 *     (rendered only when configured), and "This order's pipeline history" with Retry and Redeliver.
 *
 * Customers never see or mount this tab (`access: "staff"` + explicit `area === "console"` guard).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Component,
  lazy,
  Suspense,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
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
  formatTriggerSource,
  PHASE_LABELS,
  PHASE_START_LABELS,
  PRODUCTION_PIPELINE_PATH,
  REDELIVER_CONFIRM_PHRASE,
  RELEASE_STATUS_RE,
  type ProductionDisabledReason,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionLaterPhasePreview,
  type ProductionPhase,
} from "./model";

interface StageActionsSlotProps {
  orderId: string;
}

const stageActionsSlotModules = import.meta.glob<{
  default: ComponentType<StageActionsSlotProps>;
}>("../../automations/OrderWorkflowStageActionsPanel.tsx");
const StageActionsSlotEntry = Object.values(stageActionsSlotModules)[0];
const LazyWorkflowStageActionsSlot = StageActionsSlotEntry ? lazy(StageActionsSlotEntry) : null;

class OptionalSlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function createRedeliverIntentKey(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `redeliver:${globalThis.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `redeliver:${hex}`;
  }
  return `redeliver:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export interface OrderProductionTabProps {
  orderId: string;
  area: "customer" | "console";
  /** Optional override for `OrderWorkflowStageActionsPanel` in isolated component tests. */
  stageActionsSlot?: ReactNode;
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

function DisabledReasonsNotice({
  phaseLabel,
  reasons,
  isAdmin,
  settingsHref,
}: {
  phaseLabel: string;
  reasons: ProductionDisabledReason[];
  isAdmin: boolean;
  settingsHref: string;
}) {
  if (reasons.length === 0) return null;
  const showSettingsLink = isAdmin && reasons.some((reason) => reason.settingsActionable);

  return (
    <div
      role="note"
      aria-label={`Why ${phaseLabel} is disabled`}
      className="rounded-md border border-border bg-surface-subtle p-3 text-sm text-body"
    >
      <p className="font-medium text-ink">Why {phaseLabel} cannot be started right now:</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {reasons.map((reason) => (
          <li key={reason.code}>{reason.message}</li>
        ))}
      </ul>
      {showSettingsLink ? (
        <div className="mt-2">
          <Link
            href={settingsHref}
            className="inline-flex min-h-9 items-center text-sm font-semibold text-action underline underline-offset-4"
          >
            Open pipeline settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function shortPublicId(publicId: string): string {
  return publicId.length > 10 ? `…${publicId.slice(-6)}` : publicId;
}

function computeRetryableIds(items: readonly ProductionDispatchItem[]): Set<string> {
  const activeBlockedPhases = new Set<ProductionPhase>();
  const deliveredPhases = new Set<ProductionPhase>();
  const latestByPhase = new Map<
    ProductionPhase,
    { row: ProductionDispatchItem; ts: number; index: number }
  >();

  items.forEach((row, index) => {
    if (row.state === "queued" || row.state === "sending" || row.state === "unknown") {
      activeBlockedPhases.add(row.phase);
    }
    if (row.state === "delivered") {
      deliveredPhases.add(row.phase);
    }
    const parsedTs = new Date(row.createdAt).getTime();
    const ts = Number.isNaN(parsedTs) ? 0 : parsedTs;
    const current = latestByPhase.get(row.phase);
    if (!current || ts > current.ts || (ts === current.ts && index < current.index)) {
      latestByPhase.set(row.phase, { row, ts, index });
    }
  });

  const retryable = new Set<string>();
  for (const [phase, entry] of latestByPhase.entries()) {
    if (activeBlockedPhases.has(phase)) continue;
    if (deliveredPhases.has(phase) && !entry.row.redeliveryOf) continue;
    if (
      entry.row.state === "failed" ||
      entry.row.state === "dead" ||
      entry.row.state === "stopped"
    ) {
      retryable.add(entry.row.publicId);
    }
  }
  return retryable;
}

export default function OrderProductionTab({
  orderId,
  area,
  stageActionsSlot,
}: OrderProductionTabProps) {
  if (area !== "console") return null;
  return <ConsoleOrderAutomationPanel orderId={orderId} stageActionsSlot={stageActionsSlot} />;
}

function ConsoleOrderAutomationPanel({
  orderId,
  stageActionsSlot,
}: {
  orderId: string;
  stageActionsSlot?: ReactNode;
}) {
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
  const [retryingDispatchId, setRetryingDispatchId] = useState<string | null>(null);

  // Stop dialog state (queued dispatches -> orders.production.stop)
  const [stopTarget, setStopTarget] = useState<ProductionDispatchItem | null>(null);
  const [stopReason, setStopReason] = useState("");
  const [stopError, setStopError] = useState<string>();
  const [stopping, setStopping] = useState(false);

  // Admin Redeliver dialog state (delivered dispatches -> orders.production.redeliver)
  const [redeliverTarget, setRedeliverTarget] = useState<ProductionDispatchItem | null>(null);
  const [redeliverReason, setRedeliverReason] = useState("");
  const [redeliverConfirmation, setRedeliverConfirmation] = useState("");
  const [redeliverError, setRedeliverError] = useState<string>();
  const [redelivering, setRedelivering] = useState(false);
  const redeliverReasonRef = useRef<HTMLTextAreaElement | null>(null);
  const redeliverIntentKeyRef = useRef<string>("");

  // Admin Re-send dialog state (preserved for `unknown` recovery -> orders.production.trigger)
  const [resendPhase, setResendPhase] = useState<"P101" | "P201" | null>(null);
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
        title="Automation pipeline status unavailable"
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

  const { featureConfigured, featureEnabled, p101, p201, p301, p401 } = preview.data;
  const settingsHref = preview.data.settingsHref || PRODUCTION_PIPELINE_PATH;

  const refreshOrderProduction = async () => {
    await queryClient.invalidateQueries({ queryKey: prodTrpc.order.pathKey() });
    await Promise.all([preview.refetch(), history.refetch()]);
  };

  const canStartP101 =
    featureEnabled &&
    p101.configured &&
    p101.eligible &&
    p101.validationErrors.length === 0 &&
    !releaseStatusError;

  const canStartP201 =
    featureEnabled &&
    p201.configured &&
    p201.eligible &&
    p201.p101Delivered &&
    phase1ArtifactsConfirmed &&
    p201.validationErrors.length === 0;

  const canStartLaterPhase = (phasePreview: ProductionLaterPhasePreview): boolean =>
    featureEnabled &&
    phasePreview.configured &&
    phasePreview.eligible &&
    phasePreview.validationErrors.length === 0;

  const canResendUnknownP101 = isAdmin && featureEnabled && p101.activeState === "unknown";
  const canResendUnknownP201 =
    isAdmin && featureEnabled && p201.p101Delivered && p201.activeState === "unknown";

  const buildP101DisabledReasons = (): ProductionDisabledReason[] => {
    if (canStartP101) return [];
    const list: ProductionDisabledReason[] = [...(p101.disabledReasons ?? [])];
    if (list.length === 0) {
      if (!featureConfigured || !p101.configured) {
        list.push({
          code: "P101_ENDPOINT_MISSING",
          category: "endpoint_missing",
          message:
            "Phase I (P101) webhook endpoint or canon version is not configured in pipeline settings.",
          settingsActionable: true,
        });
      } else if (!featureEnabled) {
        list.push({
          code: "PIPELINE_OFF",
          category: "pipeline_off",
          message: "Production pipeline webhooks are switched off.",
          settingsActionable: true,
        });
      } else if (p101.alreadyDelivered) {
        list.push({
          code: "P101_ALREADY_DELIVERED",
          category: "already_delivered",
          message:
            "Phase I (P101) has already been delivered for this order. Administrators can redeliver from pipeline history if required.",
          settingsActionable: false,
        });
      } else if (p101.activeState === "queued" || p101.activeState === "sending") {
        list.push({
          code: "P101_IN_PROGRESS",
          category: "in_progress",
          message: "A Phase I (P101) dispatch is already queued or sending.",
          settingsActionable: false,
        });
      } else if (
        p101.activeState === "failed" ||
        p101.activeState === "dead" ||
        p101.activeState === "stopped"
      ) {
        list.push({
          code: "P101_RETRY_REQUIRED",
          category: "retry_or_resend_required",
          message:
            p101.activeState === "stopped"
              ? "The previous Phase I dispatch was stopped. Retry it from this order's pipeline history."
              : "The previous Phase I dispatch failed. Retry it from this order's pipeline history.",
          settingsActionable: false,
        });
      } else if (p101.activeState === "unknown") {
        list.push({
          code: "P101_UNKNOWN_OUTCOME",
          category: "retry_or_resend_required",
          message:
            "The previous Phase I delivery outcome is unknown. Verify downstream execution before re-sending.",
          settingsActionable: false,
        });
      }
      for (const issue of p101.validationErrors) {
        if (!list.some((item) => item.code === issue.code)) {
          list.push({
            code: issue.code,
            category: "precondition",
            message: issue.message,
            settingsActionable: false,
          });
        }
      }
    }
    if (releaseStatusError) {
      list.push({
        code: "INVALID_RELEASE_STATUS",
        category: "precondition",
        message: releaseStatusError,
        settingsActionable: false,
      });
    }
    return list;
  };

  const buildP201DisabledReasons = (): ProductionDisabledReason[] => {
    if (canStartP201) return [];
    const list: ProductionDisabledReason[] = [...(p201.disabledReasons ?? [])];
    if (list.length === 0) {
      if (!featureConfigured || !p201.configured) {
        list.push({
          code: "P201_ENDPOINT_MISSING",
          category: "endpoint_missing",
          message: "Phase II (P201) webhook endpoint is not configured in pipeline settings.",
          settingsActionable: true,
        });
      } else if (!featureEnabled) {
        list.push({
          code: "PIPELINE_OFF",
          category: "pipeline_off",
          message: "Production pipeline webhooks are switched off.",
          settingsActionable: true,
        });
      } else if (!p201.p101Delivered) {
        list.push({
          code: "P101_NOT_DELIVERED",
          category: "precondition",
          message: "Phase I (P101) must be delivered before Phase II (P201) can start.",
          settingsActionable: false,
        });
      } else if (p201.alreadyDelivered) {
        list.push({
          code: "P201_ALREADY_DELIVERED",
          category: "already_delivered",
          message:
            "Phase II (P201) has already been delivered for this order. Administrators can redeliver from pipeline history if required.",
          settingsActionable: false,
        });
      } else if (p201.activeState === "queued" || p201.activeState === "sending") {
        list.push({
          code: "P201_IN_PROGRESS",
          category: "in_progress",
          message: "A Phase II (P201) dispatch is already queued or sending.",
          settingsActionable: false,
        });
      } else if (
        p201.activeState === "failed" ||
        p201.activeState === "dead" ||
        p201.activeState === "stopped"
      ) {
        list.push({
          code: "P201_RETRY_REQUIRED",
          category: "retry_or_resend_required",
          message:
            p201.activeState === "stopped"
              ? "The previous Phase II dispatch was stopped. Retry it from this order's pipeline history."
              : "The previous Phase II dispatch failed. Retry it from this order's pipeline history.",
          settingsActionable: false,
        });
      } else if (p201.activeState === "unknown") {
        list.push({
          code: "P201_UNKNOWN_OUTCOME",
          category: "retry_or_resend_required",
          message:
            "The previous Phase II delivery outcome is unknown. Verify downstream execution before re-sending.",
          settingsActionable: false,
        });
      }
      for (const issue of p201.validationErrors) {
        if (!list.some((item) => item.code === issue.code)) {
          list.push({
            code: issue.code,
            category: "precondition",
            message: issue.message,
            settingsActionable: false,
          });
        }
      }
    }
    if (
      p201.p101Delivered &&
      !p201.alreadyDelivered &&
      !phase1ArtifactsConfirmed &&
      !list.some((item) => item.code === "PHASE1_ARTIFACTS_UNCONFIRMED")
    ) {
      list.push({
        code: "PHASE1_ARTIFACTS_UNCONFIRMED",
        category: "precondition",
        message: "Confirm the Phase I final output artifacts exist before starting Phase II.",
        settingsActionable: false,
      });
    }
    return list;
  };

  const buildLaterPhaseDisabledReasons = (
    phase: "P301" | "P401",
    phasePreview: ProductionLaterPhasePreview,
  ): ProductionDisabledReason[] => {
    if (canStartLaterPhase(phasePreview)) return [];
    const list: ProductionDisabledReason[] = [...(phasePreview.disabledReasons ?? [])];
    if (list.length === 0) {
      if (!featureEnabled) {
        list.push({
          code: "PIPELINE_OFF",
          category: "pipeline_off",
          message: "Production pipeline webhooks are switched off.",
          settingsActionable: true,
        });
      } else if (!phasePreview.prerequisiteDelivered) {
        list.push({
          code: `${phase}_PREREQUISITE_NOT_DELIVERED`,
          category: "precondition",
          message:
            phase === "P301"
              ? "Phase I (P101) and Phase II (P201) must be delivered before starting Phase III."
              : "Earlier configured pipeline phases must be delivered before starting Phase IV.",
          settingsActionable: false,
        });
      } else if (phasePreview.alreadyDelivered) {
        list.push({
          code: `${phase}_ALREADY_DELIVERED`,
          category: "already_delivered",
          message: `${PHASE_LABELS[phase]} has already been delivered for this order.`,
          settingsActionable: false,
        });
      }
    }
    return list;
  };

  const p101DisabledReasons = buildP101DisabledReasons();
  const p201DisabledReasons = buildP201DisabledReasons();
  const retryableIds = computeRetryableIds(history.data.items);
  const hasConfiguredLaterPhase = p301.configured || p401.configured;

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
      } else if (phase === "P201") {
        await prodClient.order.requestP201.mutate({
          orderPublicId: orderId,
          phase1ArtifactsConfirmed: true,
        });
        toast.show({
          tone: "success",
          title: "Phase II (P201) dispatch queued",
          description: "The outbox worker will deliver the Phase II continuation payload.",
        });
      } else if (phase === "P301") {
        await prodClient.order.requestP301.mutate({ orderPublicId: orderId });
        toast.show({
          tone: "success",
          title: "Phase III (P301) dispatch queued",
          description: "The outbox worker will deliver the Phase III payload.",
        });
      } else {
        await prodClient.order.requestP401.mutate({ orderPublicId: orderId });
        toast.show({
          tone: "success",
          title: "Phase IV (P401) dispatch queued",
          description: "The outbox worker will deliver the Phase IV payload.",
        });
      }
      setConfirmStartPhase(null);
      await refreshOrderProduction();
    } catch (err) {
      setActionError(errorMessage(err, `Could not start ${PHASE_LABELS[phase]}.`));
      throw err;
    }
  };

  const onRetryDispatch = async (row: ProductionDispatchItem) => {
    if (retryingDispatchId) return;
    setActionError(undefined);
    setRetryingDispatchId(row.publicId);
    try {
      await prodClient.order.retry.mutate({
        orderPublicId: orderId,
        dispatchPublicId: row.publicId,
      });
      toast.show({
        tone: "success",
        title: `${PHASE_LABELS[row.phase]} retry queued`,
        description: "A new delivery record has been queued for this order.",
      });
      await refreshOrderProduction();
    } catch (err) {
      setActionError(errorMessage(err, `Could not retry ${PHASE_LABELS[row.phase]}.`));
    } finally {
      setRetryingDispatchId(null);
    }
  };

  const openStopDialog = (row: ProductionDispatchItem) => {
    setStopTarget(row);
    setStopReason("");
    setStopError(undefined);
  };

  const onSubmitStop = async (event: FormEvent) => {
    event.preventDefault();
    if (!stopTarget || stopping) return;
    setStopping(true);
    setStopError(undefined);
    try {
      await prodClient.order.stop.mutate({
        orderPublicId: orderId,
        dispatchPublicId: stopTarget.publicId,
        reason: stopReason.trim() || null,
      });
      toast.show({
        tone: "success",
        title: `${PHASE_LABELS[stopTarget.phase]} dispatch stopped`,
        description: "The queued dispatch was canceled before worker delivery.",
      });
      setStopTarget(null);
      await refreshOrderProduction();
    } catch (err) {
      setStopError(errorMessage(err, `Could not stop ${PHASE_LABELS[stopTarget.phase]}.`));
    } finally {
      setStopping(false);
    }
  };

  const openRedeliverDialog = (row: ProductionDispatchItem) => {
    redeliverIntentKeyRef.current = createRedeliverIntentKey();
    setRedeliverTarget(row);
    setRedeliverReason("");
    setRedeliverConfirmation("");
    setRedeliverError(undefined);
  };

  const closeRedeliverDialog = () => {
    redeliverIntentKeyRef.current = "";
    setRedeliverTarget(null);
  };

  const cleanedRedeliverReason = redeliverReason.trim();
  const canSubmitRedeliver =
    cleanedRedeliverReason.length >= 3 &&
    cleanedRedeliverReason.length <= 280 &&
    redeliverConfirmation === REDELIVER_CONFIRM_PHRASE &&
    !redelivering;

  const onSubmitRedeliver = async (event: FormEvent) => {
    event.preventDefault();
    if (!redeliverTarget || redelivering) return;

    if (cleanedRedeliverReason.length < 3) {
      setRedeliverError("Enter a reason of at least 3 characters for the audit record.");
      return;
    }
    if (redeliverConfirmation !== REDELIVER_CONFIRM_PHRASE) {
      setRedeliverError(`Type ${REDELIVER_CONFIRM_PHRASE} in uppercase to confirm redelivery.`);
      return;
    }

    const intentKey =
      redeliverIntentKeyRef.current || (redeliverIntentKeyRef.current = createRedeliverIntentKey());

    setRedelivering(true);
    setRedeliverError(undefined);
    try {
      await stepUp.run(
        () =>
          prodClient.order.redeliver.mutate({
            orderPublicId: orderId,
            dispatchPublicId: redeliverTarget.publicId,
            reason: cleanedRedeliverReason,
            confirmation: REDELIVER_CONFIRM_PHRASE,
            idempotencyKey: intentKey,
          }),
        {
          reason:
            "Redelivering an already-delivered production webhook requires administrator verification.",
        },
      );
      toast.show({
        tone: "success",
        title: `${PHASE_LABELS[redeliverTarget.phase]} redelivery queued`,
        description: "Created a new delivery record linked to the original dispatch.",
      });
      closeRedeliverDialog();
      await refreshOrderProduction();
    } catch (err) {
      if (err instanceof StepUpCancelledError) {
        setTimeout(() => {
          redeliverReasonRef.current?.focus();
        }, 0);
        return;
      }
      setRedeliverError(errorMessage(err, "Could not queue the redelivery."));
    } finally {
      setRedelivering(false);
    }
  };

  const openResendDialog = (phase: "P101" | "P201") => {
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

  const renderedStageActionsSlot =
    stageActionsSlot !== undefined ? (
      stageActionsSlot
    ) : LazyWorkflowStageActionsSlot ? (
      <OptionalSlotBoundary>
        <Suspense fallback={null}>
          <LazyWorkflowStageActionsSlot orderId={orderId} />
        </Suspense>
      </OptionalSlotBoundary>
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6 pt-2">
      {renderedStageActionsSlot}

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
                <Link href={settingsHref}>Configure production pipeline</Link>
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
        <Callout tone="danger" live="assertive" title="Automation trigger refused">
          {actionError}
        </Callout>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 min-[900px]:grid-cols-2">
        {/* Left column: Phase I (P101) and Phase II (P201) actions & payloads */}
        <div className="flex min-w-0 flex-col gap-6">
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

              {!canStartP101 ? (
                <DisabledReasonsNotice
                  phaseLabel="Phase I (P101)"
                  reasons={p101DisabledReasons}
                  isAdmin={isAdmin}
                  settingsHref={settingsHref}
                />
              ) : null}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  disabled={!canStartP101}
                  onClick={() => {
                    setActionError(undefined);
                    setConfirmStartPhase("P101");
                  }}
                >
                  {PHASE_START_LABELS.P101}
                </Button>

                {canResendUnknownP101 ? (
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

              {!canStartP201 ? (
                <DisabledReasonsNotice
                  phaseLabel="Phase II (P201)"
                  reasons={p201DisabledReasons}
                  isAdmin={isAdmin}
                  settingsHref={settingsHref}
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
                  {PHASE_START_LABELS.P201}
                </Button>

                {canResendUnknownP201 ? (
                  <Button variant="secondary" onClick={() => openResendDialog("P201")}>
                    Re-send Phase II
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        </div>

        {/* Right column: Webhook rules, optional Phase III / IV, and order pipeline history */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card
            as="section"
            className="min-w-0"
            title="Webhook rules"
            description="Canonical payload invariants enforced before any production webhook leaves the portal."
          >
            <ul className="list-disc space-y-2 pl-5 text-sm text-body">
              <li>
                Phase II (<code className="font-mono text-xs">P201</code>) and later phases must
                match Phase I (<code className="font-mono text-xs">P101</code>) on{" "}
                <code className="font-mono text-xs">customer_id</code>,{" "}
                <code className="font-mono text-xs">order_id</code>, and{" "}
                <code className="font-mono text-xs">run_mode</code>.
              </li>
              <li>
                The <code className="font-mono text-xs">bundle_scope_manifest</code> field is sent
                as a JSON string, never an unescaped object.
              </li>
              <li>
                Do not start Phase II (<code className="font-mono text-xs">P201</code>) before the
                Phase I final output artifacts exist in the downstream workspace.
              </li>
            </ul>
          </Card>

          {hasConfiguredLaterPhase ? (
            <Card
              as="section"
              className="min-w-0"
              title="Later phases"
              description="Optional downstream phases configured for this installation, using the canonical customer_id, order_id, and run_mode from Phase I."
            >
              <div className="flex flex-col gap-5">
                {p301.configured ? (
                  <div className="flex flex-col gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink">{PHASE_LABELS.P301}</h3>
                      <PhaseStateBadge
                        activeState={p301.activeState}
                        alreadyDelivered={p301.alreadyDelivered}
                        fallbackLabel={
                          p301.prerequisiteDelivered ? "Ready" : "Waiting for earlier phases"
                        }
                        fallbackTone={p301.prerequisiteDelivered ? "info" : "neutral"}
                      />
                    </div>

                    {p301.payload ? (
                      <CodeBlock label="Phase III (P301) payload preview" copyable wrap>
                        {JSON.stringify(p301.payload, null, 2)}
                      </CodeBlock>
                    ) : null}

                    {!canStartLaterPhase(p301) ? (
                      <DisabledReasonsNotice
                        phaseLabel="Phase III (P301)"
                        reasons={buildLaterPhaseDisabledReasons("P301", p301)}
                        isAdmin={isAdmin}
                        settingsHref={settingsHref}
                      />
                    ) : null}

                    <div>
                      <Button
                        disabled={!canStartLaterPhase(p301)}
                        onClick={() => {
                          setActionError(undefined);
                          setConfirmStartPhase("P301");
                        }}
                      >
                        {PHASE_START_LABELS.P301}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {p401.configured ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink">{PHASE_LABELS.P401}</h3>
                      <PhaseStateBadge
                        activeState={p401.activeState}
                        alreadyDelivered={p401.alreadyDelivered}
                        fallbackLabel={
                          p401.prerequisiteDelivered ? "Ready" : "Waiting for earlier phases"
                        }
                        fallbackTone={p401.prerequisiteDelivered ? "info" : "neutral"}
                      />
                    </div>

                    {p401.payload ? (
                      <CodeBlock label="Phase IV (P401) payload preview" copyable wrap>
                        {JSON.stringify(p401.payload, null, 2)}
                      </CodeBlock>
                    ) : null}

                    {!canStartLaterPhase(p401) ? (
                      <DisabledReasonsNotice
                        phaseLabel="Phase IV (P401)"
                        reasons={buildLaterPhaseDisabledReasons("P401", p401)}
                        isAdmin={isAdmin}
                        settingsHref={settingsHref}
                      />
                    ) : null}

                    <div>
                      <Button
                        disabled={!canStartLaterPhase(p401)}
                        onClick={() => {
                          setActionError(undefined);
                          setConfirmStartPhase("P401");
                        }}
                      >
                        {PHASE_START_LABELS.P401}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Section
            title="This order's pipeline history"
            description="Recorded production webhook dispatches, delivery attempts, correlation references, retries, and redeliveries for this order."
          >
            <DataTable<ProductionDispatchItem>
              caption="This order's pipeline history"
              rows={history.data.items}
              rowKey={(row) => row.publicId}
              empty={
                <EmptyState
                  title="No production dispatches for this order"
                  description="Pipeline phase triggers started for this order are recorded here with their delivery status and audit correlation references."
                  headingLevel={3}
                />
              }
              columns={[
                {
                  key: "phase",
                  header: "Phase",
                  primary: true,
                  cell: (row) => (
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-ink">{PHASE_LABELS[row.phase]}</span>
                      {row.packet && row.tier ? (
                        <div className="text-xs text-muted">
                          Packet {row.packet} · {row.tier}
                        </div>
                      ) : null}
                      {row.redeliveryOf ? (
                        <div>
                          <Badge tone="info">
                            Redelivery of {shortPublicId(row.redeliveryOf)}
                          </Badge>
                        </div>
                      ) : null}
                      {row.retryOf ? (
                        <div>
                          <Badge tone="neutral">Retry of {shortPublicId(row.retryOf)}</Badge>
                        </div>
                      ) : null}
                      {row.triggerSource ? (
                        <div className="text-xs text-muted">
                          {formatTriggerSource(row.triggerSource)}
                          {row.stageKey ? ` · Phase ${row.stageKey}` : ""}
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
                  key: "response",
                  header: "HTTP & outcome",
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
                          Reason: {row.resendReason}
                        </div>
                      ) : null}
                      {row.stopReason ? (
                        <div className="mt-0.5 break-words text-xs text-muted">
                          Stopped: {row.stopReason}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "requestedAt",
                  header: "Times",
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
                  key: "actions",
                  header: "Audit & actions",
                  cell: (row) => {
                    const canStop = row.state === "queued";
                    const canRetry = featureEnabled && retryableIds.has(row.publicId);
                    const canRedeliver = isAdmin && featureEnabled && row.state === "delivered";
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={auditCorrelationHref(row.correlationId)}
                          aria-label={`${shortPublicId(row.correlationId)}, audit correlation ${row.correlationId}`}
                          className="inline-flex min-h-9 items-center font-mono text-xs font-semibold text-action underline underline-offset-4"
                        >
                          {shortPublicId(row.correlationId)}
                        </Link>
                        {canStop ? (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => openStopDialog(row)}
                            aria-label={`Stop ${PHASE_LABELS[row.phase]}`}
                          >
                            Stop
                          </Button>
                        ) : null}
                        {row.state === "sending" ? (
                          <span className="text-xs text-muted">In flight (cannot stop)</span>
                        ) : null}
                        {canRetry ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={retryingDispatchId === row.publicId}
                            onClick={() => void onRetryDispatch(row)}
                            aria-label={`Retry ${PHASE_LABELS[row.phase]}`}
                          >
                            Retry
                          </Button>
                        ) : null}
                        {canRedeliver ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openRedeliverDialog(row)}
                            aria-label={`Redeliver ${PHASE_LABELS[row.phase]}`}
                          >
                            Redeliver
                          </Button>
                        ) : null}
                      </div>
                    );
                  },
                },
              ]}
            />
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmStartPhase !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmStartPhase(null);
        }}
        title={confirmStartPhase ? `${PHASE_START_LABELS[confirmStartPhase]} (${confirmStartPhase})?` : "Start phase?"}
        description={
          confirmStartPhase === "P101"
            ? "This queues the canonical Phase I intake webhook (including the order owner's name and email) for delivery to the production pipeline."
            : confirmStartPhase
              ? `This queues ${PHASE_LABELS[confirmStartPhase]} using the exact customer_id, order_id, and run_mode from Phase I.`
              : ""
        }
        confirmLabel={confirmStartPhase ? PHASE_START_LABELS[confirmStartPhase] : "Confirm"}
        onConfirm={() =>
          confirmStartPhase ? executeStartPhase(confirmStartPhase) : Promise.resolve()
        }
      />

      {/* Stop dialog for queued production dispatches */}
      <Dialog
        open={stopTarget !== null}
        onOpenChange={(open) => {
          if (!open && !stopping) setStopTarget(null);
        }}
        dismissible={!stopping}
        title={stopTarget ? `Stop ${PHASE_LABELS[stopTarget.phase]}?` : "Stop queued dispatch?"}
        description="Stopping cancels this queued dispatch before worker delivery. Dispatches already sending on the wire cannot be stopped."
      >
        <form onSubmit={(e) => void onSubmitStop(e)} noValidate className="flex flex-col gap-4">
          {stopError ? (
            <Callout tone="danger" live="assertive">
              {stopError}
            </Callout>
          ) : null}

          <Field
            label="Reason for stopping (optional)"
            hint="Recorded in the audit trail (up to 240 characters)."
          >
            <Textarea
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value)}
              maxLength={240}
              rows={2}
              disabled={stopping}
            />
          </Field>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => setStopTarget(null)}
              disabled={stopping}
            >
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={stopping}>
              Stop dispatch
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Administrator step-up Redeliver dialog for already-delivered dispatches */}
      <Dialog
        open={redeliverTarget !== null}
        onOpenChange={(open) => {
          if (!open && !redelivering) closeRedeliverDialog();
        }}
        dismissible={!redelivering}
        initialFocusRef={redeliverReasonRef}
        title={
          redeliverTarget
            ? `Redeliver ${PHASE_LABELS[redeliverTarget.phase]}`
            : "Redeliver production webhook"
        }
        description="Redelivering an already-delivered webhook creates a new delivery record linked to the original dispatch and requires administrator verification."
      >
        <form
          onSubmit={(e) => void onSubmitRedeliver(e)}
          noValidate
          className="flex flex-col gap-4"
        >
          <Callout tone="warning" title="Downstream duplicate-run warning">
            This dispatch was already accepted by the webhook endpoint. Redelivery sends a new
            delivery record marked with{" "}
            <code className="font-mono text-xs">redeliveryOf</code> and{" "}
            <code className="font-mono text-xs">X-ReadyPackets-Redelivery-Of</code>, which may
            re-run downstream pipeline work.
          </Callout>

          {redeliverError ? (
            <Callout tone="danger" live="assertive">
              {redeliverError}
            </Callout>
          ) : null}

          <Field
            label="Reason for redelivery"
            hint="Recorded in the durable audit log (3 to 280 characters)."
            required
          >
            <Textarea
              ref={redeliverReasonRef}
              value={redeliverReason}
              onChange={(e) => setRedeliverReason(e.target.value)}
              maxLength={280}
              rows={3}
            />
          </Field>

          <Field
            label={`Type ${REDELIVER_CONFIRM_PHRASE} to confirm`}
            hint={`Enter ${REDELIVER_CONFIRM_PHRASE} in uppercase to enable redelivery.`}
            required
          >
            <Input
              value={redeliverConfirmation}
              onChange={(e) => setRedeliverConfirmation(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
            />
          </Field>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={closeRedeliverDialog}
              disabled={redelivering}
            >
              Cancel
            </Button>
            <Button type="submit" loading={redelivering} disabled={!canSubmitRedeliver}>
              Confirm redelivery
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Administrator step-up Re-send dialog preserved for `unknown` delivery outcome recovery */}
      <Dialog
        open={resendPhase !== null}
        onOpenChange={(open) => {
          if (!open && !resending) setResendPhase(null);
        }}
        title={resendPhase ? `Re-send ${PHASE_LABELS[resendPhase]}` : "Re-send webhook"}
        description="Re-sending creates a new audited dispatch and requires administrator multi-factor verification."
      >
        <form onSubmit={(e) => void onSubmitResend(e)} noValidate className="flex flex-col gap-4">
          <Callout tone="warning">
            Verify downstream workflow executions and output folders before re-sending. A re-send
            issues a new idempotency key and may duplicate work if an earlier uncertain or delivered
            request already ran.
          </Callout>

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
