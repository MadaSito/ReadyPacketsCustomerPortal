/**
 * Console catalog management (/admin/catalog). Owner: orders_engineer. Ships empty; no built-in products.
 * Increment 02: packet groups (packet number), product tiers, outcome, timeline, deliverables and the bundle rule.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, Money, PageHeader, Select, Skeleton, Textarea, useToast } from "@/ui";
import { money } from "../shared";

type Tier = "Basic" | "Standard" | "Premium";
type Deliverable = { title: string; detail: string };
type Product = {
  publicId: string;
  productKey: string;
  groupPublicId: string;
  packetNumber: number | null;
  tier: Tier | null;
  name: string;
  description: string;
  features: string[];
  outcome: string;
  timeline: string;
  deliverables: Deliverable[];
  priceMinor: number;
  currency: string;
  versionNumber: number;
  sortOrder: number;
  active: boolean;
  rowVersion: number;
};
type Group = { publicId: string; groupKey: string | null; packetNumber: number | null; name: string; description: string; sortOrder: number; active: boolean; rowVersion: number; products: Product[] };

const CURRENCY = /^[A-Z]{3}$/;
const KEY = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TIERS: Tier[] = ["Basic", "Standard", "Premium"];

/** "Title | detail" per line ⇄ deliverables. A line without "|" is a title with no detail. */
export function parseDeliverables(text: string): Deliverable[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("|");
      return at === -1 ? { title: line, detail: "" } : { title: line.slice(0, at).trim(), detail: line.slice(at + 1).trim() };
    });
}
const formatDeliverables = (items: Deliverable[]) => items.map((d) => (d.detail ? `${d.title} | ${d.detail}` : d.title)).join("\n");

