# ReadyPackets UI kit (`@/ui`)

Owner: ui_foundation_engineer. Import **only** from `@/ui` (`import { Button, Field, Input } from "@/ui"`).
Built on Radix primitives + Tailwind 4 semantic tokens. Target: WCAG 2.2 AA, 320–1920 px, light/dark.

## Rules for feature code

- Colours: semantic utilities only — `bg-surface`, `bg-surface-soft`, `bg-surface-sunken`, `text-ink` (headings),
  `text-body` (copy), `text-muted` (secondary), `border-line` (separators), `border-control-border` (control edges),
  `text-action`/`bg-action` + `text-on-action`, `text-danger|success|warning|info`, `bg-*-soft` tints,
  `bg-navy` + `text-on-navy`. No hex, no inline colour styles, no `gray-500` etc. (the default palette is removed).
  Contrast of every rendered pair is computed in `client/src/ui/tokens.test.ts` — do not invent new pairs; ask.
  Note: light `text-success` must not sit on `bg-surface-sunken` (4.46:1) — use `Badge`/`StatusBadge`.
- Radius: `rounded-[var(--radius-card)]` (cards), `rounded-[var(--radius-control)]` (controls). Shadows: `shadow-[var(--shadow-card)]`.
- Every page: exactly one `<h1>` via `PageHeader`; loading (`Skeleton`/`Spinner`), empty (`EmptyState`) and error
  (`ErrorState`) states; no horizontal page scroll at 320 px (use `min-w-0`, `break-words`, `DataTable`).
- Touch targets ≥ 44 px (kit controls already comply). Never convey state by colour alone (StatusBadge has icon + text).
- Never `window.confirm/alert/prompt` → `ConfirmDialog`. Never browser storage. Never `href="#…"`; use wouter `<Link>`.
- Errors from tRPC: `errorMessage(err)` from `@/lib/trpc`, or pass the error to `ErrorState`.
- The page body is already inside `<main id="main">` in the shell; don't render another `<main>`.

## Components

