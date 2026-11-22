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
| `DataTable<Row>` | `caption` (required), `columns: Column<Row>[]`, `rows`, `rowKey`, `loading?`, `error?`, `onRetry?`, `empty?`, `sort?`, `onSortChange?`, `rowActions?` | Table ≥ md; stacked labelled cards < md. `Column = {key, header, cell(row), sortable?, align?: "end", primary?, hideOnMobile?, className?}`. Sort keys must be server-allowlisted. Optional `selection: DataTableSelection<Row>` = `{selectedKeys, onSelectedKeysChange, rowLabel(row), isSelectable?, noun?}` adds named 44 px row checkboxes, a mixed-state "Select all … on this page" box (table header and above the cards) and a polite "n of m … selected" status; render your own bulk-action buttons ("Export selected") next to the table. |
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

## Increment 03 components (package K)

All exported from `@/ui`. `FlowCanvas` and `RichTextEditor` are lazy wrappers: the library code (@xyflow/react,
TipTap) loads in its own chunk the first time the component renders; a `Skeleton` shows meanwhile. Nothing in them
injects `<style>` elements or style attributes, so they run under `style-src 'self'` without changes.

### FlowCanvas — `import { FlowCanvas } from "@/ui"`
```ts
type FlowTone = "neutral" | "info" | "success" | "warning" | "danger";
interface FlowNode { id: string; label: string; sublabel?: string; kind?: string /* small tag, e.g. "Trigger" */; tone?: FlowTone; x: number; y: number }
interface FlowEdge { id: string; from: string; to: string; label?: string }
type FlowSelection = { type: "node" | "edge"; id: string } | null;
interface FlowCanvasProps {
  label: string;                                   // accessible name, e.g. "Workflow canvas"
  nodes: FlowNode[]; edges: FlowEdge[];            // controlled: the canvas never keeps its own copy
  selected?: FlowSelection; onSelect?: (s: FlowSelection) => void;
  onMove?: (id: string, x: number, y: number) => void;    // drag end, or keyboard move (snapped to 20 px)
  onConnect?: (from: string, to: string) => void;          // drag handle-to-handle, or keyboard connect
  onDelete?: (s: NonNullable<FlowSelection>) => void;      // Delete / Backspace on the selection
  readOnly?: boolean;                              // no move / connect / delete; select + pan / zoom still work
  height?: "sm" | "md" | "lg";                     // 20 / 30 / 40 rem (capped to 70 vh on phones)
}
```
Keyboard: Tab reaches the toolbar (Zoom in, Zoom out, Fit to view), then each connection (a labelled button at
the middle of the arrow, "Label: from A to B"), then each node (top-to-bottom, left-to-right); Enter / Space
selects; arrow keys move the focused node by 20 px (Shift: 100 px) and select it; `C` starts "connect" mode from
the focused node, Enter on the target finishes it, Escape cancels; Delete / Backspace removes the focused item
(only with `onDelete`); Escape clears the selection. A focused item scrolled out of view is panned into view.
Every action is announced in a polite live region; the shortcut help is visible under the toolbar. Drag-only is
never required, but you must still offer a form alternative for connecting and for editing properties (side
panel). Reduced motion: no animated edges or
transitions; fit / zoom are instant.