/** "1, 2, 3" → [1, 2, 3]; null when any entry is not a whole number from 1 to 255. */
export function parsePacketNumbers(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 255)) return null;
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Parses a decimal amount ("12.50") into integer minor units for 2-decimal currencies. Returns null if invalid. */
export function parseAmountToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export default function AdminCatalogPage() {
  const trpc = useTRPC();
  const catalog = useQuery(trpc.orders.admin.catalog.list.queryOptions());
  const [groupDialog, setGroupDialog] = useState<Group | "new" | null>(null);
  const [productDialog, setProductDialog] = useState<{ product: Product | null; groupId: string } | null>(null);
  const header = (
    <PageHeader
      title="Catalog"
      description="Products customers can order. Changing a name or price creates a new version; existing orders keep the terms they were placed with."
      actions={
        <Button leadingIcon={<Plus aria-hidden />} onClick={() => setGroupDialog("new")}>
          New group
        </Button>
      }
    />
  );
  if (catalog.isPending)
    return (
      <>
        {header}
        <Skeleton lines={6} />
      </>
    );
  if (catalog.error)
    return (
      <>
        {header}
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </>
    );
  const groups = catalog.data as Group[];
  return (
    <>
      {header}
      <BundleRuleCard />
      {groups.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="The catalog is empty"
          description="Customers cannot place orders until you add a group and at least one active product."
          action={<Button onClick={() => setGroupDialog("new")}>Create the first group</Button>}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <Card
              key={group.publicId}
              title={group.name}
              description={group.description || undefined}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {group.packetNumber !== null ? <Badge tone="info">Packet {group.packetNumber}</Badge> : null}
                  {group.active ? null : <Badge>Hidden</Badge>}
                  <Button size="sm" variant="secondary" onClick={() => setGroupDialog(group)}>
                    Edit group{" "}<span className="sr-only">{group.name}</span>
                  </Button>
                  <Button size="sm" onClick={() => setProductDialog({ product: null, groupId: group.publicId })}>
                    Add product{" "}<span className="sr-only">to {group.name}</span>
                  </Button>
                </div>
              }
            >
              <DataTable
                caption={`Products in ${group.name}`}
                rows={group.products}
                rowKey={(product) => product.publicId}
                columns={[
                  {
                    key: "name",
                    header: "Product",
                    primary: true,
                    cell: (product) => (
                      <span className="flex min-w-0 flex-col">
                        <span className="font-semibold break-words text-ink">{product.name}</span>
                        <span className="text-sm break-all text-muted">{product.productKey}</span>
                        {product.timeline ? <span className="text-sm text-body">Timeline: {product.timeline}</span> : null}
                      </span>
                    ),
                  },
                  { key: "tier", header: "Tier", cell: (product) => product.tier ?? <span className="text-muted">—</span> },
                  { key: "deliverables", header: "Deliverables", align: "end", hideOnMobile: true, cell: (product) => product.deliverables.length },
                  { key: "price", header: "Price", align: "end", cell: (product) => <Money value={money(product.priceMinor, product.currency)} /> },
                  { key: "version", header: "Version", hideOnMobile: true, cell: (product) => `v${product.versionNumber}` },
                  { key: "active", header: "Availability", cell: (product) => <Badge tone={product.active ? "success" : "neutral"}>{product.active ? "Available" : "Hidden"}</Badge> },
                ]}
                rowActions={(product) => (
                  <Button size="sm" variant="ghost" onClick={() => setProductDialog({ product, groupId: group.publicId })}>
                    Edit{" "}<span className="sr-only">{product.name}</span>
                  </Button>
                )}
                empty={<p className="text-body">No products in this group yet.</p>}
              />
            </Card>
          ))}
        </div>
      )}
      {groupDialog ? <GroupDialog group={groupDialog === "new" ? null : groupDialog} onClose={() => setGroupDialog(null)} /> : null}
      {productDialog ? <ProductDialog groups={groups} product={productDialog.product} groupId={productDialog.groupId} onClose={() => setProductDialog(null)} /> : null}
    </>
  );
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useMutation(trpc.orders.admin.catalog.createGroup.mutationOptions());
  const update = useMutation(trpc.orders.admin.catalog.updateGroup.mutationOptions());
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [sortOrder, setSortOrder] = useState(String(group?.sortOrder ?? 0));
  const [active, setActive] = useState(group?.active ?? true);
  const [packetNumber, setPacketNumber] = useState(group && group.packetNumber !== null ? String(group.packetNumber) : "");
  const [groupKey, setGroupKey] = useState(group?.groupKey ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const order = Number(sortOrder);
    const packet = packetNumber.trim() === "" ? null : Number(packetNumber);
    if (!name.trim()) return setError("Enter a group name.");
    if (packet !== null && (!Number.isInteger(packet) || packet < 1 || packet > 255)) return setError("Packet number must be a whole number from 1 to 255, or empty.");
    if (groupKey.trim() && !KEY.test(groupKey.trim())) return setError("The group key must be 2–64 lowercase letters, digits or hyphens.");
    if (!Number.isInteger(order) || order < 0 || order > 10000) return setError("Display order must be a whole number from 0 to 10000.");
    setError(null);
    try {
      const values = { name: name.trim(), description: description.trim(), sortOrder: order, active, packetNumber: packet, groupKey: groupKey.trim() || null };
      if (group) await update.mutateAsync({ groupId: group.publicId, expectedVersion: group.rowVersion, ...values });
      else await create.mutateAsync(values);
      toast.show({ tone: "success", title: group ? "Group updated" : "Group created" });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={group ? "Edit group" : "New group"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending || update.isPending}>
            Cancel
          </Button>
        <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>
          Save group
        </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        </Field>
        <Field label="Description" hint="Optional. Shown to customers.">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} />
        </Field>
        <Field label="Display order">
          <Input type="number" inputMode="numeric" min={0} max={10000} value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Packet number" hint="Only for packet groups. Leave empty for other groups.">
            <Input type="number" inputMode="numeric" min={1} max={255} value={packetNumber} onChange={(event) => setPacketNumber(event.target.value)} />
          </Field>
          <Field label="Group key" hint="Optional import key, e.g. packet-1.">
            <Input value={groupKey} onChange={(event) => setGroupKey(event.target.value)} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <Checkbox label="Visible to customers" checked={active} onCheckedChange={setActive} />
      </form>
    </Dialog>
  );
}