| Component | Key props | Notes |
| --- | --- | --- |
| `Button` | `variant: primary\|secondary\|ghost\|danger\|link`, `size: sm\|md\|lg`, `loading`, `block`, `asChild`, `leadingIcon`, `trailingIcon` | `type="button"` by default. `asChild` to style a `<Link>`. |
| `IconButton` | `label` (required accessible name), `icon`, `variant`, `size` | 44 px square. |
| `Field` | `label`, `hint?`, `error?`, `required?`, `hideLabel?`, `labelAside?`, `id?` | Wraps ONE `Input`/`Textarea`/`Select`; wires `id`, `aria-describedby`, `aria-invalid`, `aria-required`. Custom controls: `useFieldControl()`. |
| `Input`, `Textarea` | native props | Put `autoComplete`, `inputMode`, `maxLength` on them. |
| `Select` | `options: {value,label,disabled?}[]`, `placeholder?`, native select props | Native select (best mobile/AT). |
| `Checkbox` | `label`, `description?`, `checked`, `onCheckedChange(bool)`, `error?`, `required?` | Self-labelled; don't wrap in `Field`. |
| `Switch` | `label`, `description?`, `checked`, `onCheckedChange` | For immediate on/off settings. |
| `RadioGroup` | `legend`, `options: {value,label,description?}[]`, `value`, `onValueChange`, `variant: plain\|cards`, `error?`, `hint?` | `<fieldset>`/`<legend>`; arrow keys. |
| `Card` | `title?`, `description?`, `actions?`, `footer?`, `headingLevel=2`, `flush`, `as` | |
| `PageHeader` | `title` (the h1), `description?`, `actions?`, `breadcrumbs?`, `meta?` | |
| `Section` | `title`, `description?`, `actions?`, `headingLevel=2` | `<section aria-labelledby>`. |
| `KeyValueList` | `items: {label,value,wide?}[]`, `columns: 1\|2\|3` | `<dl>`, single column on mobile. |
| `Badge` | `tone: neutral\|info\|success\|warning\|danger\|brand`, `icon?` | Text always present. |
| `StatusBadge` | `state: OperationState`, `label?` | queued/running/completed/failed/canceled/refused/unknown with icon + text. `unknown` is never shown as failed. |
| `Callout` | `tone: info\|success\|warning\|danger`, `title?`, `actions?`, `live?: polite\|assertive` | Inline notices; `live` makes it a status/alert region. Use `tone="warning"` + text "Not configured" for disabled integrations. |
| `Skeleton` | `className`, `lines?` | aria-hidden placeholder. |
| `Spinner` | `size`, `label="Loading"` (`""` when parent conveys busy) | role=status. |
| `EmptyState` | `icon?` (lucide), `title`, `description?`, `action?`, `headingLevel` | Guide the next step. |
| `ErrorState` | `error?`, `title?`, `message?`, `onRetry?` | Shows safe message + request reference only. |
| `LoadMore` | `hasMore`, `loading?`, `onLoadMore`, `summary?` | Cursor pagination; summary announced politely. |
| `DataTable<Row>` | `caption` (required), `columns: Column<Row>[]`, `rows`, `rowKey`, `loading?`, `error?`, `onRetry?`, `empty?`, `sort?`, `onSortChange?`, `rowActions?` | Table ≥ md; stacked labelled cards < md. `Column = {key, header, cell(row), sortable?, align?: "end", primary?, hideOnMobile?, className?}`. Sort keys must be server-allowlisted. |
| `FilterBar` | `search`, `onSearchChange`, `onSearchSubmit`, `searchLabel`, `children` (filter Fields), `activeCount`, `onReset`, `actions` | Filters inline ≥ md; in a Drawer on mobile. |
| `Tabs` | `label` (tablist name), `items: {value,label,badge?,content,disabled?}[]`, `value`/`defaultValue`, `onValueChange` | Scrolls horizontally when narrow. |
| `Dialog` | `open`, `onOpenChange`, `trigger?`, `title`, `description?`, `footer?`, `size: sm\|md\|lg\|xl`, `dismissible`, `initialFocusRef?` | Focus trap, restore, Escape. Bottom sheet on mobile. `DialogClose` wraps a close button. |
| `ConfirmDialog` | `open`, `onOpenChange`, `title`, `description?`, `confirmLabel`, `destructive?`, `onConfirm` (async; throw to keep open), `confirmText?` | `confirmText` = type-to-confirm for high-impact actions. Destructive focuses Cancel first. |
| `Drawer` | `open`, `onOpenChange`, `trigger?`, `title`, `description?`, `side: left\|right`, `width: sm\|md\|lg`, `footer?`, `hideTitle?` | Same focus guarantees as Dialog. |
| `DropdownMenu` | `trigger`, `items: (MenuItem \| "separator" \| {heading})[]`, `align`, `header?` | `MenuItem = {label, onSelect?, icon?, asChild?: <Link/>, destructive?, disabled?}`. |
| `Tooltip` | `content`, `children` (focusable trigger), `side` | Supplementary only. |
| `useToast()` | `.show({title, description?, tone?, duration?})`, `.dismiss(id)` | aria-live polite (danger → assertive). Never steals focus. |
| `Breadcrumbs` | `items: {label, href?}[]` | Last item is `aria-current="page"`. |
| `CopyButton` | `value`, `label`, `iconOnly?`, `size` | Toast confirms. |
| `CodeBlock` | `children: string`, `label`, `copyable?`, `wrap?` | Focusable scroll region. |
| `DateTime` | `value: Date\|string\|null`, `format: date\|datetime\|time\|relative` | `<time dateTime>` + absolute title. `formatDateTime()` for strings. |
| `Money` | `value: {amountMinor, currency} \| null` | Integer minor units only. |
| `FileDropzone` | `onFiles(files)`, `accept?`, `multiple?`, `maxSize?`, `label?`, `hint?`, `disabled?` | Button-first, drag-and-drop as enhancement; server re-validates. |
| `useStepUp()` | `.run(() => mutation.mutateAsync(input), { reason? })`, `.request({ reason? })` | On `STEP_UP_REQUIRED` opens the password + factor dialog, calls `assurance.stepUp`, retries once. Cancel → rejects with `StepUpCancelledError` (ignore it). |
| `BrandLogo` | `appearance: auto\|light\|dark`, `variant: full\|icon`, `label` | Approved 4-part PNG lockup. Only the shells/auth screens normally need it. |
| `useTheme()` | `{ preference, resolved, setPreference }` | In-memory System/Light/Dark. |

### Examples

```tsx
import { Button, Field, Input, StatusBadge, ConfirmDialog, useToast, useStepUp, isStepUpRequired } from "@/ui";

<Field label="Order title" hint="Shown to your consultant." error={errors.title} required>
  <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
</Field>

<StatusBadge state="unknown" />           // icon + "Unknown outcome"
<Button asChild variant="secondary"><Link href="/orders/new">New order</Link></Button>

const toast = useToast();
const stepUp = useStepUp();
const revoke = useMutation(trpc.siem.admin.revoke.mutationOptions());
const onRevoke = async () => {
  try {
    await stepUp.run(() => revoke.mutateAsync({ destinationId }), { reason: "Revoking a SIEM destination needs verification." });
    toast.show({ tone: "success", title: "Destination revoked" });
  } catch (err) {
    if (err instanceof StepUpCancelledError) return;
    toast.show({ tone: "danger", title: "Could not revoke", description: errorMessage(err) });
  }
};

<ConfirmDialog open={open} onOpenChange={setOpen} destructive title="Delete this draft?"
  description="This cannot be undone." confirmLabel="Delete draft" onConfirm={() => del.mutateAsync({ orderId })} />
```

## Page recipes

