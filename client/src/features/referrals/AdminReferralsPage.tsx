import { roleHasCapability } from "@shared/capabilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Gift,
  UserPlus,
  Wallet,
  XCircle,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  DateTime,
  Dialog,
  DialogClose,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  LoadMore,
  Money,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  StatCard,
  StatGrid,
  StepUpCancelledError,
  Switch,
  Tabs,
  Textarea,
  useStepUp,
  useToast,
  type Column,
} from "@/ui";
import { useReferralsClient, useReferralsTRPC } from "./api";
import {
  formatBpsToPercentInput,
  formatMinorToMajorInput,
  parseMajorToMinor,
  parsePercentToBps,
  REFERRAL_STATUS_META,
  type AdminReferralItemView,
  type AdminReferralsSettingsView,
  type AdminRewardLedgerItemView,
  type ReferralLedgerEntryType,
  type ReferralPayoutMethod,
  type ReferralRewardMode,
  type ReferralStatus,
} from "./model";

function statusIcon(status: ReferralStatus) {
  switch (status) {
    case "attributed":
      return <UserPlus aria-hidden="true" />;
    case "qualified_pending_approval":
      return <Clock aria-hidden="true" />;
    case "approved":
      return <CheckCircle2 aria-hidden="true" />;
    case "credited":
      return <Wallet aria-hidden="true" />;
    case "rejected":
      return <XCircle aria-hidden="true" />;
  }
}

