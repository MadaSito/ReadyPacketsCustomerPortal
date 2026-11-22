import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Gift,
  Mail,
  Share2,
  UserPlus,
  Wallet,
  XCircle,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, safeError } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CopyField,
  DataTable,
  DateTime,
  Dialog,
  DialogClose,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadMore,
  Money,
  PageHeader,
  Section,
  Skeleton,
  StatCard,
  StatGrid,
  useToast,
  type Column,
} from "@/ui";
import { useReferralsClient, useReferralsTRPC } from "./api";
import {
  formatBpsToPercentInput,
  REFERRAL_STATUS_META,
  type CustomerReferralHistoryItemView,
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

function canUseWebShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export default function CustomerReferralsPage() {
  const trpc = useReferralsTRPC();
  const client = useReferralsClient();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSending, setInviteSending] = useState(false);

  const [extraRows, setExtraRows] = useState<CustomerReferralHistoryItemView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const overviewQuery = useQuery(trpc.meOverview.queryOptions());
  const historyQuery = useQuery(
    trpc.meHistory.queryOptions(
      { limit: 25 },
      { enabled: overviewQuery.isSuccess },
    ),
  );

  const overviewErrorCode = safeError(overviewQuery.error)?.domainCode;
  const overviewReason = safeError(overviewQuery.error)?.reasonCode;
  const isDisabled =
    overviewErrorCode === "NOT_FOUND" || overviewReason === "REFERRALS_DISABLED";

  if (overviewQuery.isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Referrals"
          description="Share your referral link and track account credits."
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: "Account", href: "/account" },
                { label: "Referrals" },
              ]}
            />
          }
        />
        <Card>
          <Skeleton lines={4} />
        </Card>
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (isDisabled) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Referrals"
          description="Customer referral programme."
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: "Account", href: "/account" },
                { label: "Referrals" },
              ]}
            />
          }
        />
        <Card>
          <EmptyState
            variant="disabled"
            icon={Gift}
            title="The referral programme is not turned on"
            description="Referrals are currently disabled for this portal. Check back later or contact support if you have questions."
            headingLevel={2}
          />
        </Card>
      </div>
    );
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Referrals"
          description="Share your referral link and track account credits."
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: "Account", href: "/account" },
                { label: "Referrals" },
              ]}
            />
          }
        />
        <ErrorState
          error={overviewQuery.error}
          title="Unable to load your referral details"
          onRetry={() => void overviewQuery.refetch()}
        />
      </div>
    );
  }

  const overview = overviewQuery.data;
  const firstPage = historyQuery.data;
  const allRows = firstPage ? [...firstPage.items, ...extraRows] : [];
  const effectiveCursor = nextCursor === undefined ? (firstPage?.nextCursor ?? null) : nextCursor;

  const handleLoadMore = async () => {
    if (!effectiveCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const pageOpts = trpc.meHistory.queryOptions({ cursor: effectiveCursor, limit: 25 });
      const more = await queryClient.fetchQuery(pageOpts);
      setExtraRows((prev) => [...prev, ...more.items]);
      setNextCursor(more.nextCursor);
    } catch (err) {
      toast.show({
        tone: "danger",
        title: "Could not load more referrals",
        description: errorMessage(err),
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const handleWebShare = async () => {
    if (!canUseWebShare()) return;
    try {
      await navigator.share({
        title: "ReadyPackets referral link",
        text: `Use my ReadyPackets referral code ${overview.code} when creating your account.`,
        url: overview.shareUrl,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      toast.show({
        tone: "warning",
        title: "Sharing did not complete",
        description: "You can copy your referral link directly instead.",
      });
    }
  };

  const openInviteDialog = () => {
    setRecipientEmail("");
    setInviteError(null);
    setInviteOpen(true);
  };

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = recipientEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setInviteError("Enter a valid e-mail address.");
      return;
    }
    setInviteError(null);
    setInviteSending(true);
    try {
      await client.sendInviteEmail({ recipientEmail: trimmed });
      setInviteOpen(false);
      setRecipientEmail("");
      toast.show({
        tone: "success",
        title: "Invitation queued",
        description: "If that address is eligible, your referral link is on its way.",
      });
    } catch (err) {
      setInviteError(errorMessage(err, "Unable to send referral invitation."));
    } finally {
      setInviteSending(false);
    }
  };

  const columns: Column<CustomerReferralHistoryItemView>[] = [
    {
      key: "account",
      header: "Referred account",
      primary: true,
      cell: (row) => (
        <span className="font-medium text-ink break-words">{row.referredAccountHint}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => {
        const meta = REFERRAL_STATUS_META[row.status];
        return (
          <Badge tone={meta.tone} icon={statusIcon(row.status)}>
            {meta.customerLabel}
          </Badge>
        );
      },
    },
    {
      key: "reward",
      header: "Reward",
      align: "end",
      cell: (row) =>
        row.rewardAmountMinor > 0 ? (
          <Money value={{ amountMinor: row.rewardAmountMinor, currency: row.currency }} />
        ) : (
          <span className="text-muted">Pending</span>
        ),
    },
    {
      key: "attributedAt",
      header: "Signed up",
      cell: (row) => <DateTime value={row.attributedAt} format="date" />,
    },
    {
      key: "updatedAt",
      header: "Latest milestone",
      hideOnMobile: true,
      cell: (row) => {
        const milestone = row.creditedAt ?? row.reviewedAt ?? row.qualifiedAt ?? row.attributedAt;
        return <DateTime value={milestone} format="date" />;
      },
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Referrals"
        description="Share your personal referral link and earn account credit when a referred customer completes their first paid invoice."
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Account", href: "/account" },
              { label: "Referrals" },
            ]}
          />
        }
      />

      <Card
        title="Share your referral link"
        description="When someone opens your link, their registration is attributed to your code for up to 30 days."
        headingLevel={2}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-body break-words">
            {overview.program.rewardMode === "fixed" ? (
              <>
                Programme reward:{" "}
                <strong className="font-semibold text-ink">
                  <Money
                    value={{
                      amountMinor: overview.program.fixedAmountMinor,
                      currency: overview.program.currency,
                    }}
                  />
                </strong>{" "}
                in account credit once your referred colleague completes their first paid invoice
                {overview.program.manualApprovalRequired ? " and review is completed." : "."}
              </>
            ) : (
              <>
                Programme reward:{" "}
                <strong className="font-semibold text-ink">
                  {formatBpsToPercentInput(overview.program.percentBps)}%
                </strong>{" "}
                of net order value (capped at{" "}
                <strong className="font-semibold text-ink">
                  <Money
                    value={{
                      amountMinor: overview.program.capAmountMinor,
                      currency: overview.program.currency,
                    }}
                  />
                </strong>
                ) in account credit once your referred colleague completes their first paid invoice
                {overview.program.manualApprovalRequired ? " and review is completed." : "."}
              </>
            )}
          </p>

          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <CopyField
              label="Your referral code"
              value={overview.code}
              monospace
              copyLabel="Copy referral code"
              hint="10 characters without ambiguous letters or digits."
            />
            <CopyField
              label="Your referral link"
              value={overview.shareUrl}
              copyLabel="Copy referral link"
              hint="Opens the ReadyPackets registration page with your code."
            />
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-3 pt-1">
            <Button
              variant="primary"
              leadingIcon={<Mail aria-hidden="true" />}
              onClick={openInviteDialog}
            >
              E-mail my link
            </Button>
            {canUseWebShare() ? (
              <Button
                variant="secondary"
                leadingIcon={<Share2 aria-hidden="true" />}
                onClick={() => void handleWebShare()}
              >
                Share link
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <Section
        title="Summary"
        description="Overview of referrals attributed to your code and approved account credits."
        headingLevel={2}
      >
        <StatGrid label="Referral metrics">
          <StatCard
            label="Total referrals"
            value={overview.stats.total}
            hint="Registered with your code"
            icon={UserPlus}
            tone="neutral"
          />
          <StatCard
            label="Pending"
            value={overview.stats.pending}
            hint="Awaiting first paid invoice or review"
            icon={Clock}
            tone="warning"
          />
          <StatCard
            label="Approved"
            value={overview.stats.approved}
            hint={`${overview.stats.credited} credited to date`}
            icon={CheckCircle2}
            tone="success"
          />
          <StatCard
            label="Reward value"
            value={
              <Money
                value={{
                  amountMinor: overview.stats.approvedRewardMinor,
                  currency: overview.stats.currency,
                }}
              />
            }
            hint="Total approved account credit"
            icon={Wallet}
            tone="info"
          />
        </StatGrid>
      </Section>

      <Section
        title="Referral history"
        description="For privacy, referred accounts are shown with a masked identifier only."
        headingLevel={2}
      >
        <DataTable
          caption="Your referral history"
          columns={columns}
          rows={allRows}
          rowKey={(r) => r.referralPublicId}
          loading={historyQuery.isPending}
          error={historyQuery.isError ? historyQuery.error : undefined}
          onRetry={() => void historyQuery.refetch()}
          empty={
            <EmptyState
              variant="first-use"
              icon={Gift}
              title="No referrals yet"
              description="Share your referral link or send an e-mail invitation above to earn account credits."
              action={
                <Button variant="secondary" leadingIcon={<Mail aria-hidden="true" />} onClick={openInviteDialog}>
                  E-mail my link
                </Button>
              }
              headingLevel={3}
            />
          }
        />
        <LoadMore
          hasMore={Boolean(effectiveCursor)}
          loading={loadingMore}
          onLoadMore={() => void handleLoadMore()}
          summary={allRows.length > 0 ? `Showing ${allRows.length} referrals` : undefined}
        />
      </Section>

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="E-mail your referral link"
        description="We send a standard ReadyPackets invitation showing your account display name and referral link. Invitations are rate-limited per sender and per recipient."
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose>
              <Button variant="secondary" disabled={inviteSending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              form="referral-invite-form"
              variant="primary"
              loading={inviteSending}
              leadingIcon={<Mail aria-hidden="true" />}
            >
              Send invitation
            </Button>
          </div>
        }
      >
        <form id="referral-invite-form" onSubmit={submitInvite} noValidate className="flex flex-col gap-4">
          <Field
            label="Colleague e-mail address"
            hint="Your account name and referral link will be included automatically."
            error={inviteError ?? undefined}
            required
          >
            <Input
              type="email"
              name="recipientEmail"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
            />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
