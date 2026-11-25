import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  InertMailPreview,
  Input,
  PageHeader,
  RadioGroup,
  RichTextEditor,
  Section,
  Skeleton,
  StepUpCancelledError,
  Switch,
  Textarea,
  useStepUp,
  useToast,
  type Column,
} from "@/ui";
import type { MailTemplateFormat, MailTemplateVariableSpec } from "@server/modules/mailTemplates/schema";
import type { MailTemplateDetailView, MailTemplateVersionView } from "@server/modules/mailTemplates/service";
import {
  CATEGORY_LABELS,
  FORMAT_OPTIONS,
  MAIL_TEMPLATES_BASE,
  describeTemplateDeliveryState,
  findMissingRequiredVariables,
} from "../model";

function pickInitialEditorSource(data: MailTemplateDetailView) {
  if (data.workingDraft) {
    return {
      format: data.workingDraft.format,
      subject: data.workingDraft.subject,
      bodyHtml: data.workingDraft.bodyHtml ?? "",
      bodyText: data.workingDraft.bodyText,
      deriveTextFromHtml: data.workingDraft.format === "html",
    };
  }
  if (data.activePublished) {
    return {
      format: data.activePublished.format,
      subject: data.activePublished.subject,
      bodyHtml: data.activePublished.bodyHtml ?? "",
      bodyText: data.activePublished.bodyText,
      deriveTextFromHtml: data.activePublished.format === "html",
    };
  }
  if (data.systemDefault) {
    return {
      format: data.systemDefault.format,
      subject: data.systemDefault.subject,
      bodyHtml: data.systemDefault.bodyHtml,
      bodyText: data.systemDefault.bodyText,
      deriveTextFromHtml: data.systemDefault.format === "html",
    };
  }
  return {
    format: "html" as MailTemplateFormat,
    subject: "",
    bodyHtml: "",
    bodyText: "",
    deriveTextFromHtml: true,
  };
}