function triggerFileDownload(filename: string, contentType: string, body: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([body], { type: contentType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

interface ProgramSettingsFormProps {
  initial: AdminReferralsSettingsView;
  canManage: boolean;
  onSaved: () => Promise<void>;
}

function ProgramSettingsForm({ initial, canManage, onSaved }: ProgramSettingsFormProps) {
  const client = useReferralsClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [rewardMode, setRewardMode] = useState<ReferralRewardMode>(initial.config.rewardMode);
  const [fixedMajor, setFixedMajor] = useState<string>(
    formatMinorToMajorInput(initial.config.fixedAmountMinor),
  );
  const [percentInput, setPercentInput] = useState<string>(
    formatBpsToPercentInput(initial.config.percentBps),
  );
  const [capMajor, setCapMajor] = useState<string>(
    formatMinorToMajorInput(initial.config.capAmountMinor),
  );
  const [currency, setCurrency] = useState<string>(initial.config.currency);
  const [manualApprovalRequired, setManualApprovalRequired] = useState<boolean>(
    initial.config.manualApprovalRequired,
  );
  const [maxPerDay, setMaxPerDay] = useState<string>(
    String(initial.config.inviteMaxPerCustomerPerDay),
  );
  const [maxPerRecipient, setMaxPerRecipient] = useState<string>(
    String(initial.config.inviteMaxPerRecipientPerWindow),
  );
  const [cooldownHours, setCooldownHours] = useState<string>(
    String(initial.config.inviteRecipientCooldownHours),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage) return;

    const nextErrors: Record<string, string> = {};
    const fixedMinor = parseMajorToMinor(fixedMajor);
    if (fixedMinor === null) {
      nextErrors.fixedMajor = "Enter a valid non-negative amount (for example 25.00).";
    }
    const bps = parsePercentToBps(percentInput);
    if (bps === null) {
      nextErrors.percentInput = "Enter a percentage between 0.01 and 100.";
    }
    const capMinor = parseMajorToMinor(capMajor);
    if (capMinor === null) {
      nextErrors.capMajor = "Enter a valid non-negative cap amount (for example 100.00).";
    }
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      nextErrors.currency = "Enter a 3-letter uppercase ISO currency code (for example USD).";
    }
    const parsedMaxDay = Number(maxPerDay.trim());
    if (!Number.isInteger(parsedMaxDay) || parsedMaxDay < 1 || parsedMaxDay > 100) {
      nextErrors.maxPerDay = "Enter a whole number between 1 and 100.";
    }
    const parsedMaxRecipient = Number(maxPerRecipient.trim());
    if (!Number.isInteger(parsedMaxRecipient) || parsedMaxRecipient < 1 || parsedMaxRecipient > 5) {
      nextErrors.maxPerRecipient = "Enter a whole number between 1 and 5.";
    }
    const parsedCooldown = Number(cooldownHours.trim());
    if (!Number.isInteger(parsedCooldown) || parsedCooldown < 1 || parsedCooldown > 720) {
      nextErrors.cooldownHours = "Enter hours between 1 and 720.";
    }

    setErrors(nextErrors);
    if (
      Object.keys(nextErrors).length > 0 ||
      fixedMinor === null ||
      bps === null ||
      capMinor === null
    ) {
      return;
    }

    setSaving(true);
    try {
      await stepUp.run(
        () =>
          client.updateSettings({
            enabled,
            config: {
              rewardMode,
              fixedAmountMinor: fixedMinor,
              percentBps: bps,
              capAmountMinor: capMinor,
              currency: normalizedCurrency,
              manualApprovalRequired,
              inviteMaxPerCustomerPerDay: parsedMaxDay,
              inviteMaxPerRecipientPerWindow: parsedMaxRecipient,
              inviteRecipientCooldownHours: parsedCooldown,
            },
          }),
        { reason: "Update referral programme settings" },
      );
      await onSaved();
      toast.show({
        tone: "success",
        title: "Referral settings saved",
        description: enabled
          ? "The customer referral programme is enabled."
          : "The customer referral programme is disabled.",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not save referral settings",
        description: errorMessage(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex min-w-0 flex-col gap-6">
      <Card
        title="Programme availability and approval"
        description="The referral programme ships disabled by default. Switching it on or changing reward rules is durably audited."
        headingLevel={2}
      >
        <div className="flex min-w-0 flex-col gap-5">
          <Switch
            label="Enable customer referral programme"
            description="Shows Referrals under Account navigation and allows attribution at registration."
            checked={enabled}
            onCheckedChange={(v) => canManage && setEnabled(v)}
          />
          <Switch
            label="Require manual administrator approval"
            description="When enabled (default), qualified referrals stay pending until an administrator reviews and approves them."
            checked={manualApprovalRequired}
            onCheckedChange={(v) => canManage && setManualApprovalRequired(v)}
          />
        </div>
      </Card>

      <Card
        title="Reward calculation"
        description="Rewards are computed in integer minor units when a referred customer's first invoice is paid in full."
        headingLevel={2}
      >
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium text-ink">Reward calculation mode</span>
            <SegmentedControl
              label="Reward calculation mode"
              options={[
                { value: "fixed", label: "Fixed credit" },
                { value: "percent", label: "Percentage with cap" },
              ]}
              value={rewardMode}
              onValueChange={(v) => canManage && setRewardMode(v)}
            />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
            <Field
              label="Programme currency (ISO 4217)"
              hint="3-letter uppercase code (e.g. USD)."
              error={errors.currency}
              required
            >
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                disabled={!canManage}
              />
            </Field>

            {rewardMode === "fixed" ? (
              <Field
                label="Fixed credit amount"
                hint="Major currency units (stored as integer minor units)."
                error={errors.fixedMajor}
                required
              >
                <Input
                  inputMode="decimal"
                  value={fixedMajor}
                  onChange={(e) => setFixedMajor(e.target.value)}
                  maxLength={12}
                  disabled={!canManage}
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Reward percentage (%)"
                  hint="Applied to net pre-tax first-invoice amount."
                  error={errors.percentInput}
                  required
                >
                  <Input
                    inputMode="decimal"
                    value={percentInput}
                    onChange={(e) => setPercentInput(e.target.value)}
                    maxLength={6}
                    disabled={!canManage}
                  />
                </Field>
                <Field
                  label="Maximum reward cap"
                  hint="Upper bound per referral in programme currency."
                  error={errors.capMajor}
                  required
                >
                  <Input
                    inputMode="decimal"
                    value={capMajor}
                    onChange={(e) => setCapMajor(e.target.value)}
                    maxLength={12}
                    disabled={!canManage}
                  />
                </Field>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Invitation anti-abuse limits"
        description="Protects outbound mail reputation by bounding referral e-mail invitations per customer and per recipient."
        headingLevel={2}
      >
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
          <Field
            label="Max invitations per customer (24h)"
            hint="1 to 100 invitations per rolling 24 hours."
            error={errors.maxPerDay}
            required
          >
            <Input
              inputMode="numeric"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
              maxLength={3}
              disabled={!canManage}
            />
          </Field>
          <Field
            label="Max invitations per recipient"
            hint="Across all senders within cooldown window (1 to 5)."
            error={errors.maxPerRecipient}
            required
          >
            <Input
              inputMode="numeric"
              value={maxPerRecipient}
              onChange={(e) => setMaxPerRecipient(e.target.value)}
              maxLength={2}
              disabled={!canManage}
            />
          </Field>
          <Field
            label="Recipient cooldown window (hours)"
            hint="Default 168 hours (7 days)."
            error={errors.cooldownHours}
            required
          >
            <Input
              inputMode="numeric"
              value={cooldownHours}
              onChange={(e) => setCooldownHours(e.target.value)}
              maxLength={3}
              disabled={!canManage}
            />
          </Field>
        </div>

        {canManage ? (
          <div className="mt-5 flex justify-end">
            <Button type="submit" variant="primary" loading={saving}>
              Save programme settings
            </Button>
          </div>
        ) : null}
      </Card>
    </form>
  );
}

export default function AdminReferralsPage() {
  const { me } = useSession();
  const canManage = me ? roleHasCapability(me.user.role, "referrals.manage") : false;

  const trpc = useReferralsTRPC();
  const client = useReferralsClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<string>("referrals");

  // Referrals list filters
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReferralStatus | "">("");
  const [extraReferrals, setExtraReferrals] = useState<AdminReferralItemView[]>([]);
  const [referralsCursor, setReferralsCursor] = useState<string | null | undefined>(undefined);
  const [loadingMoreReferrals, setLoadingMoreReferrals] = useState(false);

  // Ledger filters
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<ReferralLedgerEntryType | "">("");
  const [extraLedger, setExtraLedger] = useState<AdminRewardLedgerItemView[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState<string | null | undefined>(undefined);
  const [loadingMoreLedger, setLoadingMoreLedger] = useState(false);

  // Dialog states
  const [approveTarget, setApproveTarget] = useState<AdminReferralItemView | null>(null);
  const [approveMajorInput, setApproveMajorInput] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const [rejectTarget, setRejectTarget] = useState<AdminReferralItemView | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const [creditTarget, setCreditTarget] = useState<AdminReferralItemView | null>(null);
  const [creditMethod, setCreditMethod] = useState<ReferralPayoutMethod>("account_credit");
  const [creditReference, setCreditReference] = useState("");
  const [creditNote, setCreditNote] = useState("");
  const [creditError, setCreditError] = useState<string | null>(null);
  const [crediting, setCrediting] = useState(false);

  const [exportingFormat, setExportingFormat] = useState<"csv" | "json" | null>(null);

  const settingsQuery = useQuery(trpc.adminGetSettings.queryOptions());
  const listInput = {
    status: statusFilter || undefined,
    query: appliedQuery || undefined,
    limit: 25,
  };
  const referralsQuery = useQuery(trpc.adminList.queryOptions(listInput));

  const ledgerInput = {
    entryType: ledgerTypeFilter || undefined,
    limit: 25,
  };
  const ledgerQuery = useQuery(trpc.adminLedger.queryOptions(ledgerInput));

  const refreshAll = async () => {
    setExtraReferrals([]);
    setReferralsCursor(undefined);
    setExtraLedger([]);
    setLedgerCursor(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.adminGetSettings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.adminList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.adminLedger.queryKey() }),
    ]);
  };

  if (settingsQuery.isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Referrals"
          description="Configure customer referral rewards, review qualified referrals, and manage the reward ledger."
        />
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Referrals"
          description="Configure customer referral rewards, review qualified referrals, and manage the reward ledger."
        />
        <ErrorState
          error={settingsQuery.error}
          title="Unable to load referral console"
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  const settings = settingsQuery.data;
  const referralRows = referralsQuery.data
    ? [...referralsQuery.data.items, ...extraReferrals]
    : [];
  const effectiveReferralsCursor =
    referralsCursor === undefined ? (referralsQuery.data?.nextCursor ?? null) : referralsCursor;

  const ledgerRows = ledgerQuery.data ? [...ledgerQuery.data.items, ...extraLedger] : [];
  const effectiveLedgerCursor =
    ledgerCursor === undefined ? (ledgerQuery.data?.nextCursor ?? null) : ledgerCursor;

  const activeFilterCount = (appliedQuery ? 1 : 0) + (statusFilter ? 1 : 0);

  const handleResetFilters = () => {
    setSearchDraft("");
    setAppliedQuery("");
    setStatusFilter("");
    setExtraReferrals([]);
    setReferralsCursor(undefined);
  };

  const handleLoadMoreReferrals = async () => {
    if (!effectiveReferralsCursor || loadingMoreReferrals) return;
    setLoadingMoreReferrals(true);
    try {
      const more = await queryClient.fetchQuery(
        trpc.adminList.queryOptions({
          ...listInput,
          cursor: effectiveReferralsCursor,
        }),
      );
      setExtraReferrals((prev) => [...prev, ...more.items]);
      setReferralsCursor(more.nextCursor);
    } catch (err) {
      toast.show({
        tone: "danger",
        title: "Could not load more referrals",
        description: errorMessage(err),
      });
    } finally {
      setLoadingMoreReferrals(false);
    }
  };

  const handleLoadMoreLedger = async () => {
    if (!effectiveLedgerCursor || loadingMoreLedger) return;
    setLoadingMoreLedger(true);
    try {
      const more = await queryClient.fetchQuery(
        trpc.adminLedger.queryOptions({
          ...ledgerInput,
          cursor: effectiveLedgerCursor,
        }),
      );
      setExtraLedger((prev) => [...prev, ...more.items]);
      setLedgerCursor(more.nextCursor);
    } catch (err) {
      toast.show({
        tone: "danger",
        title: "Could not load more ledger rows",
        description: errorMessage(err),
      });
    } finally {
      setLoadingMoreLedger(false);
    }
  };

  const openApproveModal = (row: AdminReferralItemView) => {
    setApproveTarget(row);
    setApproveMajorInput(
      row.rewardAmountMinor > 0 ? formatMinorToMajorInput(row.rewardAmountMinor) : "",
    );
    setApproveNote("");
    setApproveError(null);
  };

  const submitApprove = async (event: FormEvent) => {
    event.preventDefault();
    if (!approveTarget) return;
    const parsedMinor = parseMajorToMinor(approveMajorInput);
    if (parsedMinor === null || parsedMinor <= 0) {
      setApproveError("Enter a positive reward amount (for example 25.00).");
      return;
    }
    setApproveError(null);
    setApproving(true);
    try {
      const overrideAmountMinor =
        parsedMinor !== approveTarget.rewardAmountMinor ||
        approveTarget.qualificationNoteCode === "CURRENCY_MISMATCH"
          ? parsedMinor
          : undefined;
      await stepUp.run(
        () =>
          client.approve({
            referralPublicId: approveTarget.referralPublicId,
            expectedVersion: approveTarget.version,
            overrideAmountMinor,
            note: approveNote.trim() || undefined,
          }),
        { reason: "Approve referral reward" },
      );
      setApproveTarget(null);
      await refreshAll();
      toast.show({
        tone: "success",
        title: "Referral approved",
        description: "Reward entry appended to the referral ledger.",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setApproveError(errorMessage(err));
    } finally {
      setApproving(false);
    }
  };

  const openRejectModal = (row: AdminReferralItemView) => {
    setRejectTarget(row);
    setRejectReason("");
    setRejectError(null);
  };

  const submitReject = async (event: FormEvent) => {
    event.preventDefault();
    if (!rejectTarget) return;
    if (rejectReason.trim().length < 3) {
      setRejectError("Enter a rejection reason of at least 3 characters.");
      return;
    }
    setRejectError(null);
    setRejecting(true);
    try {
      await stepUp.run(
        () =>
          client.reject({
            referralPublicId: rejectTarget.referralPublicId,
            expectedVersion: rejectTarget.version,
            reason: rejectReason.trim(),
          }),
        { reason: "Reject referral" },
      );
      setRejectTarget(null);
      await refreshAll();
      toast.show({
        tone: "info",
        title: "Referral rejected",
        description: "The referral status has been updated to rejected.",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setRejectError(errorMessage(err));
    } finally {
      setRejecting(false);
    }
  };

  const openCreditModal = (row: AdminReferralItemView) => {
    setCreditTarget(row);
    setCreditMethod("account_credit");
    setCreditReference("");
    setCreditNote("");
    setCreditError(null);
  };

  const submitCredit = async (event: FormEvent) => {
    event.preventDefault();
    if (!creditTarget) return;
    if (creditReference.trim().length < 2) {
      setCreditError("Enter an invoice, credit memo, or payout reference.");
      return;
    }
    setCreditError(null);
    setCrediting(true);
    try {
      await stepUp.run(
        () =>
          client.markCredited({
            referralPublicId: creditTarget.referralPublicId,
            expectedVersion: creditTarget.version,
            payoutMethod: creditMethod,
            reference: creditReference.trim(),
            note: creditNote.trim() || undefined,
          }),
        { reason: "Record referral credit or payout" },
      );
      setCreditTarget(null);
      await refreshAll();
      toast.show({
        tone: "success",
        title: "Credit recorded",
        description: "The referral is marked credited and recorded in the reward ledger.",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setCreditError(errorMessage(err));
    } finally {
      setCrediting(false);
    }
  };

  const handleExport = async (format: "csv" | "json") => {
    if (!canManage || exportingFormat) return;
    setExportingFormat(format);
    try {
      const payload = await stepUp.run(
        () =>
          client.exportReferrals({
            format,
            status: statusFilter || undefined,
            query: appliedQuery || undefined,
          }),
        { reason: `Export referrals (${format.toUpperCase()})` },
      );
      triggerFileDownload(payload.filename, payload.contentType, payload.body);
      toast.show({
        tone: "success",
        title: `Exported ${payload.rowCount} referral rows`,
        description: payload.filename,
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Export failed",
        description: errorMessage(err),
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const referralColumns: Column<AdminReferralItemView>[] = [
    {
      key: "code",
      header: "Referral",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-sm font-semibold text-ink break-words">
            {row.codeSnapshot}
          </span>
          <span className="text-xs text-muted break-words">{row.referralPublicId}</span>
        </div>
      ),
    },
    {
      key: "referrer",
      header: "Referrer",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-ink break-words">{row.referrerName}</span>
          {row.referrerCustomerRef ? (
            <span className="text-xs text-muted">{row.referrerCustomerRef}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "referred",
      header: "Referred customer",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-ink break-words">{row.referredName}</span>
          {row.referredCustomerRef ? (
            <span className="text-xs text-muted">{row.referredCustomerRef}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => {
        const meta = REFERRAL_STATUS_META[row.status];
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone} icon={statusIcon(row.status)}>
              {meta.label}
            </Badge>
            {row.qualificationNoteCode === "CURRENCY_MISMATCH" ? (
              <Badge tone="warning" icon={<AlertTriangle aria-hidden="true" />}>
                Currency mismatch
              </Badge>
            ) : null}
            {row.qualificationNoteCode === "QUALIFYING_INVOICE_REFUNDED" ? (
              <Badge tone="warning" icon={<AlertTriangle aria-hidden="true" />}>
                Qualifying invoice refunded
              </Badge>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "reward",
      header: "Reward",
      align: "end",
      cell: (row) => (
        <div className="flex flex-col items-end">
          <Money value={{ amountMinor: row.rewardAmountMinor, currency: row.currency }} />
          {row.payoutReference ? (
            <span className="text-xs text-muted break-words">Ref: {row.payoutReference}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "attributedAt",
      header: "Attributed",
      hideOnMobile: true,
      cell: (row) => <DateTime value={row.attributedAt} format="date" />,
    },
  ];

  const ledgerColumns: Column<AdminRewardLedgerItemView>[] = [
    {
      key: "ledger",
      header: "Ledger entry",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-xs font-medium text-ink break-words">
            {row.ledgerPublicId}
          </span>
          <span className="text-xs text-muted break-words">Referral: {row.referralPublicId}</span>
        </div>
      ),
    },
    {
      key: "referrer",
      header: "Referrer",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="font-medium text-ink break-words">{row.referrerName}</span>
          {row.referrerCustomerRef ? (
            <span className="text-xs text-muted">{row.referrerCustomerRef}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "entryType",
      header: "Entry type",
      cell: (row) =>
        row.entryType === "reward_approved" ? (
          <Badge tone="success" icon={<CheckCircle2 aria-hidden="true" />}>
            Reward approved
          </Badge>
        ) : (
          <Badge tone="brand" icon={<Wallet aria-hidden="true" />}>
            Credit applied
          </Badge>
        ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "end",
      cell: (row) => <Money value={{ amountMinor: row.amountMinor, currency: row.currency }} />,
    },
    {
      key: "reference",
      header: "Method & reference",
      cell: (row) => (
        <div className="flex min-w-0 flex-col text-sm">
          <span className="text-body">
            {row.payoutMethod === "manual_payout"
              ? "Manual payout"
              : row.payoutMethod === "account_credit"
                ? "Account credit"
                : "Entitlement"}
          </span>
          {row.reference ? (
            <span className="text-xs text-muted break-words">{row.reference}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "createdAt",
      header: "Recorded",
      cell: (row) => <DateTime value={row.createdAt} format="datetime" />,
    },
  ];

  const settingsFormKey = `${String(settings.enabled)}:${JSON.stringify(settings.config)}`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Referrals"
        description="Configure customer referral rewards, review qualified first-invoice referrals, and record account credits."
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Download aria-hidden="true" />}
                loading={exportingFormat === "csv"}
                onClick={() => void handleExport("csv")}
              >
                Export CSV
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Download aria-hidden="true" />}
                loading={exportingFormat === "json"}
                onClick={() => void handleExport("json")}
              >
                Export JSON
              </Button>
            </div>
          ) : undefined
        }
      />

      {!settings.enabled ? (
        <Callout tone="warning" title="Not configured — Referral programme is disabled">
          Customer referral links and navigation entries remain hidden until an administrator
          enables the programme under Programme settings.
        </Callout>
      ) : null}

      {!canManage ? (
        <Callout tone="info" title="Read-only staff view">
          You can inspect referrals and ledger entries. Changing programme settings, approving or
          rejecting referrals, recording credits, and exporting data require administrator access.
        </Callout>
      ) : null}

      <StatGrid label="Referral programme summary">
        <StatCard
          label="Total referrals"
          value={settings.summary.totalReferrals}
          hint="Attributed at registration"
          icon={UserPlus}
          tone="neutral"
        />
        <StatCard
          label="Pending approval"
          value={settings.summary.pendingApproval}
          hint="First invoice paid, awaiting review"
          icon={Clock}
          tone="warning"
        />
        <StatCard
          label="Awaiting credit"
          value={settings.summary.approvedAwaitingCredit}
          hint={`${settings.summary.creditedCount} credited`}
          icon={CheckCircle2}
          tone="success"
        />
        <StatCard
          label="Approved value"
          value={
            <Money
              value={{
                amountMinor: settings.summary.approvedAmountMinor,
                currency: settings.summary.currency,
              }}
            />
          }
          hint="Approved + credited rewards"
          icon={Wallet}
          tone="info"
        />
      </StatGrid>

      <Tabs
        label="Referral management sections"
        value={activeTab}
        onValueChange={setActiveTab}
        items={[
          {
            value: "referrals",
            label: "Referrals",
            badge:
              settings.summary.pendingApproval > 0 ? (
                <Badge tone="warning">{settings.summary.pendingApproval}</Badge>
              ) : undefined,
            content: (
              <div className="flex min-w-0 flex-col gap-4 pt-4">
                <FilterBar
                  search={searchDraft}
                  onSearchChange={setSearchDraft}
                  onSearchSubmit={() => {
                    setAppliedQuery(searchDraft.trim());
                    setExtraReferrals([]);
                    setReferralsCursor(undefined);
                  }}
                  searchLabel="Search by 10-character referral code or referral ID"
                  activeCount={activeFilterCount}
                  onReset={handleResetFilters}
                >
                  <Field label="Status">
                    <Select
                      value={statusFilter}
                      onChange={(e) => {
                        setStatusFilter(e.target.value as ReferralStatus | "");
                        setExtraReferrals([]);
                        setReferralsCursor(undefined);
                      }}
                      options={[
                        { value: "", label: "All statuses" },
                        { value: "attributed", label: "Attributed" },
                        { value: "qualified_pending_approval", label: "Pending approval" },
                        { value: "approved", label: "Approved" },
                        { value: "credited", label: "Credited" },
                        { value: "rejected", label: "Rejected" },
                      ]}
                    />
                  </Field>
                </FilterBar>

                <DataTable
                  caption="Customer referrals"
                  columns={referralColumns}
                  rows={referralRows}
                  rowKey={(r) => r.referralPublicId}
                  loading={referralsQuery.isPending}
                  error={referralsQuery.isError ? referralsQuery.error : undefined}
                  onRetry={() => void referralsQuery.refetch()}
                  rowActions={
                    canManage
                      ? (row) => {
                          if (row.status === "qualified_pending_approval") {
                            return (
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => openApproveModal(row)}
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => openRejectModal(row)}
                                >
                                  Reject
                                </Button>
                              </div>
                            );
                          }
                          if (row.status === "attributed") {
                            return (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => openRejectModal(row)}
                              >
                                Reject
                              </Button>
                            );
                          }
                          if (row.status === "approved") {
                            return (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => openCreditModal(row)}
                              >
                                Mark credited
                              </Button>
                            );
                          }
                          return null;
                        }
                      : undefined
                  }
                  empty={
                    activeFilterCount > 0 ? (
                      <EmptyState
                        variant="filtered"
                        title="No matching referrals"
                        description="Adjust or clear your filters to view other referral records."
                        onClearFilters={handleResetFilters}
                        headingLevel={2}
                      />
                    ) : (
                      <EmptyState
                        variant="no-results"
                        icon={Gift}
                        title="No referrals recorded yet"
                        description="Customer attributions appear here once the referral programme is enabled and new customers register with a referral link."
                        headingLevel={2}
                      />
                    )
                  }
                />
                <LoadMore
                  hasMore={Boolean(effectiveReferralsCursor)}
                  loading={loadingMoreReferrals}
                  onLoadMore={() => void handleLoadMoreReferrals()}
                  summary={
                    referralRows.length > 0 ? `Showing ${referralRows.length} referrals` : undefined
                  }
                />
              </div>
            ),
          },
          {
            value: "ledger",
            label: "Reward ledger",
            content: (
              <div className="flex min-w-0 flex-col gap-4 pt-4">
                <div className="max-w-xs">
                  <Field label="Ledger entry type">
                    <Select
                      value={ledgerTypeFilter}
                      onChange={(e) => {
                        setLedgerTypeFilter(e.target.value as ReferralLedgerEntryType | "");
                        setExtraLedger([]);
                        setLedgerCursor(undefined);
                      }}
                      options={[
                        { value: "", label: "All ledger entries" },
                        { value: "reward_approved", label: "Reward approved" },
                        { value: "credit_applied", label: "Credit applied" },
                      ]}
                    />
                  </Field>
                </div>

                <DataTable
                  caption="Immutable referral reward ledger"
                  columns={ledgerColumns}
                  rows={ledgerRows}
                  rowKey={(r) => r.ledgerPublicId}
                  loading={ledgerQuery.isPending}
                  error={ledgerQuery.isError ? ledgerQuery.error : undefined}
                  onRetry={() => void ledgerQuery.refetch()}
                  empty={
                    <EmptyState
                      variant="no-results"
                      icon={Wallet}
                      title="No reward ledger entries yet"
                      description="Approved referral rewards and applied account credits are appended here permanently."
                      headingLevel={2}
                    />
                  }
                />
                <LoadMore
                  hasMore={Boolean(effectiveLedgerCursor)}
                  loading={loadingMoreLedger}
                  onLoadMore={() => void handleLoadMoreLedger()}
                  summary={
                    ledgerRows.length > 0 ? `Showing ${ledgerRows.length} ledger entries` : undefined
                  }
                />
              </div>
            ),
          },
          {
            value: "settings",
            label: "Programme settings",
            content: (
              <div className="pt-4">
                <ProgramSettingsForm
                  key={settingsFormKey}
                  initial={settings}
                  canManage={canManage}
                  onSaved={refreshAll}
                />
              </div>
            ),
          },
        ]}
      />

      {/* Approve Referral Dialog */}
      <Dialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
        title="Approve referral reward"
        description={
          approveTarget
            ? `Approve reward for ${approveTarget.referrerName} (${approveTarget.codeSnapshot}) and record an immutable reward ledger entry.`
            : undefined
        }
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose>
              <Button variant="secondary" disabled={approving}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form="approve-referral-form"
              variant="primary"
              loading={approving}
            >
              Approve reward
            </Button>
          </div>
        }
      >
        {approveTarget ? (
          <form id="approve-referral-form" onSubmit={submitApprove} noValidate className="flex flex-col gap-4">
            {approveTarget.qualificationNoteCode === "CURRENCY_MISMATCH" ? (
              <Callout tone="warning" title="Cross-currency invoice review">
                The referred customer paid an invoice in {approveTarget.invoiceCurrency ?? "another currency"}.
                Enter the approved credit amount in {approveTarget.currency}.
              </Callout>
            ) : null}
            <Field
              label={`Approved reward amount (${approveTarget.currency})`}
              hint="Major currency units (stored as integer minor units)."
              error={approveError ?? undefined}
              required
            >
              <Input
                inputMode="decimal"
                value={approveMajorInput}
                onChange={(e) => setApproveMajorInput(e.target.value)}
                maxLength={12}
              />
            </Field>
            <Field label="Review note (optional)" hint="Recorded in the referral record and ledger.">
              <Textarea
                rows={3}
                maxLength={500}
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
              />
            </Field>
          </form>
        ) : null}
      </Dialog>

      {/* Reject Referral Dialog */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        title="Reject referral"
        description={
          rejectTarget
            ? `Reject referral ${rejectTarget.codeSnapshot} (${rejectTarget.referredName}). Rejected referrals cannot be approved or credited later.`
            : undefined
        }
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose>
              <Button variant="secondary" disabled={rejecting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form="reject-referral-form"
              variant="danger"
              loading={rejecting}
            >
              Reject referral
            </Button>
          </div>
        }
      >
        <form id="reject-referral-form" onSubmit={submitReject} noValidate className="flex flex-col gap-4">
          <Field
            label="Rejection reason"
            hint="Required for auditability (3 to 500 characters)."
            error={rejectError ?? undefined}
            required
          >
            <Textarea
              rows={3}
              maxLength={500}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </Field>
        </form>
      </Dialog>

      {/* Mark Credited / Paid Dialog */}
      <Dialog
        open={creditTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCreditTarget(null);
        }}
        title="Mark referral credited or paid"
        description={
          creditTarget ? (
            <>
              Record settlement of{" "}
              <Money
                value={{
                  amountMinor: creditTarget.rewardAmountMinor,
                  currency: creditTarget.currency,
                }}
              />{" "}
              for {creditTarget.referrerName}.
            </>
          ) : undefined
        }
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose>
              <Button variant="secondary" disabled={crediting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form="credit-referral-form"
              variant="primary"
              loading={crediting}
            >
              Record credit
            </Button>
          </div>
        }
      >
        <form id="credit-referral-form" onSubmit={submitCredit} noValidate className="flex flex-col gap-4">
          <Field label="Settlement method" required>
            <Select
              value={creditMethod}
              onChange={(e) => setCreditMethod(e.target.value as ReferralPayoutMethod)}
              options={[
                { value: "account_credit", label: "Account credit applied to invoice" },
                { value: "manual_payout", label: "Manual payout" },
              ]}
            />
          </Field>
          <Field
            label="Credit or payout reference"
            hint="For example invoice number RP-INV-2026-000042 or credit memo ID."
            error={creditError ?? undefined}
            required
          >
            <Input
              value={creditReference}
              onChange={(e) => setCreditReference(e.target.value)}
              maxLength={160}
            />
          </Field>
          <Field label="Internal note (optional)">
            <Textarea
              rows={2}
              maxLength={500}
              value={creditNote}
              onChange={(e) => setCreditNote(e.target.value)}
            />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