### RichTextEditor — `import { RichTextEditor } from "@/ui"`
```ts
interface EditorVariable { name: string; label: string; required?: boolean }
interface RichTextEditorProps {
  label: string; hint?: string; error?: string; required?: boolean; id?: string;
  value: string;                          // HTML in the subset below
  onChange: (html: string) => void;
  variables?: EditorVariable[];           // palette; inserted as chips
  disabled?: boolean;
}
```
Toolbar (`role="toolbar"`, one Tab stop, arrows / Home / End move between tools): Paragraph, Heading 2, Heading 3,
Bold, Italic, Bulleted list, Numbered list, Link (+ Remove link), Button, Image, Insert variable, Undo, Redo
(names + `aria-pressed`; Ctrl/Cmd+B / I / Z work). Link / Button / Image open a dialog that validates the address
(Image also requires alt text). Helpers `isAllowedMailHref(url)` and `isAllowedMailImageSrc(url)` are exported for
your own forms. The editable element is `role="textbox" aria-multiline` labelled by `label`.
Output HTML subset (the server sanitiser must accept exactly this and drop the rest):
`p, h2, h3, strong, em, ul, ol, li, br, hr`, `a[href]` (href `https:`, `mailto:` or exactly `{{variable}}`),
`a[href][data-rp-button="primary"]` (button), `img[src][alt]` (src `https:` only; alt required).
Variables appear in the output as the literal text `{{name}}` (inside text or as an href), never as markup.
Pasted content is reduced to the subset in the editor too, but the server sanitiser is the authority.

### InertMailPreview — `import { InertMailPreview } from "@/ui"`
```ts
interface InertMailPreviewProps { title: string; html?: string /* server structural projection */; text: string; height?: "sm" | "md" | "lg" }
```
Tabs "Structure preview" (sandboxed `srcDoc` iframe, `sandbox=""`, no allow tokens, `referrerPolicy="no-referrer"`,
CSP meta `default-src 'none'; base-uri 'none'; form-action 'none'` first) and "Plain text". `html` must be the
server's preview projection (no href/src/srcset, no forms/meta/base/styles/SVG/MathML); the component never builds
HTML and never uses `dangerouslySetInnerHTML`. Without `html` only the plain text is shown. The only approved way to
show stored or rendered mail HTML in the console.

### Wizard — `import { Wizard } from "@/ui"`
```ts
interface WizardStep { id: string; label: string; optional?: boolean }
interface WizardProps {
  steps: WizardStep[]; current: string;            // controlled
  onNext: () => void;                              // the step's <form> submit (validate here; don't advance on error)
  onBack?: () => void;                             // Back hidden on the first step
  onStepSelect?: (id: string) => void;             // makes completed steps clickable
  completed?: string[];
  nextLabel?: string;                              // default "Continue"; e.g. "Publish" on the last step
  nextDisabled?: boolean; busy?: boolean;
  secondaryAction?: ReactNode;                     // e.g. <Button variant="ghost">Save draft</Button>
  children: ReactNode;                             // current step body (fields only; no <form>)
}
```
Renders the progress `<ol aria-label="Progress">` (compact "Step 2 of 4" on phones), the step `<h2>` (focused on
step change), one `<form noValidate>` and the Back / Continue bar. Entered data is yours: keep it in the parent.

### SsoButton — `import { SsoButton } from "@/ui"`
```ts
interface SsoButtonProps { href: string; label?: string /* "Sign in with SSO" */; providerName?: string /* "Microsoft Entra ID" */; disabled?: boolean; divider?: boolean /* "or" divider above, default true */ }
```
Full-width secondary-style button (a real link, so the browser performs a top-level navigation to the start
endpoint), key icon, provider name as a second line, preceded by an "or" divider. The sign-in page shows it through `SsoSignInSlot` (identity feature).

### Console navigation for increment 03
Each owner adds the entry to their own `routes.tsx` `nav` with these values (paths are siblings because the
sidebar marks `href` and everything under `href/` as current):

| Label | href | group | order | owner |
| --- | --- | --- | --- | --- |
| Workflows (exists) | `/admin/workflows` | Operations | 14 | orders |
| Single sign-on | `/admin/sso` | Security | 31 | identity |
| E-mail delivery | `/admin/email-delivery` | Integrations | 60 | siem |
| E-mail templates | `/admin/email-templates` | Integrations | 61 | compliance |
| Automations | `/admin/automations` | Integrations | 62 | audit (client) |
| Storage connections | `/admin/storage` | Integrations | 63 | siem |
| SharePoint order sync | `/admin/sharepoint-sync` | Integrations | 64 | siem |