export default function MailTemplateEditorPage() {
  const params = useParams<{ templateKey: string }>();
  const templateKey = decodeURIComponent(params.templateKey ?? "");

  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const detailQuery = useQuery(
    trpc.mailTemplates.get.queryOptions({ templateKey }, { enabled: Boolean(templateKey) }),
  );
  const saveDraftMut = useMutation(trpc.mailTemplates.saveDraft.mutationOptions());
  const publishMut = useMutation(trpc.mailTemplates.publish.mutationOptions());
  const resetMut = useMutation(trpc.mailTemplates.resetToDefault.mutationOptions());
  const restoreMut = useMutation(trpc.mailTemplates.restoreVersion.mutationOptions());
  const previewMut = useMutation(trpc.mailTemplates.preview.mutationOptions());
  const sendTestMut = useMutation(trpc.mailTemplates.sendTestToMe.mutationOptions());

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [declaredVars, setDeclaredVars] = useState<MailTemplateVariableSpec[]>([]);
  const [format, setFormat] = useState<MailTemplateFormat>("html");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [deriveTextFromHtml, setDeriveTextFromHtml] = useState(true);
  const [changeNote, setChangeNote] = useState("");
  const [sampleVars, setSampleVars] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const [newVarName, setNewVarName] = useState("");
  const [newVarLabel, setNewVarLabel] = useState("");
  const [newVarSample, setNewVarSample] = useState("");
  const [newVarRequired, setNewVarRequired] = useState(false);

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<MailTemplateVersionView | null>(null);

  const hydratedVersionRef = useRef<string | null>(null);

  const hydrateFromDetail = (data: MailTemplateDetailView, triggerPreview = true) => {
    const src = pickInitialEditorSource(data);
    setName(data.name);
    setDescription(data.description);
    setDeclaredVars(data.declaredVars);
    setFormat(src.format);
    setSubject(src.subject);
    setBodyHtml(src.bodyHtml);
    setBodyText(src.bodyText);
    setDeriveTextFromHtml(src.deriveTextFromHtml);
    setChangeNote("");
    setDirty(false);

    const nextSamples: Record<string, string> = {};
    for (const v of data.declaredVars) {
      nextSamples[v.name] = v.sampleValue || `Sample ${v.label}`;
    }
    setSampleVars(nextSamples);
    hydratedVersionRef.current = `${data.templateKey}:${data.version}`;

    if (triggerPreview && src.subject.trim()) {
      previewMut.mutate({
        format: src.format,
        subject: src.subject,
        bodyHtml: src.format === "html" ? src.bodyHtml : undefined,
        bodyText: src.format === "text" || !src.deriveTextFromHtml ? src.bodyText : undefined,
        deriveTextFromHtml: src.deriveTextFromHtml,
        declaredVars: data.declaredVars,
        sampleVars: nextSamples,
      });
    }
  };

  useEffect(() => {
    const data = detailQuery.data;
    if (!data) return;
    const token = `${data.templateKey}:${data.version}`;
    if (hydratedVersionRef.current !== token) {
      hydrateFromDetail(data, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQuery.data]);

  const editorVariables = useMemo(
    () =>
      declaredVars.map((v) => ({
        name: v.name,
        label: v.label,
        required: Boolean(v.required || v.sensitive),
      })),
    [declaredVars],
  );

  const missingRequired = useMemo(
    () =>
      findMissingRequiredVariables({
        declaredVars,
        format,
        subject,
        bodyHtml,
        bodyText,
        deriveTextFromHtml,
      }),
    [declaredVars, format, subject, bodyHtml, bodyText, deriveTextFromHtml],
  );

  const invalidateAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.mailTemplates.get.queryKey({ templateKey }) }),
      qc.invalidateQueries({ queryKey: trpc.mailTemplates.list.queryKey() }),
    ]);
  };

  const handleRefreshPreview = () => {
    if (!subject.trim()) {
      toast.show({ title: "Enter a subject line to preview", tone: "warning" });
      return;
    }
    previewMut.mutate({
      format,
      subject,
      bodyHtml: format === "html" ? bodyHtml : undefined,
      bodyText: format === "text" || !deriveTextFromHtml ? bodyText : undefined,
      deriveTextFromHtml,
      declaredVars,
      sampleVars,
    });
  };

  const handleSaveDraft = async () => {
    const data = detailQuery.data;
    if (!data) return;
    try {
      const updated = await stepUp.run(
        () =>
          saveDraftMut.mutateAsync({
            templateKey: data.templateKey,
            expectedVersion: data.version,
            name: data.kind === "custom" ? name.trim() : undefined,
            description: data.kind === "custom" ? description.trim() : undefined,
            declaredVars: data.kind === "custom" ? declaredVars : undefined,
            format,
            subject,
            bodyHtml: format === "html" ? bodyHtml : undefined,
            bodyText: format === "text" || !deriveTextFromHtml ? bodyText : undefined,
            deriveTextFromHtml,
            changeNote: changeNote.trim() || undefined,
          }),
        { reason: "Saving an e-mail template draft requires a fresh confirmation." },
      );
      qc.setQueryData(trpc.mailTemplates.get.queryKey({ templateKey }), updated);
      hydrateFromDetail(updated, true);
      await invalidateAll();
      toast.show({ title: "Draft saved", tone: "success" });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ title: "Could not save draft", description: errorMessage(err), tone: "danger" });
    }
  };

  const handlePublish = async () => {
    const data = detailQuery.data;
    if (!data) return;
    if (missingRequired.length > 0) {
      toast.show({
        title: "Missing required variables",
        description: `Include ${missingRequired.map((m) => `{{${m}}}`).join(", ")} before publishing.`,
        tone: "danger",
      });
      return;
    }

    try {
      const published = await stepUp.run(
        async () => {
          let expectedVersion = data.version;
          if (dirty || !data.workingDraft) {
            const saved = await saveDraftMut.mutateAsync({
              templateKey: data.templateKey,
              expectedVersion,
              name: data.kind === "custom" ? name.trim() : undefined,
              description: data.kind === "custom" ? description.trim() : undefined,
              declaredVars: data.kind === "custom" ? declaredVars : undefined,
              format,
              subject,
              bodyHtml: format === "html" ? bodyHtml : undefined,
              bodyText: format === "text" || !deriveTextFromHtml ? bodyText : undefined,
              deriveTextFromHtml,
              changeNote: changeNote.trim() || undefined,
            });
            expectedVersion = saved.version;
          }
          return publishMut.mutateAsync({
            templateKey: data.templateKey,
            expectedVersion,
            changeNote: changeNote.trim() || undefined,
          });
        },
        { reason: "Publishing an e-mail template affects live messages and requires a fresh confirmation." },
      );
      qc.setQueryData(trpc.mailTemplates.get.queryKey({ templateKey }), published);
      hydrateFromDetail(published, true);
      await invalidateAll();
      toast.show({
        title: "Template published",
        description: `Version ${published.activePublished?.versionNumber ?? 1} is now active.`,
        tone: "success",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ title: "Could not publish template", description: errorMessage(err), tone: "danger" });
    }
  };

  const handleSendTestToMe = async () => {
    const data = detailQuery.data;
    if (!data) return;
    try {
      const res = await stepUp.run(
        () =>
          sendTestMut.mutateAsync({
            templateKey: data.templateKey,
            sampleVars,
          }),
        { reason: "Sending a test e-mail requires a fresh confirmation." },
      );
      toast.show({
        title: "Test e-mail queued to your account",
        description: `Queued from ${res.targetSource.replace(/_/g, " ")} content with [TEST] subject prefix.`,
        tone: "success",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({ title: "Could not queue test e-mail", description: errorMessage(err), tone: "danger" });
    }
  };

  const handleResetConfirm = async () => {
    const data = detailQuery.data;
    if (!data) return;
    try {
      const updated = await stepUp.run(
        () =>
          resetMut.mutateAsync({
            templateKey: data.templateKey,
            expectedVersion: data.version,
          }),
        { reason: "Resetting a system e-mail template to default requires a fresh confirmation." },
      );
      qc.setQueryData(trpc.mailTemplates.get.queryKey({ templateKey }), updated);
      hydrateFromDetail(updated, true);
      await invalidateAll();
      toast.show({
        title: "Reverted to built-in default",
        description: "Version history has been preserved.",
        tone: "success",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) throw err;
      toast.show({ title: "Could not reset template", description: errorMessage(err), tone: "danger" });
      throw err;
    }
  };

  const handleRestoreConfirm = async () => {
    const data = detailQuery.data;
    if (!data || !restoreTarget) return;
    try {
      const updated = await stepUp.run(
        () =>
          restoreMut.mutateAsync({
            templateKey: data.templateKey,
            expectedVersion: data.version,
            versionNumber: restoreTarget.versionNumber,
          }),
        { reason: "Restoring a previous template version requires a fresh confirmation." },
      );
      qc.setQueryData(trpc.mailTemplates.get.queryKey({ templateKey }), updated);
      hydrateFromDetail(updated, true);
      await invalidateAll();
      toast.show({
        title: `Version ${restoreTarget.versionNumber} copied to draft`,
        description: "Review the restored draft and publish when ready.",
        tone: "success",
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) throw err;
      toast.show({ title: "Could not restore version", description: errorMessage(err), tone: "danger" });
      throw err;
    }
  };

  const addCustomVariable = () => {
    const cleanName = newVarName.trim().replace(/[^a-zA-Z0-9_]/g, "_");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(cleanName)) {
      toast.show({
        title: "Invalid variable name",
        description: "Use letters, numbers, and underscores starting with a letter or underscore.",
        tone: "danger",
      });
      return;
    }
    if (declaredVars.some((v) => v.name === cleanName)) {
      toast.show({ title: "Variable already declared", tone: "warning" });
      return;
    }
    const label = newVarLabel.trim() || cleanName;
    const sampleValue = newVarSample.trim() || `Sample ${label}`;
    setDeclaredVars((prev) => [...prev, { name: cleanName, label, required: newVarRequired, sampleValue }]);
    setSampleVars((prev) => ({ ...prev, [cleanName]: sampleValue }));
    setNewVarName("");
    setNewVarLabel("");
    setNewVarSample("");
    setNewVarRequired(false);
    setDirty(true);
  };

  const removeCustomVariable = (varName: string) => {
    setDeclaredVars((prev) => prev.filter((v) => v.name !== varName));
    setDirty(true);
  };

  if (detailQuery.isLoading) {
    return (
      <div role="status" aria-label="Loading e-mail template" className="space-y-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton lines={5} />
      </div>
    );
  }

  if (detailQuery.error || !detailQuery.data) {
    return (
      <ErrorState
        error={detailQuery.error ?? new Error("Template not found")}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const data = detailQuery.data;
  const delivery = describeTemplateDeliveryState({
    kind: data.kind,
    hasPublishedOverride: data.hasPublishedOverride,
    publishedVersionNumber: data.activePublished?.versionNumber ?? null,
  });

  const versionColumns: readonly Column<MailTemplateVersionView>[] = [
    {
      key: "versionNumber",
      header: "Version",
      primary: true,
      cell: (v) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">v{v.versionNumber}</span>
          {data.activePublished?.publicId === v.publicId ? (
            <Badge tone="success">Active published</Badge>
          ) : (
            <Badge tone={v.state === "published" ? "neutral" : "warning"}>
              {v.state === "published" ? "Published history" : "Working draft"}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "format",
      header: "Format",
      cell: (v) => <span className="text-sm text-body">{v.format === "html" ? "HTML + text" : "Plain text"}</span>,
    },
    {
      key: "subject",
      header: "Subject",
      cell: (v) => <span className="text-sm break-words text-body">{v.subject}</span>,
    },
    {
      key: "changeNote",
      header: "Notes",
      cell: (v) => (
        <span className="text-sm text-muted">
          {v.changeNote || (v.restoredFromVersionNumber ? `Restored from v${v.restoredFromVersionNumber}` : "—")}
        </span>
      ),
    },
    {
      key: "timestamp",
      header: "Saved",
      cell: (v) => <DateTime value={v.publishedAt ?? v.createdAt} />,
    },
  ];

  const previewSubject = previewMut.data?.subject ?? subject;
  const previewText = previewMut.data?.text ?? bodyText;
  const previewHtml = format === "html" ? previewMut.data?.previewHtml : undefined;

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Console", href: "/admin" },
              { label: "E-mail templates", href: MAIL_TEMPLATES_BASE },
              { label: data.name },
            ]}
          />
        }
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">{data.templateKey}</span>
            <Badge tone={data.kind === "system" ? "neutral" : "info"}>
              {data.kind === "system" ? "System" : "Custom"}
            </Badge>
            <Badge tone={delivery.tone}>{delivery.label}</Badge>
            <span className="text-sm text-muted">{CATEGORY_LABELS[data.category] ?? data.category}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              leadingIcon={<Send className="size-4" aria-hidden="true" />}
              loading={sendTestMut.isPending}
              onClick={() => void handleSendTestToMe()}
            >
              Send test to me
            </Button>
            {data.kind === "system" && data.hasPublishedOverride ? (
              <Button
                variant="danger"
                leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
                onClick={() => setResetConfirmOpen(true)}
              >
                Reset to default
              </Button>
            ) : null}
            <Button
              variant="secondary"
              loading={saveDraftMut.isPending && !publishMut.isPending}
              onClick={() => void handleSaveDraft()}
            >
              Save draft
            </Button>
            <Button loading={publishMut.isPending} onClick={() => void handlePublish()}>
              Publish
            </Button>
          </div>
        }
      />

      <div className="space-y-8">
        {missingRequired.length > 0 ? (
          <Callout tone="warning" title="Required template variables are missing">
            Publishing requires{" "}
            <strong className="font-mono">{missingRequired.map((m) => `{{${m}}}`).join(", ")}</strong> in both the
            HTML body (or subject) and the plain-text alternative so recipients always receive critical links and
            details.
          </Callout>
        ) : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          <div className="min-w-0 space-y-6 xl:col-span-7">
            <Card className="space-y-5 p-5">
              <h2 className="text-lg font-semibold text-ink">Message content</h2>

              {data.kind === "custom" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Display name" required>
                    <Input
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </Field>
                  <Field label="Description">
                    <Input
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </Field>
                </div>
              ) : data.description ? (
                <p className="text-sm text-body">{data.description}</p>
              ) : null}

              <RadioGroup
                legend="Message format"
                value={format}
                onValueChange={(val) => {
                  setFormat(val as MailTemplateFormat);
                  setDirty(true);
                }}
                options={FORMAT_OPTIONS}
              />

              <Field
                label="Subject line"
                hint="Logic-less {{variable}} tokens are substituted and escaped on send."
                required
              >
                <Input
                  value={subject}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>

              {format === "html" ? (
                <div className="space-y-4">
                  <RichTextEditor
                    label="HTML message body"
                    hint="Allowed structure: headings, paragraphs, bold, italic, lists, https/mailto/variable links, buttons, and https images."
                    value={bodyHtml}
                    onChange={(nextHtml) => {
                      setBodyHtml(nextHtml);
                      setDirty(true);
                    }}
                    variables={editorVariables}
                    required
                  />

                  <Switch
                    label="Automatically derive plain-text alternative from HTML"
                    description="Keeps the mandatory plain-text alternative synchronised with your HTML body."
                    checked={deriveTextFromHtml}
                    onCheckedChange={(checked) => {
                      setDeriveTextFromHtml(checked);
                      setDirty(true);
                    }}
                  />

                  {!deriveTextFromHtml ? (
                    <Field
                      label="Plain-text alternative"
                      hint="Sent alongside HTML for text-only mail clients and accessibility."
                      required
                    >
                      <Textarea
                        rows={6}
                        value={bodyText}
                        onChange={(e) => {
                          setBodyText(e.target.value);
                          setDirty(true);
                        }}
                      />
                    </Field>
                  ) : null}
                </div>
              ) : (
                <Field label="Plain-text message body" required>
                  <Textarea
                    rows={8}
                    value={bodyText}
                    onChange={(e) => {
                      setBodyText(e.target.value);
                      setDirty(true);
                    }}
                  />
                </Field>
              )}

              <Field
                label="Change note"
                hint="Optional summary recorded in version history when saving or publishing."
              >
                <Input
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  placeholder="Clarified action button wording"
                />
              </Field>
            </Card>

            <Card className="space-y-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Template variables</h2>
                  <p className="text-sm text-muted">
                    Variables use logic-less <span className="font-mono">{"{{variable_name}}"}</span> placeholders.
                  </p>
                </div>
              </div>

              {declaredVars.length === 0 ? (
                <p className="text-sm text-muted">No variables declared for this template.</p>
              ) : (
                <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
                  {declaredVars.map((v) => (
                    <li key={v.name} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-ink">{`{{${v.name}}}`}</span>
                          <span className="text-sm text-body">{v.label}</span>
                          {v.required || v.sensitive ? <Badge tone="info">Required</Badge> : null}
                          {v.sensitive ? <Badge tone="warning" className="max-[320px]:rounded-lg max-[320px]:whitespace-normal max-[320px]:[&>span]:overflow-visible max-[320px]:[&>span]:whitespace-normal">Redacted in audit copies</Badge> : null}
                        </div>
                      </div>
                      {data.kind === "custom" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                          onClick={() => removeCustomVariable(v.name)}
                        >
                          Remove {v.name}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {data.kind === "custom" ? (
                <div className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface-sunken p-4">
                  <h3 className="text-sm font-semibold text-ink">Add custom variable</h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Variable key">
                      <Input
                        value={newVarName}
                        onChange={(e) => setNewVarName(e.target.value)}
                        placeholder="customer_company"
                      />
                    </Field>
                    <Field label="Display label">
                      <Input
                        value={newVarLabel}
                        onChange={(e) => setNewVarLabel(e.target.value)}
                        placeholder="Customer company"
                      />
                    </Field>
                    <Field label="Sample value">
                      <Input
                        value={newVarSample}
                        onChange={(e) => setNewVarSample(e.target.value)}
                        placeholder="Acme Corp"
                      />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Checkbox
                      label="Require this variable before publishing"
                      checked={newVarRequired}
                      onCheckedChange={setNewVarRequired}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                      onClick={addCustomVariable}
                    >
                      Add variable
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>

          <div className="min-w-0 space-y-6 xl:col-span-5">
            <Card className="space-y-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Preview with sample data</h2>
                  <p className="text-sm text-muted">
                    Rendered in an isolated sandboxed frame with no scripts, images, or outbound links.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Eye className="size-4" aria-hidden="true" />}
                  loading={previewMut.isPending}
                  onClick={handleRefreshPreview}
                >
                  Refresh preview
                </Button>
              </div>

              {declaredVars.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {declaredVars.map((v) => (
                    <Field key={v.name} label={`Sample: ${v.label}`}>
                      <Input
                        value={sampleVars[v.name] ?? ""}
                        onChange={(e) =>
                          setSampleVars((prev) => ({
                            ...prev,
                            [v.name]: e.target.value,
                          }))
                        }
                      />
                    </Field>
                  ))}
                </div>
              ) : null}

              <div className="rounded-[var(--radius-card)] border border-line bg-surface-sunken px-3 py-2 text-sm">
                <span className="font-semibold text-ink">Subject: </span>
                <span className="break-words text-body">{previewSubject || "—"}</span>
              </div>

              <InertMailPreview
                title={`Preview of ${data.name}`}
                html={previewHtml}
                text={previewText || "No plain-text preview yet."}
                height="md"
              />
            </Card>
          </div>
        </div>

        <Section
          title="Version history"
          description="Every published revision is preserved. Restoring a version copies its content into your working draft."
        >
          <DataTable
            caption={`Version history for ${data.name}`}
            columns={versionColumns}
            rows={data.versions}
            rowKey={(v) => v.publicId}
            rowActions={(v) =>
              v.state === "published" ? (
                <Button size="sm" variant="secondary" onClick={() => setRestoreTarget(v)}>
                  Restore to draft
                </Button>
              ) : null
            }
            empty={
              <EmptyState
                headingLevel={3}
                title="Using built-in system default"
                description="Save a draft or publish an override to start recording custom template versions."
              />
            }
          />
        </Section>
      </div>

      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset system template to built-in default?"
        description="Outbound messages will immediately revert to the built-in ReadyPackets template. Previous custom versions remain in version history."
        confirmLabel="Reset to default"
        destructive
        onConfirm={handleResetConfirm}
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title={restoreTarget ? `Restore version ${restoreTarget.versionNumber} into working draft?` : "Restore version"}
        description="Your working draft will be replaced with the selected historical version so you can review and publish it."
        confirmLabel="Restore to draft"
        onConfirm={handleRestoreConfirm}
      />
    </>
  );
}
