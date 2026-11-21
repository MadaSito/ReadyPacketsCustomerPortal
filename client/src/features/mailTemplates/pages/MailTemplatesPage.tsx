import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  DataTable,
  DateTime,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  Input,
  PageHeader,
  RadioGroup,
  Section,
  Select,
  StepUpCancelledError,
  Textarea,
  useStepUp,
  useToast,
  type Column,
} from "@/ui";
import type {
  MailTemplateCategory,
  MailTemplateFormat,
  MailTemplateKind,
  MailTemplateVariableSpec,
} from "@server/modules/mailTemplates/schema";
import type { MailTemplateSummaryView } from "@server/modules/mailTemplates/service";
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  CUSTOM_CATEGORY_OPTIONS,
  FORMAT_OPTIONS,
  KIND_OPTIONS,
  MAIL_TEMPLATES_BASE,
  describeTemplateDeliveryState,
  normalizeCustomTemplateKey,
} from "../model";

const DEFAULT_STARTER_VARS: MailTemplateVariableSpec[] = [
  { name: "recipient_name", label: "Recipient name", required: false, sampleValue: "Taylor Jordan" },
  { name: "order_reference", label: "Order reference", required: false, sampleValue: "RP-2026-0142" },
  {
    name: "order_link",
    label: "Order link",
    required: false,
    sampleValue: "https://portal.example.test/orders/01J9EXAMPLE",
  },
];

