/**
 * Administrator "Cart suggestions" management console (/admin/carts/suggestions, capability `carts.upsells.manage`).
 * Owner: recovery_ops_engineer (Increment 05, Package B, Decision D2 / ADR 0043).
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, Plus, Sparkles, XCircle } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  Money,
  PageHeader,
  Select,
  StatCard,
  StatGrid,
  Textarea,
  useToast,
  type Column,
} from "@/ui";

type AdminUpsellsListData = inferRouterOutputs<AppRouter>["cart"]["admin"]["upsells"]["list"];
export type AdminUpsellOfferRow = AdminUpsellsListData["offers"][number];
type CatalogProductOption = AdminUpsellsListData["catalogProducts"][number];

interface OfferFormState {
  kind: "add_on" | "tier_upgrade";
  title: string;
  shortText: string;
  triggerMode: "any_cart" | "products";
  triggerProductPublicIds: string[];
  targetProductPublicId: string;
  priority: string;
  active: boolean;
  startsAtLocal: string;
  endsAtLocal: string;
}

function toDatetimeLocalValue(value: Date | string | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseOptionalDate(localValue: string): Date | null {
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DEFAULT_FORM: OfferFormState = {
  kind: "add_on",
  title: "",
  shortText: "",
  triggerMode: "any_cart",
  triggerProductPublicIds: [],
  targetProductPublicId: "",
  priority: "100",
  active: true,
  startsAtLocal: "",
  endsAtLocal: "",
};

function formFromOffer(offer: AdminUpsellOfferRow): OfferFormState {
  return {
    kind: offer.kind,
    title: offer.title,
    shortText: offer.shortText,
    triggerMode: offer.triggerMode,
    triggerProductPublicIds: [...offer.triggerProductPublicIds],
    targetProductPublicId: offer.targetProductPublicId,
    priority: String(offer.priority),
    active: offer.active,
    startsAtLocal: toDatetimeLocalValue(offer.startsAt),
    endsAtLocal: toDatetimeLocalValue(offer.endsAt),
  };
}

export function AdminCartUpsellsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const formId = useId();

  const listQuery = useQuery(trpc.cart.admin.upsells.list.queryOptions());
  const listKey = trpc.cart.admin.upsells.list.queryKey();

  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "add_on" | "tier_upgrade">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<AdminUpsellOfferRow | null>(null);
  const [form, setForm] = useState<OfferFormState>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUpsellOfferRow | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const createMutation = useMutation(trpc.cart.admin.upsells.create.mutationOptions());
  const updateMutation = useMutation(trpc.cart.admin.upsells.update.mutationOptions());
  const setActiveMutation = useMutation(trpc.cart.admin.upsells.setActive.mutationOptions());
  const deleteMutation = useMutation(trpc.cart.admin.upsells.delete.mutationOptions());

  const saving = createMutation.isPending || updateMutation.isPending;
  const rowBusy = setActiveMutation.isPending || deleteMutation.isPending;

  const data = listQuery.data;
  const offers = useMemo(() => data?.offers ?? [], [data?.offers]);
  const catalogProducts = useMemo(() => data?.catalogProducts ?? [], [data?.catalogProducts]);

  const totals = useMemo(() => {
    let shown = 0;
    let accepted = 0;
    let dismissed = 0;
    for (const o of offers) {
      shown += o.shownCount;
      accepted += o.acceptedCount;
      dismissed += o.dismissedCount;
    }
    return { shown, accepted, dismissed };
  }, [offers]);

  const filteredOffers = useMemo(() => {
    const q = submittedSearch.trim().toLowerCase();
    return offers.filter((offer) => {
      if (kindFilter !== "all" && offer.kind !== kindFilter) return false;
      if (statusFilter === "active" && !offer.active) return false;
      if (statusFilter === "inactive" && offer.active) return false;
      if (!q) return true;
      return (
        offer.title.toLowerCase().includes(q) ||
        offer.shortText.toLowerCase().includes(q) ||
        (offer.targetProductName ?? "").toLowerCase().includes(q)
      );
    });
  }, [offers, submittedSearch, kindFilter, statusFilter]);

  const activeFilterCount =
    (submittedSearch ? 1 : 0) + (kindFilter !== "all" ? 1 : 0) + (statusFilter !== "all" ? 1 : 0);

  const resetFilters = () => {
    setSearchDraft("");
    setSubmittedSearch("");
    setKindFilter("all");
    setStatusFilter("all");
  };

  const targetProductOptions = useMemo(() => {
    return catalogProducts.filter((p) => {
      if (!p.active) return false;
      if (form.kind === "tier_upgrade") return p.canBeTierUpgradeTarget;
      return true;
    });
  }, [catalogProducts, form.kind]);

  const openCreate = () => {
    setEditingOffer(null);
    setForm(DEFAULT_FORM);
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (offer: AdminUpsellOfferRow) => {
    setEditingOffer(offer);
    setForm(formFromOffer(offer));
    setFormError(null);
    setDialogOpen(true);
  };

  const handleKindChange = (nextKind: "add_on" | "tier_upgrade") => {
    setForm((prev) => {
      const currentTarget = catalogProducts.find((p) => p.productPublicId === prev.targetProductPublicId);
      const stillValid =
        currentTarget &&
        currentTarget.active &&
        (nextKind === "add_on" || currentTarget.canBeTierUpgradeTarget);
      return {
        ...prev,
        kind: nextKind,
        targetProductPublicId: stillValid ? prev.targetProductPublicId : "",
      };
    });
  };

  const toggleTriggerProduct = (productPublicId: string, checked: boolean) => {
    setForm((prev) => {
      const set = new Set(prev.triggerProductPublicIds);
      if (checked) set.add(productPublicId);
      else set.delete(productPublicId);
      return { ...prev, triggerProductPublicIds: [...set] };
    });
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const title = form.title.trim();
    const shortText = form.shortText.trim();
    const priorityNum = Number(form.priority);

    if (!title) {
      setFormError("Enter a suggestion title.");
      return;
    }
    if (!shortText || shortText.length > 200) {
      setFormError("Enter plain-text suggestion copy up to 200 characters.");
      return;
    }
    if (!form.targetProductPublicId) {
      setFormError("Select a target product from the active catalogue.");
      return;
    }
    if (form.triggerMode === "products" && form.triggerProductPublicIds.length === 0) {
      setFormError("Select at least one trigger product, or switch trigger mode to Any non-empty cart.");
      return;
    }
    if (!Number.isInteger(priorityNum) || priorityNum < 1 || priorityNum > 1000) {
      setFormError("Priority must be a whole number from 1 to 1000.");
      return;
    }

    const startsAt = parseOptionalDate(form.startsAtLocal);
    const endsAt = parseOptionalDate(form.endsAtLocal);
    if (form.startsAtLocal.trim() && !startsAt) {
      setFormError("Enter a valid start date and time.");
      return;
    }
    if (form.endsAtLocal.trim() && !endsAt) {
      setFormError("Enter a valid end date and time.");
      return;
    }
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      setFormError("End date and time must be after the start date and time.");
      return;
    }

    try {
      if (editingOffer) {
        await updateMutation.mutateAsync({
          offerPublicId: editingOffer.offerPublicId,
          expectedVersion: editingOffer.version,
          kind: form.kind,
          title,
          shortText,
          triggerMode: form.triggerMode,
          triggerProductPublicIds: form.triggerMode === "products" ? form.triggerProductPublicIds : [],
          targetProductPublicId: form.targetProductPublicId,
          priority: priorityNum,
          active: form.active,
          startsAt,
          endsAt,
        });
        toast.show({ tone: "success", title: "Cart suggestion updated" });
      } else {
        await createMutation.mutateAsync({
          kind: form.kind,
          title,
          shortText,
          triggerMode: form.triggerMode,
          triggerProductPublicIds: form.triggerMode === "products" ? form.triggerProductPublicIds : [],
          targetProductPublicId: form.targetProductPublicId,
          priority: priorityNum,
          active: form.active,
          startsAt,
          endsAt,
        });
        toast.show({ tone: "success", title: "Cart suggestion created" });
      }
      await queryClient.invalidateQueries({ queryKey: listKey });
      setDialogOpen(false);
    } catch (err) {
      if (safeError(err)?.reasonCode === "UPSELL_OFFER_VERSION_CONFLICT") {
        await queryClient.invalidateQueries({ queryKey: listKey });
      }
      setFormError(errorMessage(err, "Could not save this cart suggestion."));
    }
  };

  const handleToggleActive = async (offer: AdminUpsellOfferRow) => {
    setPageError(null);
    try {
      await setActiveMutation.mutateAsync({
        offerPublicId: offer.offerPublicId,
        expectedVersion: offer.version,
        active: !offer.active,
      });
      await queryClient.invalidateQueries({ queryKey: listKey });
      toast.show({
        tone: "success",
        title: !offer.active ? "Suggestion activated" : "Suggestion deactivated",
      });
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: listKey });
      setPageError(errorMessage(err, "Could not update suggestion status."));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setPageError(null);
    try {
      await deleteMutation.mutateAsync({ offerPublicId: deleteTarget.offerPublicId });
      await queryClient.invalidateQueries({ queryKey: listKey });
      toast.show({ tone: "success", title: "Suggestion deleted" });
      setDeleteTarget(null);
    } catch (err) {
      setPageError(errorMessage(err, "Could not delete this suggestion."));
    }
  };

  const productById = useMemo(
    () => new Map<string, CatalogProductOption>(catalogProducts.map((p) => [p.productPublicId, p])),
    [catalogProducts],
  );

  const columns: readonly Column<AdminUpsellOfferRow>[] = [
    {
      key: "suggestion",
      header: "Suggestion",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold break-words text-ink">{row.title}</span>
            <Badge tone="info">{row.kind === "tier_upgrade" ? "Tier upgrade" : "Add-on"}</Badge>
            <Badge tone={row.active ? "success" : "neutral"}>{row.active ? "Active" : "Inactive"}</Badge>
          </div>
          <p className="text-sm break-words text-body">{row.shortText}</p>
          {row.startsAt || row.endsAt ? (
            <p className="text-xs break-words text-muted">
              Schedule:{" "}
              {row.startsAt ? <DateTime value={row.startsAt} format="datetime" /> : "Immediate"}
              {" → "}
              {row.endsAt ? <DateTime value={row.endsAt} format="datetime" /> : "No end"}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: "target",
      header: "Target & trigger",
      cell: (row) => {
        const triggerNames =
          row.triggerMode === "any_cart"
            ? "Any non-empty cart"
            : row.triggerProductPublicIds
                .map((id) => productById.get(id)?.name ?? id)
                .join(", ");
        return (
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium break-words text-ink">
                {row.targetProductName ?? row.targetProductPublicId}
              </span>
              {row.targetProductPriceMinor !== null && row.targetProductCurrency ? (
                <span className="text-muted">
                  (<Money value={{ amountMinor: row.targetProductPriceMinor, currency: row.targetProductCurrency }} />)
                </span>
              ) : null}
              {!row.targetProductAvailable ? <Badge tone="warning">Product inactive</Badge> : null}
            </div>
            <span className="text-xs break-words text-muted">Trigger: {triggerNames}</span>
          </div>
        );
      },
    },
    {
      key: "priority",
      header: "Priority",
      align: "end",
      hideOnMobile: true,
      cell: (row) => <span className="font-mono text-sm text-ink">{row.priority}</span>,
    },
    {
      key: "counters",
      header: "Shown / Accepted / Dismissed",
      align: "end",
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap text-body">
          {row.shownCount} / {row.acceptedCount} / {row.dismissedCount}
        </span>
      ),
    },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Cart suggestions"
        description="Configure optional add-ons and higher packet tier upgrades shown on the customer cart page. Eligibility and prices are always evaluated on the server."
        actions={
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={openCreate}>
            New suggestion
          </Button>
        }
      />

      {pageError ? <Callout tone="danger" title="Action could not be completed">{pageError}</Callout> : null}

      {data && !data.featureUpsellEnabled ? (
        <Callout tone="info" title="Cart suggestions are currently turned off">
          Customers will not see cart suggestions until the <code>feature.cart.upsell</code> setting is enabled in
          Platform Settings. You can configure and review offers here before enabling the feature.
        </Callout>
      ) : null}

      {data?.bundleRuleEnabled ? (
        <Callout tone="info" title="Automatic bundle-completion suggestion">
          When a cart is 1 or 2 packets short of {data.bundleRuleLabel ?? "the bundle rule"}, ReadyPackets automatically
          suggests the missing packet(s) at priority 50 alongside configured offers (up to 3 suggestions per cart).
        </Callout>
      ) : null}

      <StatGrid label="Cart suggestion totals">
        <StatCard
          label="Shown"
          value={totals.shown}
          hint="Unique cart impressions across configured offers"
          icon={Eye}
          tone="info"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Accepted"
          value={totals.accepted}
          hint="Suggestions added or upgraded in customer carts"
          icon={CheckCircle2}
          tone="success"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Dismissed"
          value={totals.dismissed}
          hint="Suggestions dismissed by customers"
          icon={XCircle}
          tone="neutral"
          loading={listQuery.isPending}
        />
      </StatGrid>

      <FilterBar
        search={searchDraft}
        onSearchChange={setSearchDraft}
        onSearchSubmit={(val) => setSubmittedSearch(val.trim())}
        searchLabel="Search cart suggestions"
        searchPlaceholder="Search by title, copy, or target product"
        activeCount={activeFilterCount}
        onReset={activeFilterCount > 0 ? resetFilters : undefined}
      >
        <Field label="Kind" className="w-full sm:w-44">
          <Select
            value={kindFilter}
            options={[
              { value: "all", label: "All kinds" },
              { value: "add_on", label: "Add-on" },
              { value: "tier_upgrade", label: "Tier upgrade" },
            ]}
            onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
          />
        </Field>
        <Field label="Status" className="w-full sm:w-44">
          <Select
            value={statusFilter}
            options={[
              { value: "all", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          />
        </Field>
      </FilterBar>

      {listQuery.isError ? (
        <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : (
        <DataTable
          caption="Configured cart suggestion offers"
          columns={columns}
          rows={data ? filteredOffers : undefined}
          rowKey={(row) => row.offerPublicId}
          loading={listQuery.isPending}
          rowActions={(row) => (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={rowBusy}
                aria-label={`Edit: ${row.title}`}
                onClick={() => openEdit(row)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={rowBusy}
                aria-label={`${row.active ? "Deactivate" : "Activate"}: ${row.title}`}
                onClick={() => void handleToggleActive(row)}
              >
                {row.active ? "Deactivate" : "Activate"}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={rowBusy}
                aria-label={`Delete: ${row.title}`}
                onClick={() => setDeleteTarget(row)}
              >
                Delete
              </Button>
            </div>
          )}
          empty={
            <EmptyState
              icon={Sparkles}
              variant={activeFilterCount > 0 ? "filtered" : "default"}
              onClearFilters={activeFilterCount > 0 ? resetFilters : undefined}
              title={activeFilterCount > 0 ? "No matching cart suggestions" : "No cart suggestions configured"}
              description={
                activeFilterCount > 0
                  ? "No offer matched your current filters. Clear filters to view all configured offers."
                  : "Create an add-on or packet tier upgrade offer to suggest relevant options in customer carts."
              }
              action={
                activeFilterCount === 0 ? (
                  <Button onClick={openCreate}>New suggestion</Button>
                ) : undefined
              }
            />
          }
        />
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saving) setDialogOpen(open);
        }}
        title={editingOffer ? "Edit cart suggestion" : "New cart suggestion"}
        description="Plain-text copy only. Prices and eligibility are computed live from the active catalogue."
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={saving}>
              {editingOffer ? "Save changes" : "Create suggestion"}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(e) => void submitForm(e)} className="min-w-0 space-y-4">
          {formError ? <Callout tone="danger" title="Check suggestion details">{formError}</Callout> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Suggestion kind" required>
              <Select
                value={form.kind}
                options={[
                  { value: "add_on", label: "Add-on product" },
                  { value: "tier_upgrade", label: "Packet tier upgrade" },
                ]}
                onChange={(e) => handleKindChange(e.target.value as "add_on" | "tier_upgrade")}
                disabled={saving}
              />
            </Field>

            <Field label="Priority" hint="1–1000 (lower numbers show first; bundle completion is 50)" required>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                step={1}
                value={form.priority}
                onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
                disabled={saving}
                required
              />
            </Field>
          </div>

          <Field label="Title" required>
            <Input
              value={form.title}
              maxLength={120}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              disabled={saving}
              required
            />
          </Field>

          <Field
            label="Short description"
            hint={`Plain text only (${form.shortText.length}/200 characters). No countdowns or urgency claims.`}
            required
          >
            <Textarea
              value={form.shortText}
              maxLength={200}
              rows={3}
              onChange={(e) => setForm((prev) => ({ ...prev, shortText: e.target.value }))}
              disabled={saving}
              required
            />
          </Field>

          <Field
            label="Target product"
            hint={
              form.kind === "tier_upgrade"
                ? "Only higher-priced packet tiers can be selected as tier upgrade targets."
                : "Active catalogue product added when the customer accepts."
            }
            required
          >
            <Select
              value={form.targetProductPublicId}
              placeholder="Choose a target product…"
              options={targetProductOptions.map((p) => ({
                value: p.productPublicId,
                label: `${p.groupName}: ${p.name}`,
              }))}
              onChange={(e) => setForm((prev) => ({ ...prev, targetProductPublicId: e.target.value }))}
              disabled={saving}
            />
          </Field>

          <Field label="Trigger condition" required>
            <Select
              value={form.triggerMode}
              options={[
                { value: "any_cart", label: "Any non-empty cart" },
                { value: "products", label: "When specific products are in the cart" },
              ]}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  triggerMode: e.target.value as "any_cart" | "products",
                }))
              }
              disabled={saving}
            />
          </Field>

          {form.triggerMode === "products" ? (
            <fieldset className="min-w-0 space-y-2 rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-medium text-ink">Trigger products</legend>
              <div className="grid max-h-48 gap-2 overflow-y-auto pr-1">
                {catalogProducts
                  .filter((p) => p.active)
                  .map((p) => (
                    <Checkbox
                      key={p.productPublicId}
                      label={`${p.groupName}: ${p.name}`}
                      checked={form.triggerProductPublicIds.includes(p.productPublicId)}
                      onCheckedChange={(checked) => toggleTriggerProduct(p.productPublicId, checked)}
                      disabled={saving}
                    />
                  ))}
              </div>
            </fieldset>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts at (optional)">
              <Input
                type="datetime-local"
                value={form.startsAtLocal}
                onChange={(e) => setForm((prev) => ({ ...prev, startsAtLocal: e.target.value }))}
                disabled={saving}
              />
            </Field>
            <Field label="Ends at (optional)">
              <Input
                type="datetime-local"
                value={form.endsAtLocal}
                onChange={(e) => setForm((prev) => ({ ...prev, endsAtLocal: e.target.value }))}
                disabled={saving}
              />
            </Field>
          </div>

          <Checkbox
            label="Offer is active"
            checked={form.active}
            onCheckedChange={(checked) => setForm((prev) => ({ ...prev, active: checked }))}
            disabled={saving}
          />
        </form>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete cart suggestion?"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.title}" permanently? Impression and acceptance counters for this offer will be removed.`
            : undefined
        }
        confirmLabel="Delete suggestion"
        destructive
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

export default AdminCartUpsellsPage;
