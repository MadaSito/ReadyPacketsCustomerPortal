import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { type JSX } from "react";
import type { AdminCheckWithStripeInput, AdminCheckWithStripeResult } from "@server/modules/payments/service";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, StepUpCancelledError, useStepUp, useToast } from "@/ui";

export interface AdminCheckStripePaymentButtonProps {
  invoicePublicId: string;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  origin?: "portal" | "import";
  attemptPublicId?: string;
  onUpdated?: () => void;
}

export function AdminCheckStripePaymentButton({
  invoicePublicId,
  invoiceStatus,
  origin = "portal",
  attemptPublicId,
  onUpdated,
}: AdminCheckStripePaymentButtonProps): JSX.Element | null {
  const session = useSession();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const checkProc = (
    trpc.payments?.admin as
      | {
          checkWithStripeNow?: {
            mutationOptions: () => {
              mutationFn?: (input: AdminCheckWithStripeInput) => Promise<AdminCheckWithStripeResult>;
            };
          };
        }
      | undefined
  )?.checkWithStripeNow;
  const checkMutation = useMutation<AdminCheckWithStripeResult, unknown, AdminCheckWithStripeInput>(
    checkProc
      ? (checkProc.mutationOptions() as Parameters<
          typeof useMutation<AdminCheckWithStripeResult, unknown, AdminCheckWithStripeInput>
        >[0])
      : {
          mutationFn: async () => {
            throw new Error("payments.admin.checkWithStripeNow is unavailable.");
          },
        },
  );

  const role =
    session.me?.user.role ??
    (session.view.status === "full" ? session.view.role : undefined);
  const canManagePayments = Boolean(role && roleHasCapability(role, "payments.manage"));

  if (!canManagePayments) return null;
  if (origin === "import") return null;
  if (invoiceStatus !== "issued") return null;

  async function handleClick() {
    try {
      const result = await stepUp.run(
        () =>
          checkMutation.mutateAsync({
            invoicePublicId,
            ...(attemptPublicId ? { attemptPublicId } : {}),
          }),
        {
          reason:
            "Checking live Stripe payment status and repairing unbooked payments requires a recent identity check.",
        },
      );

      const invalidations: Array<Promise<unknown>> = [];
      if (typeof trpc.payments?.admin?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.payments.admin.pathKey() }));
      }
      if (typeof trpc.compliance?.invoices?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.compliance.invoices.pathKey() }));
      }
      if (typeof trpc.orders?.pathKey === "function") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() }));
      }
      await Promise.all(invalidations);
      onUpdated?.();

      if (result.booked) {
        toast.show({
          tone: "success",
          title: "Stripe payment verified and booked",
          description: `Invoice ${result.invoicePublicId} is now marked paid${result.receiptPublicId ? ` (receipt ${result.receiptPublicId})` : ""}.`,
        });
      } else if (result.alreadyPaid) {
        toast.show({
          tone: "info",
          title: "Invoice is already paid",
          description: "This invoice was already settled and no duplicate payment was recorded.",
        });
      } else if (result.reasonCode === "NO_STRIPE_ATTEMPTS") {
        toast.show({
          tone: "info",
          title: "No Stripe checkout sessions found",
          description: "No Stripe payment attempts are recorded for this invoice.",
        });
      } else if (result.reasonCode === "AWAITING_ASYNC_SETTLEMENT") {
        toast.show({
          tone: "info",
          title: "Stripe payment is awaiting settlement",
          description:
            "The customer completed checkout with an asynchronous payment method that has not settled yet.",
        });
      } else {
        toast.show({
          tone: "info",
          title: "No completed Stripe payment found yet",
          description: `Checked ${result.checkedCount} Stripe session${result.checkedCount === 1 ? "" : "s"} (${result.reasonCode}). Invoice remains unpaid.`,
        });
      }
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Stripe payment check did not complete",
        description: errorMessage(err),
      });
    }
  }

  return (
    <Button
      variant="secondary"
      size={attemptPublicId ? "sm" : "md"}
      leadingIcon={<RefreshCw aria-hidden />}
      loading={checkMutation.isPending}
      onClick={() => {
        void handleClick();
      }}
    >
      Check with Stripe now
    </Button>
  );
}
