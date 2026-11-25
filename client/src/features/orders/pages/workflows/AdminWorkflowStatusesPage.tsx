/**
 * Console status catalogue (/admin/workflows/statuses). Owner: recovery_ops_engineer (Increment 07, D2).
 *
 * Manages the shared order status catalogue (key, staff label, customer label, badge tone, category, default attention,
 * display order, and retirement). Keys are immutable once created. Renaming updates format-3 workflows immediately while
 * published format-1 and format-2 workflow versions keep their snapshot labels.
 */
import {
  ORDER_STATUS_ATTENTIONS,
  ORDER_STATUS_CATEGORIES,
  ORDER_STATUS_TONES,
  statusCatalogKeySchema,
  statusCatalogLabelSchema,
  validateStatusCancelCategoryRule,
  type OrderStatusAttention,
  type OrderStatusCategory,
  type OrderStatusTone,
  type StatusCatalogItem,
} from "@shared/orderStatusCatalog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListChecks } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
} from "@/ui";
import { OrderStatusBadge } from "../../shared";

const CATEGORY_LABELS: Record<OrderStatusCategory, string> = {
  start: "Start (orders begin here)",
  working: "Working (in progress)",
  waiting: "Waiting (blocked on action)",
  done: "Done (completed)",
  canceled: "Canceled (terminated)",
};

const CATEGORY_SHORT_LABELS: Record<OrderStatusCategory, string> = {
  start: "Start",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  canceled: "Canceled",
};

const TONE_LABELS: Record<OrderStatusTone, string> = {
  neutral: "Neutral (grey)",
  info: "Information (blue)",
  success: "Success (green)",
  warning: "Needs attention (amber)",
  danger: "Critical or canceled (red)",
};

const ATTENTION_LABELS: Record<OrderStatusAttention, string> = {
  none: "None",
  staff_review: "Awaiting staff review",
  customer_response: "Awaiting customer response",
};

const CATEGORY_OPTIONS = ORDER_STATUS_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
const TONE_OPTIONS = ORDER_STATUS_TONES.map((value) => ({ value, label: TONE_LABELS[value] }));
const ATTENTION_OPTIONS = ORDER_STATUS_ATTENTIONS.map((value) => ({ value, label: ATTENTION_LABELS[value] }));

function suggestKeyFromLabel(label: string): string {
  const normalized = label
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  const prefixed = /^[a-z]/.test(normalized) ? normalized : `s_${normalized}`;
  return prefixed.slice(0, 48).replace(/_+$/g, "");
}

function AttentionCell({ attention }: { attention: OrderStatusAttention }) {
  if (attention === "staff_review") {
    return <Badge tone="info">Awaiting staff review</Badge>;
  }
  if (attention === "customer_response") {
    return <Badge tone="warning">Awaiting customer response</Badge>;
  }
  return <span className="text-sm text-muted">None</span>;
}

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; item: StatusCatalogItem };

export default function AdminWorkflowStatusesPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();

  const [showRetired, setShowRetired] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [retiring, setRetiring] = useState<StatusCatalogItem | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const catalog = useQuery(
    trpc.orders.statusCatalog.list.queryOptions({
      includeRetired: true,
      includeUsage: true,
    }),
  );

  const createStatus = useMutation(trpc.orders.statusCatalog.create.mutationOptions());
  const updateStatus = useMutation(trpc.orders.statusCatalog.update.mutationOptions());
  const reorderStatuses = useMutation(trpc.orders.statusCatalog.reorder.mutationOptions());
  const retireStatus = useMutation(trpc.orders.statusCatalog.retire.mutationOptions());
  const restoreStatus = useMutation(trpc.orders.statusCatalog.restore.mutationOptions());

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.orders.statusCatalog.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.orders.statusCatalog.attentionCounts.queryKey() }),
    ]);

  const allItems = catalog.data ?? [];
  const activeItems = allItems.filter((item) => !item.retired);
  const visibleItems = showRetired ? allItems : activeItems;
  const retiredCount = allItems.length - activeItems.length;

  const moveActive = async (key: string, direction: -1 | 1) => {
    const index = activeItems.findIndex((item) => item.key === key);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= activeItems.length) return;
    const orderedKeys = activeItems.map((item) => item.key);
    const [moved] = orderedKeys.splice(index, 1);
    orderedKeys.splice(targetIndex, 0, moved!);
    setProblem(null);
    try {
      await stepUp.run(
        () => reorderStatuses.mutateAsync({ orderedKeys }),
        { reason: "Reordering the order status catalogue." },
      );
      await refresh();
      toast.show({ tone: "success", title: "Status order updated" });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setProblem(errorMessage(err));
    }
  };

  const handleRestore = async (item: StatusCatalogItem) => {
    setProblem(null);
    try {
      await stepUp.run(
        () => restoreStatus.mutateAsync({ key: item.key, expectedVersion: item.version }),
        { reason: `Restoring order status "${item.staffLabel}".` },
      );
      await refresh();
      toast.show({ tone: "success", title: `Restored "${item.staffLabel}"` });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setProblem(errorMessage(err));
    }
  };

  const header = (
    <>
      <Breadcrumbs items={[{ label: "Workflows", href: "/admin/workflows" }, { label: "Order statuses" }]} />
      <PageHeader
        title="Order statuses"
        description="Manage the shared status catalogue for workflows, automations and console attention filters. Renaming updates format-3 workflows immediately while older published versions keep their snapshot labels."
        actions={catalog.data ? <Button onClick={() => setEditor({ mode: "create" })}>Add status</Button> : null}
      />
    </>
  );

  if (catalog.isPending) {
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  }

  if (catalog.error) {
    return (
      <>
        {header}
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {problem ? <Callout tone="danger" title="Could not update status catalogue">{problem}</Callout> : null}

        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">
              {showRetired
                ? `Showing ${visibleItems.length} statuses (${activeItems.length} active, ${retiredCount} retired).`
                : `Showing ${activeItems.length} active status${activeItems.length === 1 ? "" : "es"}${retiredCount > 0 ? ` (${retiredCount} retired hidden)` : ""}.`}
            </p>
            <Switch
              label="Show retired statuses"
              checked={showRetired}
              onCheckedChange={setShowRetired}
            />
          </div>
        </Card>

        <DataTable
          caption="Order status catalogue"
          rows={visibleItems}
          rowKey={(item) => item.key}
          empty={
            <EmptyState
              icon={ListChecks}
              title="No statuses to show"
              description="Add a status or enable retired statuses to view hidden entries."
            />
          }
          columns={[
            {
              key: "status",
              header: "Status",
              primary: true,
              cell: (item) => (
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <OrderStatusBadge label={item.staffLabel} tone={item.tone} />
                    {item.retired ? <Badge tone="neutral">Retired</Badge> : null}
                  </div>
                  <code className="text-xs break-all text-muted">{item.key}</code>
                </div>
              ),
            },
            {
              key: "customerLabel",
              header: "Customer label",
              cell: (item) => <span className="break-words">{item.customerLabel}</span>,
            },
            {
              key: "category",
              header: "Category",
              hideOnMobile: true,
              cell: (item) => <span>{CATEGORY_SHORT_LABELS[item.category]}</span>,
            },
            {
              key: "attention",
              header: "Attention",
              cell: (item) => <AttentionCell attention={item.attention} />,
            },
            {
              key: "usage",
              header: "Usage",
              hideOnMobile: true,
              cell: (item) => {
                const activeOrderCount = item.usage?.activeOrderCount ?? 0;
                const publishedVersionCount = item.usage?.publishedVersionCount ?? 0;
                const draftCount = item.usage?.draftCount ?? 0;
                return (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>{`${activeOrderCount} active order${activeOrderCount === 1 ? "" : "s"}`}</span>
                    <span aria-hidden="true">·</span>
                    <span>{`${publishedVersionCount} workflow${publishedVersionCount === 1 ? "" : "s"}`}</span>
                    {draftCount > 0 ? (
                      <Badge tone="warning">{`In ${draftCount} draft${draftCount === 1 ? "" : "s"}`}</Badge>
                    ) : null}
                  </div>
                );
              },
            },
          ]}
          rowActions={(item) => {
            const activeIndex = activeItems.findIndex((candidate) => candidate.key === item.key);
            const draftCount = item.usage?.draftCount ?? 0;
            return (
              <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
                {!item.retired ? (
                  <>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Move ${item.staffLabel} up`}
                      icon={<ArrowUp />}
                      disabled={activeIndex <= 0 || reorderStatuses.isPending}
                      onClick={() => void moveActive(item.key, -1)}
                    />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Move ${item.staffLabel} down`}
                      icon={<ArrowDown />}
                      disabled={activeIndex < 0 || activeIndex >= activeItems.length - 1 || reorderStatuses.isPending}
                      onClick={() => void moveActive(item.key, 1)}
                    />
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Edit ${item.staffLabel}`}
                  onClick={() => setEditor({ mode: "edit", item })}
                >
                  Edit
                </Button>
                {item.retired ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Restore ${item.staffLabel}`}
                    disabled={restoreStatus.isPending}
                    onClick={() => void handleRestore(item)}
                  >
                    Restore
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Retire ${item.staffLabel}`}
                    disabled={draftCount > 0}
                    title={draftCount > 0 ? "Remove this status from open workflow drafts before retiring it." : undefined}
                    onClick={() => setRetiring(item)}
                  >
                    Retire
                  </Button>
                )}
              </div>
            );
          }}
        />
      </div>

      {editor ? (
        <StatusEditorDialog
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={async (title) => {
            setEditor(null);
            await refresh();
            toast.show({ tone: "success", title });
          }}
          createMutation={createStatus}
          updateMutation={updateStatus}
        />
      ) : null}

      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => !open && setRetiring(null)}
        title={retiring ? `Retire "${retiring.staffLabel}"?` : "Retire status?"}
        description={
          retiring
            ? `Existing orders in "${retiring.staffLabel}" keep and display this status, and published workflows continue working. Retired statuses are hidden from new workflow picks until restored.`
            : undefined
        }
        confirmLabel="Retire status"
        destructive
        onConfirm={async () => {
          if (!retiring) return;
          setProblem(null);
          try {
            await stepUp.run(
              () => retireStatus.mutateAsync({ key: retiring.key, expectedVersion: retiring.version }),
              { reason: `Retiring order status "${retiring.staffLabel}".` },
            );
            await refresh();
            toast.show({ tone: "success", title: `Retired "${retiring.staffLabel}"` });
          } catch (err) {
            if (err instanceof StepUpCancelledError) throw err;
            setProblem(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}

interface StatusEditorDialogProps {
  state: EditorState;
  onClose: () => void;
  onSaved: (toastTitle: string) => Promise<void>;
  createMutation: {
    isPending: boolean;
    mutateAsync: (input: {
      key: string;
      staffLabel: string;
      customerLabel: string;
      tone: OrderStatusTone;
      category: OrderStatusCategory;
      attention: OrderStatusAttention;
    }) => Promise<StatusCatalogItem>;
  };
  updateMutation: {
    isPending: boolean;
    mutateAsync: (input: {
      key: string;
      expectedVersion: number;
      staffLabel: string;
      customerLabel: string;
      tone: OrderStatusTone;
      category: OrderStatusCategory;
      attention: OrderStatusAttention;
    }) => Promise<StatusCatalogItem>;
  };
}

function StatusEditorDialog({ state, onClose, onSaved, createMutation, updateMutation }: StatusEditorDialogProps) {
  const stepUp = useStepUp();
  const initial = state.mode === "edit" ? state.item : null;

  const [staffLabel, setStaffLabel] = useState(initial?.staffLabel ?? "");
  const [customerLabel, setCustomerLabel] = useState(initial?.customerLabel ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [keyEdited, setKeyEdited] = useState(Boolean(initial));
  const [customerEdited, setCustomerEdited] = useState(Boolean(initial));
  const [tone, setTone] = useState<OrderStatusTone>(initial?.tone ?? "info");
  const [category, setCategory] = useState<OrderStatusCategory>(initial?.category ?? "working");
  const [attention, setAttention] = useState<OrderStatusAttention>(initial?.attention ?? "none");
  const [formError, setFormError] = useState<string | null>(null);

  const busy = createMutation.isPending || updateMutation.isPending;

  const cancelRuleMessage = key ? validateStatusCancelCategoryRule(key, category) : null;

  const handleStaffLabelChange = (next: string) => {
    setStaffLabel(next);
    if (!customerEdited && state.mode === "create") {
      setCustomerLabel(next);
    }
    if (!keyEdited && state.mode === "create") {
      const suggested = suggestKeyFromLabel(next);
      setKey(suggested);
      if (suggested.includes("cancel") && category !== "canceled") {
        setCategory("canceled");
        setTone("danger");
      }
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const parsedKey = statusCatalogKeySchema.safeParse(key.trim());
    if (!parsedKey.success) {
      setFormError(parsedKey.error.issues[0]?.message ?? "Enter a valid status key.");
      return;
    }
    const parsedStaff = statusCatalogLabelSchema.safeParse(staffLabel);
    if (!parsedStaff.success) {
      setFormError(`Staff label: ${parsedStaff.error.issues[0]?.message ?? "Enter plain text up to 60 characters."}`);
      return;
    }
    const parsedCustomer = statusCatalogLabelSchema.safeParse(customerLabel);
    if (!parsedCustomer.success) {
      setFormError(`Customer label: ${parsedCustomer.error.issues[0]?.message ?? "Enter plain text up to 60 characters."}`);
      return;
    }
    const ruleViolation = validateStatusCancelCategoryRule(parsedKey.data, category);
    if (ruleViolation) {
      setFormError(ruleViolation);
      return;
    }

    try {
      if (state.mode === "create") {
        await stepUp.run(
          () =>
            createMutation.mutateAsync({
              key: parsedKey.data,
              staffLabel: parsedStaff.data,
              customerLabel: parsedCustomer.data,
              tone,
              category,
              attention,
            }),
          { reason: `Creating order status "${parsedStaff.data}".` },
        );
        await onSaved(`Added status "${parsedStaff.data}"`);
      } else {
        await stepUp.run(
          () =>
            updateMutation.mutateAsync({
              key: state.item.key,
              expectedVersion: state.item.version,
              staffLabel: parsedStaff.data,
              customerLabel: parsedCustomer.data,
              tone,
              category,
              attention,
            }),
          { reason: `Updating order status "${parsedStaff.data}".` },
        );
        await onSaved(`Saved status "${parsedStaff.data}"`);
      }
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) {
        setFormError(errorMessage(err));
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      dismissible={!busy}
      title={state.mode === "create" ? "Add order status" : `Edit "${state.item.staffLabel}"`}
      description={
        state.mode === "create"
          ? "Status keys are permanent once created. Labels are plain text up to 60 characters."
          : "Status keys cannot be changed. Label, tone, category and attention updates apply immediately to format-3 workflows."
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="status-catalog-editor-form" loading={busy}>
            {state.mode === "create" ? "Add status" : "Save changes"}
          </Button>
        </>
      }
    >
      <form id="status-catalog-editor-form" className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {formError ? <Callout tone="danger" title="Check this status">{formError}</Callout> : null}

        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface-soft px-3 py-2">
          <span className="text-xs font-medium text-muted">Badge preview</span>
          <OrderStatusBadge label={staffLabel.trim() || "Status preview"} tone={tone} />
        </div>

        <Field label="Staff label" required hint="Shown in the staff console (up to 60 plain-text characters).">
          <Input
            value={staffLabel}
            onChange={(e) => handleStaffLabelChange(e.target.value)}
            maxLength={60}
            autoComplete="off"
          />
        </Field>

        <Field label="Customer label" required hint="Shown to customers in the portal and notifications (up to 60 plain-text characters).">
          <Input
            value={customerLabel}
            onChange={(e) => {
              setCustomerEdited(true);
              setCustomerLabel(e.target.value);
            }}
            maxLength={60}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Status key"
          required={state.mode === "create"}
          hint={
            state.mode === "create"
              ? "Lowercase snake_case (2 to 48 characters). Keys containing 'cancel' must use the Canceled category."
              : "Immutable identifier referenced by workflows, orders and automations."
          }
          error={cancelRuleMessage ?? undefined}
        >
          <Input
            value={key}
            readOnly={state.mode === "edit"}
            disabled={state.mode === "edit"}
            onChange={(e) => {
              setKeyEdited(true);
              setKey(e.target.value);
            }}
            maxLength={48}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Category"
          hint="Canceled is reserved exclusively for keys containing 'cancel'."
        >
          <Select
            options={CATEGORY_OPTIONS}
            value={category}
            onChange={(e) => setCategory(e.target.value as OrderStatusCategory)}
          />
        </Field>

        <Field label="Badge tone">
          <Select
            options={TONE_OPTIONS}
            value={tone}
            onChange={(e) => setTone(e.target.value as OrderStatusTone)}
          />
        </Field>

        <Field
          label="Default attention"
          hint="Drives the attention filter chips on the console order list and overview pipeline."
        >
          <Select
            options={ATTENTION_OPTIONS}
            value={attention}
            onChange={(e) => setAttention(e.target.value as OrderStatusAttention)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