export default function MailTemplatesPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, navigate] = useLocation();

  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | MailTemplateKind>("");
  const [categoryFilter, setCategoryFilter] = useState<"" | MailTemplateCategory>("");

  const [createOpen, setCreateOpen] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [categoryInput, setCategoryInput] = useState<MailTemplateCategory>("automation");
  const [formatInput, setFormatInput] = useState<MailTemplateFormat>("html");
  const [subjectInput, setSubjectInput] = useState("Update on order {{order_reference}}");
  const [bodyInput, setBodyInput] = useState(
    '<p>Hello {{recipient_name}},</p><p>There is an update on order <strong>{{order_reference}}</strong>.</p><p><a href="{{order_link}}" data-rp-button="primary">View order</a></p>',
  );
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery(
    trpc.mailTemplates.list.queryOptions({
      kind: kindFilter || undefined,
      category: categoryFilter || undefined,
      query: appliedSearch || undefined,
    }),
  );

  const createCustom = useMutation(trpc.mailTemplates.createCustom.mutationOptions());

  const activeFilterCount = (kindFilter ? 1 : 0) + (categoryFilter ? 1 : 0) + (appliedSearch ? 1 : 0);

  const resetFilters = () => {
    setSearchDraft("");
    setAppliedSearch("");
    setKindFilter("");
    setCategoryFilter("");
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const normalizedKey = normalizeCustomTemplateKey(slugInput);
    if (!/^custom\.[a-z][a-z0-9_]{1,63}$/.test(normalizedKey)) {
      setFormError("Enter a valid template key slug starting with a letter and using lowercase letters, numbers, or underscores.");
      return;
    }
    if (nameInput.trim().length < 2) {
      setFormError("Enter a display name for the template.");
      return;
    }
    if (!subjectInput.trim()) {
      setFormError("Enter an initial subject line.");
      return;
    }
    if (!bodyInput.trim()) {
      setFormError("Enter an initial message body.");
      return;
    }

    try {
      const created = await stepUp.run(
        () =>
          createCustom.mutateAsync({
            templateKey: normalizedKey,
            name: nameInput.trim(),
            description: descriptionInput.trim() || undefined,
            category: categoryInput,
            declaredVars: DEFAULT_STARTER_VARS,
            format: formatInput,
            subject: subjectInput.trim(),
            bodyHtml: formatInput === "html" ? bodyInput : undefined,
            bodyText: formatInput === "text" ? bodyInput : undefined,
            deriveTextFromHtml: true,
          }),
        { reason: "Creating an e-mail template requires a fresh confirmation." },
      );
      await qc.invalidateQueries({ queryKey: trpc.mailTemplates.list.queryKey() });
      toast.show({
        title: "Draft template created",
        description: "Review and publish when ready for automations.",
        tone: "success",
      });
      setCreateOpen(false);
      navigate(`${MAIL_TEMPLATES_BASE}/${encodeURIComponent(created.templateKey)}`);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setFormError(errorMessage(err));
    }
  };

  const columns: readonly Column<MailTemplateSummaryView>[] = [
    {
      key: "name",
      header: "Template",
      primary: true,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`${MAIL_TEMPLATES_BASE}/${encodeURIComponent(row.templateKey)}`}
            className="font-semibold text-ink underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <span className="font-mono text-xs break-all text-muted">{row.templateKey}</span>
          {row.description ? <span className="text-sm text-body">{row.description}</span> : null}
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind and category",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={row.kind === "system" ? "neutral" : "info"}>
            {row.kind === "system" ? "System" : "Custom"}
          </Badge>
          <span className="text-sm text-body">{CATEGORY_LABELS[row.category] ?? row.category}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Delivery status",
      cell: (row) => {
        const delivery = describeTemplateDeliveryState(row);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={delivery.tone}>{delivery.label}</Badge>
            {row.hasWorkingDraft ? <Badge tone="warning">Draft pending</Badge> : null}
          </div>
        );
      },
    },
    {
      key: "updatedAt",
      header: "Last updated",
      cell: (row) => <DateTime value={row.updatedAt} />,
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "E-mail templates" }]} />
        }
        title="E-mail templates"
        description="Customise system notifications and create reusable templates for automations. HTML templates are sanitised on save and on send, and every message includes a plain-text alternative."
        actions={
          <Button
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => {
              setFormError(null);
              setCreateOpen(true);
            }}
          >
            New custom template
          </Button>
        }
      />

      <Section title="Template catalogue">
        <FilterBar
          search={searchDraft}
          onSearchChange={setSearchDraft}
          onSearchSubmit={(val) => setAppliedSearch(val.trim())}
          searchLabel="Search templates"
          searchPlaceholder="Search by name, key, or description"
          activeCount={activeFilterCount}
          onReset={activeFilterCount > 0 ? resetFilters : undefined}
        >
          <Field label="Template kind" className="min-w-44">
            <Select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as "" | MailTemplateKind)}
              options={KIND_OPTIONS}
            />
          </Field>
          <Field label="Category" className="min-w-48">
            <Select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as "" | MailTemplateCategory)}
              options={CATEGORY_OPTIONS}
            />
          </Field>
        </FilterBar>

        <DataTable
          caption="E-mail templates"
          columns={columns}
          rows={listQuery.data?.items}
          rowKey={(row) => row.publicId}
          loading={listQuery.isLoading}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          rowActions={(row) => (
            <Button asChild size="sm" variant="secondary">
              <Link href={`${MAIL_TEMPLATES_BASE}/${encodeURIComponent(row.templateKey)}`}>Manage</Link>
            </Button>
          )}
          empty={
            <EmptyState
              icon={Mail}
              title="No matching templates"
              description="Clear your filters or create a custom template for automations."
              action={
                <Button variant="secondary" onClick={resetFilters}>
                  Reset filters
                </Button>
              }
            />
          }
        />
      </Section>

      <Dialog
        open={createOpen}
        onOpenChange={(next) => !createCustom.isPending && setCreateOpen(next)}
        title="New custom template"
        description="Custom templates start as drafts and become selectable in automations once published."
        size="lg"
        dismissible={!createCustom.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setCreateOpen(false)}
              disabled={createCustom.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="rp-create-mail-template-form"
              loading={createCustom.isPending}
            >
              Create draft template
            </Button>
          </>
        }
      >
        <form
          id="rp-create-mail-template-form"
          onSubmit={(e) => void handleCreateSubmit(e)}
          className="flex flex-col gap-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Template key"
              hint="Automatically prefixed with custom. (for example custom.order_followup)."
              required
            >
              <Input
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                placeholder="custom.order_followup"
                autoComplete="off"
              />
            </Field>
            <Field label="Display name" required>
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Order follow-up"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select
                value={categoryInput}
                onChange={(e) => setCategoryInput(e.target.value as MailTemplateCategory)}
                options={CUSTOM_CATEGORY_OPTIONS}
              />
            </Field>
            <Field label="Description">
              <Input
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                placeholder="When and why this template is sent"
              />
            </Field>
          </div>

          <RadioGroup
            legend="Initial format"
            value={formatInput}
            onValueChange={(val) => {
              const next = val as MailTemplateFormat;
              setFormatInput(next);
              if (next === "text" && bodyInput.startsWith("<")) {
                setBodyInput(
                  "Hello {{recipient_name}},\n\nThere is an update on order {{order_reference}}:\n{{order_link}}",
                );
              }
            }}
            options={FORMAT_OPTIONS}
          />

          <Field
            label="Subject line"
            hint="Starter placeholders: {{recipient_name}}, {{order_reference}} and {{order_link}}. Declare more in the editor after creating the draft."
            required
          >
            <Input value={subjectInput} onChange={(e) => setSubjectInput(e.target.value)} />
          </Field>

          <Field
            label={formatInput === "html" ? "Initial HTML body" : "Initial plain-text body"}
            hint="You can refine formatting, variables, and preview in the full editor right after creating the draft."
            required
          >
            <Textarea rows={5} value={bodyInput} onChange={(e) => setBodyInput(e.target.value)} />
          </Field>

          {formError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}
