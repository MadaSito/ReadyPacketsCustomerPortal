/** Console catalog management (/admin/catalog). Owner: orders_engineer. Ships empty; no built-in products. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, Money, PageHeader, Select, Skeleton, Textarea, useToast } from "@/ui";
import { money } from "../shared";

type Product = {
  publicId: string;
  productKey: string;
  groupPublicId: string;
  name: string;
  description: string;
  features: string[];
  priceMinor: number;
  currency: string;
  versionNumber: number;
  sortOrder: number;
  active: boolean;
  rowVersion: number;
};
type Group = { publicId: string; name: string; description: string; sortOrder: number; active: boolean; rowVersion: number; products: Product[] };

const CURRENCY = /^[A-Z]{3}$/;

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
                      </span>
                    ),
                  },
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
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const order = Number(sortOrder);
    if (!name.trim()) return setError("Enter a group name.");
    if (!Number.isInteger(order) || order < 0 || order > 10000) return setError("Display order must be a whole number from 0 to 10000.");
    setError(null);
    try {
      const values = { name: name.trim(), description: description.trim(), sortOrder: order, active };
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
  });
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
    setError(null);
    const terms = { name: values.name.trim(), description: values.description.trim(), features, priceMinor, currency: values.currency, groupId: values.groupId, sortOrder, active: values.active };
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
      description={product ? "Changing the name, description, features or price publishes a new version. Existing orders are not affected." : undefined}
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
        <Field label="Features" hint="One per line.">
          <Textarea value={values.features} onChange={set("features")} rows={4} />
        </Field>
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