The existing `/admin/mail` (jobs, "Mail") stays as the message log; suggested new label "Mail log".

## Increment 04 (package N): shared components, customer navigation, theme control, responsive rules

Status: the **interfaces below are final**. Build against them now. Components land in `@/ui` as they are
committed; each row says what it does so you can stub until then. Everything is keyboard operable,
24 px minimum targets (44 px on coarse pointers), and tested with axe in light and dark.

### New and changed components (`import { … } from "@/ui"`)

| Component | Props | Notes |
| --- | --- | --- |
| `SegmentedControl<T extends string>` | `label` (group name, required), `options: {value: T, label: string, icon?: LucideIcon}[]`, `value: T`, `onValueChange(v: T)`, `size?: "sm"\|"md"`, `iconOnly?: boolean`, `className?` | `role="radiogroup"`, roving tabindex, arrows/Home/End select. `iconOnly` keeps the label as the accessible name and as a tooltip. Use for 2–5 mutually exclusive views or modes. |
| `ThemeControl` | `variant?: "full"\|"compact"`, `className?` | System \| Light \| Dark segmented control bound to `useTheme()`. `compact` is icon-only (phones). Used by the shells, the sign-in page and Account settings; owners of settings pages just render `<ThemeControl />`. |
| `Stepper` | `label`, `steps: {key, label, description?, state: "done"\|"current"\|"upcoming"\|"locked"\|"blocked"}[]`, `orientation?: "auto"\|"horizontal"\|"vertical"`, `onStepSelect?(key)` | Ordered list, `aria-current="step"`, state as icon **and** text (sr-only suffix "completed", "locked", …). `auto` = vertical in narrow containers (container query), horizontal otherwise. With `onStepSelect`, done steps become buttons. |
| `PhaseRail` | same as `Stepper` plus `phases[].meta?: ReactNode` (for example a lock badge or date) | Order-page variant of `Stepper` with a lock icon for `locked`. Use `Stepper` for wizards that are not `Wizard`. |
| `Checklist` | `title`, `headingLevel?: 2\|3`, `items: {key, label, description?, state: "done"\|"todo"\|"blocked"\|"optional", action?: ReactNode}[]`, `summary?: string` | Shows "2 of 5 done" (computed when `summary` is omitted, optional items excluded). Item state as icon and text. The progress summary is a polite live region. |
| `StatCard` | `label`, `value: ReactNode`, `hint?`, `icon?: LucideIcon`, `tone?: "neutral"\|"info"\|"success"\|"warning"\|"danger"`, `href?` (whole card becomes one link), `loading?` | `<dl>` semantics; tone is decoration only, never the message. Put them in `<StatGrid>` (1 → 2 → 4 columns by container width). |
| `StatGrid` | `children`, `label?` | Responsive grid for `StatCard`s (container query). |
| `CopyField` | `label`, `value`, `hint?`, `monospace?`, `copyLabel?`, `secret?: boolean` | Read-only input + Copy button; "Copied" announced politely. `secret` masks the value with a Show toggle (for one-time API keys / webhook secrets). Never put a secret in the URL or in a toast. |
| `EmptyState` (changed) | adds `variant?: "default"\|"first-use"\|"no-results"\|"filtered"\|"disabled"\|"error"`, `size?: "sm"\|"md"`, `onClearFilters?()` | Variant chooses the default icon and, for `filtered`, a "Clear filters" button. `disabled` = feature off ("This feature isn't turned on"). Existing calls unchanged. |
| `TagInput` | `label`, `value: string[]`, `onValueChange(v)`, `max?`, `maxLength?` (per tag, default 40), `suggestions?: string[]`, `validate?(tag) => string \| null`, `normalize?(tag) => string` (default trim + lower-case), `hint?`, `error?`, `placeholder?`, `disabled?` | Enter or comma adds, Backspace on empty removes the last tag, each tag has a "Remove tag X" button, duplicates refused with a text error, changes announced. Wraps itself in a `Field`. |
| `CodeBlock` (changed) | adds `language?: string` (shown as a caption, no highlighting, no inline styles) | Existing props unchanged. |
| `CodeSamples` | `label`, `samples: {key, label, code, language?}[]`, `defaultKey?` | Tabs of `CodeBlock`s (curl / JavaScript / Python for API docs), each copyable. |
| `Timeline` | `label`, `items: {key, title: ReactNode, time: Date\|string, description?: ReactNode, actor?: string, icon?: LucideIcon, tone?: Tone}[]`, `order?: "newest-first"\|"oldest-first"` | `<ol>` with `<time>`; tone never the only signal. Use for audit trails, order history, referral history. |
| `Pagination` | cursor mode: `hasPrevious`, `hasNext`, `onPrevious()`, `onNext()`; page mode: `page`, `pageCount`, `onPageChange(n)`; both: `label`, `summary?` ("Showing 26–50 of 112"), `loading?` | `<nav aria-label>`; summary polite. Page mode collapses to "Page x of y" + previous/next below sm. `LoadMore` stays for infinite lists. |
| `DataTable` (unchanged API) | — | Already renders stacked labelled cards below md. Rule: never give a table a fixed min-width; mark one column `primary`. |
| `Breadcrumbs` (unchanged) | — | **Required** on every page nested two or more levels below a navigation entry (pass `breadcrumbs` to `PageHeader`). |