function ProductDialog({ groups, product, groupId, onClose }: { groups: Group[]; product: Product | null; groupId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useMutation(trpc.orders.admin.catalog.createProduct.mutationOptions());
  const update = useMutation(trpc.orders.admin.catalog.updateProduct.mutationOptions());
  const [values, setValues] = useState({
    groupId: product?.groupPublicId ?? groupId,
    productKey: product?.productKey ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    features: (product?.features ?? []).join("\n"),
    price: product ? (product.priceMinor / 100).toFixed(2) : "",
    currency: product?.currency ?? "USD",
    sortOrder: String(product?.sortOrder ?? 0),
    active: product?.active ?? true,
    tier: (product?.tier ?? "") as Tier | "",
    outcome: product?.outcome ?? "",
    timeline: product?.timeline ?? "",
    deliverables: formatDeliverables(product?.deliverables ?? []),
  });
  const selectedGroup = groups.find((g) => g.publicId === values.groupId);
  const packetGroup = selectedGroup?.packetNumber ?? null;
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const priceMinor = parseAmountToMinor(values.price);
    const sortOrder = Number(values.sortOrder);
    const features = values.features.split("\n").map((f) => f.trim()).filter(Boolean);
    if (!values.name.trim()) return setError("Enter a product name.");
    if (!product && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(values.productKey)) return setError("The product key must be 2–64 lowercase letters, digits or hyphens.");
    if (priceMinor === null) return setError("Enter a price such as 125 or 125.50.");
    if (!CURRENCY.test(values.currency)) return setError("Enter a three-letter currency code such as USD.");
    if (features.length > 50 || features.some((f) => f.length > 200)) return setError("Use at most 50 features of up to 200 characters each.");
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return setError("Display order must be a whole number from 0 to 10000.");
    const deliverables = parseDeliverables(values.deliverables);
    if (deliverables.length > 100 || deliverables.some((d) => !d.title || d.title.length > 200 || d.detail.length > 2000))
      return setError("Use at most 100 deliverables, each with a title of up to 200 characters and a detail of up to 2000.");
    if (values.timeline.trim().length > 120) return setError("Keep the timeline to 120 characters.");
    const tier = packetGroup !== null && values.tier ? values.tier : null;
    if (packetGroup !== null && !tier) return setError("Choose a tier for a product in a packet group.");
    setError(null);
    const terms = {
      name: values.name.trim(),
      description: values.description.trim(),
      features,
      priceMinor,
      currency: values.currency,
      groupId: values.groupId,
      sortOrder,
      active: values.active,
      outcome: values.outcome.trim(),
      timeline: values.timeline.trim(),
      deliverables,
      packetNumber: tier ? packetGroup : null,
      tier,
    };
    try {
      if (product) await update.mutateAsync({ productId: product.publicId, expectedVersion: product.rowVersion, ...terms });
      else await create.mutateAsync({ productKey: values.productKey, ...terms });
      toast.show({ tone: "success", title: product ? "Product updated" : "Product created" });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={product ? "Edit product" : "New product"}
      description={
        product ? "Changing the name, description, features, outcome, timeline, deliverables or price publishes a new version. Existing orders are not affected." : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending || update.isPending}>
            Cancel
          </Button>
        <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>
          Save product
        </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Group">
          <Select options={groups.map((g) => ({ value: g.publicId, label: g.name }))} value={values.groupId} onChange={set("groupId")} />
        </Field>
        {product ? null : (
          <Field label="Product key" hint="Permanent identifier, e.g. starter-review. Lowercase letters, digits and hyphens." required>
            <Input value={values.productKey} onChange={set("productKey")} maxLength={64} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <Field label="Name" required>
          <Input value={values.name} onChange={set("name")} maxLength={160} />
        </Field>
        <Field label="Description">
          <Textarea value={values.description} onChange={set("description")} maxLength={2000} rows={3} />
        </Field>
        {packetGroup !== null ? (
          <Field label="Tier" required hint={`This group is Packet ${packetGroup}. Each tier can be offered once per packet.`}>
            <Select
              options={[{ value: "", label: "Choose a tier" }, ...TIERS.map((t) => ({ value: t, label: t }))]}
              value={values.tier}
              onChange={set("tier")}
            />
          </Field>
        ) : null}
        <Field label="Outcome" hint="Optional. What the customer gets, shown with the tier.">
          <Textarea value={values.outcome} onChange={set("outcome")} maxLength={1000} rows={2} />
        </Field>
        <Field label="Timeline" hint="Optional, e.g. 4 - 6 business days.">
          <Input value={values.timeline} onChange={set("timeline")} maxLength={120} />
        </Field>
        <Field label="Deliverables" hint="One per line as: Title | detail. When set, the features list is the deliverable titles.">
          <Textarea value={values.deliverables} onChange={set("deliverables")} rows={5} />
        </Field>
        {values.deliverables.trim() ? null : (
          <Field label="Features" hint="One per line.">
            <Textarea value={values.features} onChange={set("features")} rows={4} />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price" required hint="In major units, e.g. 125.50.">
            <Input value={values.price} onChange={set("price")} inputMode="decimal" maxLength={13} />
          </Field>
          <Field label="Currency" required>
            <Input value={values.currency} onChange={(event) => setValues((c) => ({ ...c, currency: event.target.value.toUpperCase() }))} maxLength={3} autoComplete="off" />
          </Field>
        </div>
        <Field label="Display order">
          <Input type="number" inputMode="numeric" min={0} max={10000} value={values.sortOrder} onChange={set("sortOrder")} />
        </Field>
        <Checkbox label="Available to order" checked={values.active} onCheckedChange={(checked) => setValues((c) => ({ ...c, active: checked }))} />
      </form>
    </Dialog>
  );
}

type BundleRule = { enabled: boolean; requiredPacketNumbers: number[]; discountPercent: number; label: string };

/** The bundle discount rule (`orders.bundle_rule`): read-only summary plus an audited edit dialog. */
function BundleRuleCard() {
  const trpc = useTRPC();
  const rule = useQuery(trpc.orders.admin.catalog.bundleRule.queryOptions());
  const [editing, setEditing] = useState(false);
  if (rule.isPending) return <Skeleton lines={2} />;
  if (rule.error) return <ErrorState error={rule.error} onRetry={() => void rule.refetch()} />;
  const value = rule.data as BundleRule;
  return (
    <Card
      title="Bundle discount"
      className="mb-6"
      actions={
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          Edit bundle discount
        </Button>
      }
    >
      {value.enabled ? (
        <p className="text-body">
          <Badge tone="success">On</Badge> <span className="font-medium text-ink">{value.label}</span>: {value.discountPercent}% off the order subtotal when the order includes
          packets {value.requiredPacketNumbers.join(", ")}.
        </p>
      ) : (
        <p className="text-body">
          <Badge>Off</Badge> No bundle discount is applied. The catalog import or this setting can turn it on.
        </p>
      )}
      {editing ? <BundleRuleDialog rule={value} onClose={() => setEditing(false)} /> : null}
    </Card>
  );
}

function BundleRuleDialog({ rule, onClose }: { rule: BundleRule; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const update = useMutation(trpc.orders.admin.catalog.updateBundleRule.mutationOptions());
  const [enabled, setEnabled] = useState(rule.enabled);
  const [packets, setPackets] = useState(rule.requiredPacketNumbers.join(", "));
  const [percent, setPercent] = useState(String(rule.discountPercent));
  const [label, setLabel] = useState(rule.label);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const required = parsePacketNumbers(packets);
    const discountPercent = Number(percent);
    if (required === null) return setError("Required packets must be whole numbers from 1 to 255, separated by commas.");
    if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) return setError("The discount must be a whole percentage from 0 to 100.");
    if (label.trim().length > 120) return setError("Keep the label to 120 characters.");
    if (enabled && (required.length === 0 || discountPercent === 0 || !label.trim()))
      return setError("To turn the discount on, list the required packets, a percentage above 0 and a label.");
    setError(null);
    try {
      const next = { enabled, requiredPacketNumbers: required, discountPercent, label: label.trim() };
      await update.mutateAsync({ rule: next });
      queryClient.setQueryData(trpc.orders.admin.catalog.bundleRule.queryKey(), next);
      await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
      toast.show({ tone: "success", title: "Bundle discount saved" });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Edit bundle discount"
      description="Applies to new orders and quotes only. Existing orders keep the amounts they were placed with."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button loading={update.isPending} onClick={() => void submit()}>
            Save bundle discount
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Checkbox label="Apply the bundle discount" checked={enabled} onCheckedChange={setEnabled} />
        <Field label="Required packets" hint="Packet numbers, separated by commas, e.g. 1, 2, 3.">
          <Input value={packets} onChange={(event) => setPackets(event.target.value)} inputMode="numeric" autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Discount (%)">
            <Input type="number" inputMode="numeric" min={0} max={100} value={percent} onChange={(event) => setPercent(event.target.value)} />
          </Field>
          <Field label="Label" hint="Shown to customers with the discount.">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