### List page
```tsx
export default function OrdersPage() {
  const trpc = useTRPC();
  const [search, setSearch] = useState(""); const [q, setQ] = useState("");
  const list = useInfiniteQuery(trpc.orders.list.infiniteQueryOptions({ q, limit: 25 }, { getNextPageParam: (p) => p.nextCursor }));
  const rows = list.data?.pages.flatMap((p) => p.items);
  return (
    <>
      <PageHeader title="Orders" description="Track every packet you have ordered." actions={<Button asChild><Link href="/orders/new">New order</Link></Button>} />
      <FilterBar search={search} onSearchChange={setSearch} onSearchSubmit={setQ} searchLabel="Search orders" />
      <DataTable caption="Your orders" rows={rows} loading={list.isPending} error={list.error} onRetry={() => list.refetch()}
        rowKey={(o) => o.publicId}
        columns={[
          { key: "number", header: "Order", primary: true, cell: (o) => <Link href={`/orders/${o.publicId}`} className="font-semibold text-action underline-offset-2 hover:underline">{o.orderNumber}</Link> },
          { key: "status", header: "Status", cell: (o) => <StatusBadge state={o.state} label={o.statusLabel} /> },
          { key: "updatedAt", header: "Updated", sortable: true, cell: (o) => <DateTime value={o.updatedAt} format="relative" /> },
          { key: "total", header: "Total", align: "end", cell: (o) => <Money value={o.total} /> },
        ]}
        empty={<EmptyState icon={Package} title="No orders yet" description="Start your first packet in a few minutes." action={<Button asChild><Link href="/orders/new">Start an order</Link></Button>} />} />
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={rows ? `Showing ${rows.length} orders` : undefined} />
    </>
  );
}
```

### Detail page
```tsx
<PageHeader breadcrumbs={<Breadcrumbs items={[{ label: "Orders", href: "/orders" }, { label: order.orderNumber }]} />}
  title={order.title} meta={<StatusBadge state={order.state} />} actions={<Button variant="secondary">Download</Button>} />
<div className="grid gap-6 lg:grid-cols-3">
  <Card title="Summary" className="lg:col-span-2"><KeyValueList items={[{ label: "Order", value: order.orderNumber }, { label: "Placed", value: <DateTime value={order.createdAt} /> }]} /></Card>
  <Card title="Activity">…</Card>
</div>
<Tabs label="Order sections" items={ORDER_TABS.filter(…).map((t) => ({ value: t.key, label: t.label, content: <t.component orderId={id} area="customer" /> }))} />
```
Loading: render `PageHeader` with a `Skeleton` title + `Skeleton lines={4}`; not found/forbidden: `ErrorState` (server returns NOT_FOUND for both).

### Form page
```tsx
<form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-5">
  {formError ? <Callout tone="danger" live="assertive" title="Please fix the highlighted fields">{formError}</Callout> : null}
  <Field label="Company name" required error={fieldErrors.name}><Input name="name" autoComplete="organization" maxLength={160} /></Field>
  <Field label="Notes" hint="Optional."><Textarea maxLength={4000} /></Field>
  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    <Button variant="secondary" asChild><Link href="/orders">Cancel</Link></Button>
    <Button type="submit" loading={save.isPending}>Save</Button>
  </div>
</form>
```
Map server `safeError(err)?.fieldErrors` to `Field error`. After a failed submit, move focus to the error Callout or first invalid control.

### Wizard
Steps as an `<ol aria-label="Progress">` with `aria-current="step"` on the active item (text "Step 2 of 4: Details"), one
`<form>` per step, Back (`secondary`) / Continue (`primary`) at the bottom, focus moved to the step `<h2>` on change
(`ref.current?.focus()` with `tabIndex={-1}`). Never lose entered data on Back. Final step: summary `KeyValueList` +
explicit submit. Use `RadioGroup variant="cards"` for package/option choice.

### Admin table with filters
```tsx
<PageHeader title="Audit events" description="Search the durable audit trail." actions={<Button variant="secondary" onClick={onExport}>Export</Button>} />
<FilterBar search={text} onSearchChange={setText} onSearchSubmit={apply} searchLabel="Search events" activeCount={active} onReset={reset}>
  <Field label="Category"><Select options={CATEGORIES} placeholder="All" value={cat} onChange={(e) => setCat(e.target.value)} /></Field>
  <Field label="Outcome"><Select options={OUTCOMES} placeholder="Any" value={outcome} onChange={…} /></Field>
  <Field label="From"><Input type="datetime-local" value={from} onChange={…} /></Field>
</FilterBar>
<DataTable caption="Audit events" sort={sort} onSortChange={setSort} rowActions={(e) => <Button size="sm" variant="ghost" onClick={() => open(e)}>Details</Button>} … />
<Drawer open={!!selected} onOpenChange={() => setSelected(null)} title="Event details" width="lg"><CodeBlock label="Event JSON">{json}</CodeBlock></Drawer>
```
Exports and other privileged actions: wrap with `useStepUp().run(...)`.

## Accessibility guarantees vs. your responsibilities

The kit provides labelled controls, focus management in overlays, live regions for toasts, visible focus (3 px,
3 px offset), reduced-motion handling and 44 px targets. You still must: give every page one h1, keep heading
order, label icon-only actions, write meaningful link text, and keep tests with `axe-core` (see
`client/src/ui/ui.test.tsx` for the `expectNoAxeViolations` helper pattern). We target WCAG 2.2 AA; we do not
claim certification.