### NavItem changes (`@/lib/routes`)

```ts
interface NavItem {
  // … existing fields …
  /** Customer area: undefined = main section, "Support", or "Account". Console: the existing heading. */
  group?: string;
  /** Feature switch key; the entry is shown only when `features.enabled(key)` is true (platform port). */
  enabledBy?: "cart" | "community" | "referrals" | "knowledge" | (string & {});
}
```

- `placement` keeps working. In the customer area an entry without `group` whose placement is `account`
  (paths `/account…`, `/policies`) is treated as `group: "Account"`.
- Current page: the **longest** matching `href` wins, so `/orders` and `/orders/new`, or `/account` and
  `/account/security`, can both be entries.
- Entries with `enabledBy` are hidden until the platform port says the feature is on (and when the port is
  missing). Hiding is never authorisation; the server refuses disabled routes too.

### Customer navigation (each owner sets these values in their own `routes.tsx`)

| Section | Label | href | order | owner | enabledBy |
| --- | --- | --- | --- | --- | --- |
| main | Dashboard | `/` | 0 | dashboard (ui_foundation) | |
| main | My orders | `/orders` | 10 | orders | |
| main | Create an order | `/orders/new` | 12 | orders | |
| main | Cart | `/cart` | 14 | cart (recovery_ops) | `cart` |
| main | Messages | `/messages` | 20 | engagement | |
| main | Invoices | `/invoices` | 40 | compliance | |
| Support | Support | `/support` | 100 | engagement | |
| Support | Community | `/community` | 110 | community (audit) | `community` |
| Support | Knowledge base | `/help` | 120 | knowledge (engagement) | `knowledge` |
| Account | Settings | `/account` | 200 | identity | |
| Account | Referrals | `/account/referrals` | 210 | referrals (siem) | `referrals` |
| Account | Security | `/account/security` | 220 | identity / assurance (one entry only) | |
| Account | Policies | `/policies` | 230 | compliance | |
| Account | Privacy and cookies | `/account/privacy` | 240 | consent (platform) | |

`/notifications` stays `placement: "hidden"` (the bell). `/account/sessions` becomes `placement: "hidden"` once the
Security page lists sessions (package D). Use `group: "Support"` / `group: "Account"` exactly.

Shell behaviour: left sidebar with section headings at ≥ lg, collapsible to icons (the collapsed state is
in-memory only); drawer from the top-bar menu button below lg; phone bottom bar with Dashboard, My orders,
Create an order, Messages + "More" (everything else). Theme control: segmented in the top bar ≥ sm,
compact below; also on the sign-in page.

### Shell slots for other features (app composes; features never import each other)

| Slot | Module the app looks for (optional, glob) | Export | Where it renders |
| --- | --- | --- | --- |
| Feature switches | `@/lib/features` (platform owns the file) | `useFeatureFlags(): (key: string) => boolean` (false while loading/unknown) | customer + console nav (`enabledBy`) |
| Theme persistence | `@/lib/consent` (platform) + identity preference procedure | — | in-memory by default; saved server-side for a signed-in user; on anonymous screens it follows the system setting (decision 14) |
| Cookie banner | `features/platform/consent/CookieConsent.tsx` | `CookieConsent()` | first element of every layout (public, auth, customer, console) via `CookieConsentSlot` |
| "Manage cookie preferences" | `@/lib/consent` → `consent.openPreferences()` | — | every footer (shell renders the button) |
| Customer maintenance | `features/jobs/CustomerMaintenanceBanner.tsx` | `CustomerMaintenanceBanner()` | sign-in page and console shell, separate from the drain banner |
| Cart badge | `features/cart/CartBadge.tsx` | `CartBadge()` (count, `aria-label` with the number) | next to the Cart entry |

Missing module or a thrown error renders nothing.

### Responsive rules (every page)

- No horizontal page scroll from 240 px to 3840 px. Use `min-w-0` on flex/grid children, `break-words` on
  user text, no fixed widths above 240 px.
- Type is fluid (`--text-*` tokens use `clamp()`); do not set pixel font sizes.
- Components that live both in a sidebar and in a page body use container queries (`@container` on the
  wrapper, `@md:` variants), not viewport breakpoints.
- Fixed bars respect `env(safe-area-inset-*)`; landscape phones (short height) keep content visible:
  avoid `h-screen`, use `min-h-dvh`.
- Hover-only affordances must also exist for `hover: none`; coarse pointers get 44 px targets.
- Printable pages (articles, invoices, receipts) use the `rp-print-*` helpers: shells, navigation and
  buttons are hidden in print; `rp-print-avoid-break` keeps a block together.
- `scripts/qa/responsive-check.mjs` checks every route at 240, 320, 390, 768, 1024, 1440, 1920 and 2560 px in
  both themes for horizontal overflow, clipped text and targets under 24 px.

## Increment 04 part B: `RouteTabs` (order workspace tab strip)

`RouteTabs` + `RouteTabPanel` (from `@/ui`) are the console order page's tab strip (decision B1): one `tablist` whose
tabs are links (`href` per tab, so every tab keeps its own URL segment), roving focus (Tab enters on the selected tab;
←/→ wrap and skip disabled tabs; Home/End; Enter or Space opens — arrowing never navigates), visible "Scroll tabs
left/right" buttons on the overflowing side (named, out of the Tab order; the arrow keys are the keyboard
equivalent and scroll the focused tab into view), and below 480 px a labelled native select with the same tabs
(counts as "(n)", disabled tabs disabled). Pass a stable `idBase` to both components; if the page remounts the strip
on a URL change, focus returns to the opened tab. `labelContent` renders live text (a `labelComponent`) in the strip;
the select uses the static `label`. Counts above 99 show "99+".

```tsx
const tabs = ORDER_TABS.filter(visible).map((t) => ({ value: t.key, label: t.label, href: `${base}/${t.key}`,
  labelContent: t.labelComponent ? <t.labelComponent orderId={id} area="console" /> : undefined }));
<RouteTabs idBase="order-tabs" items={[{ value: "overview", label: "Overview", href: base }, ...tabs]} value={active} label="Order sections" />
<RouteTabPanel idBase="order-tabs" value={active}>{panel}</RouteTabPanel>
```
Tests: `client/src/ui/routeTabs.test.tsx`.
