import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Plus, Trash2 } from "lucide-react";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPC } from "@/lib/trpc";
import {
  Button, Callout, Card, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, FileDropzone, IconButton, Input,
  PageHeader, Section, Select, Skeleton, StepUpCancelledError, Switch, Textarea, useStepUp, useToast,
} from "@/ui";
import type { PresentationImageSummary, SettingView } from "../model";
import { PlatformNav } from "../PlatformNav";
import { useGuarded } from "../useGuarded";

const KEYS = {
  slides: "platform.presentation.slides",
  slideshow: "platform.presentation.slideshow",
  support: "platform.presentation.support_text",
  announcement: "platform.presentation.announcement",
} as const;
const MAX_SLIDES = 6;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface SlideDraft {
  id: string;
  title: string;
  body: string;
  image: { source: "brand" | "upload"; id: string; alt: string } | null;
}
type Announcement = { enabled: boolean; text: string; tone: "info" | "warning" };
type Slideshow = { autoAdvance: boolean; intervalSeconds: number };

const imageKey = (image: { source: string; id: string }) => `${image.source}:${image.id}`;

/** Slide list editor (remounted by version, so it starts from the saved slides): plain text only; images are chosen from allowlisted or uploaded images. */
export function SlidesEditor({ initial, images, saving, onSave }: { initial: SlideDraft[]; images: PresentationImageSummary[]; saving: boolean; onSave: (slides: SlideDraft[]) => void }) {
  const [slides, setSlides] = useState<SlideDraft[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const imageOptions = images.map((img) => ({ value: imageKey(img), label: img.source === "brand" ? `Brand: ${img.id}` : `Upload ${img.id.slice(-6)} (${img.width}×${img.height})` }));
  const patch = (index: number, change: Partial<SlideDraft>) => setSlides((prev) => prev.map((s, i) => (i === index ? { ...s, ...change } : s)));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (slides.some((s) => !s.title.trim())) return setError("Every slide needs a title.");
    if (slides.some((s) => s.image && !s.image.alt.trim())) return setError("Describe every image in its alternative text.");
    setError(null);
    onSave(slides);
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      {error ? <Callout tone="danger" live="assertive" title="Please fix the slides">{error}</Callout> : null}
      {slides.length === 0 ? <EmptyState title="No slides" description="The sign-in page shows only the form when there are no slides." headingLevel={3} /> : null}
      <ol className="grid gap-4">
        {slides.map((slide, index) => (
          <li key={slide.id}>
            <fieldset className="grid gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <legend className="px-1 text-sm font-semibold text-ink">Slide {index + 1}</legend>
              <Field label="Title" required>
                <Input value={slide.title} onChange={(e) => patch(index, { title: e.target.value })} maxLength={80} />
              </Field>
              <Field label="Text" hint="Plain text, up to 280 characters.">
                <Textarea value={slide.body} onChange={(e) => patch(index, { body: e.target.value })} maxLength={280} rows={3} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Image">
                  <Select
                    value={slide.image ? imageKey(slide.image) : ""}
                    placeholder="No image"
                    options={imageOptions}
                    onChange={(e) => {
                      const found = images.find((img) => imageKey(img) === e.target.value);
                      patch(index, { image: found ? { source: found.source, id: found.id, alt: slide.image?.alt ?? "" } : null });
                    }}
                  />
                </Field>
                {slide.image ? (
                  <Field label="Image description" required hint="Read aloud by screen readers.">
                    <Input value={slide.image.alt} onChange={(e) => patch(index, { image: slide.image ? { ...slide.image, alt: e.target.value } : null })} maxLength={160} />
                  </Field>
                ) : null}
              </div>
              <div className="flex justify-end">
                <IconButton label={`Remove slide ${index + 1}`} icon={<Trash2 aria-hidden className="size-4" />} variant="ghost" onClick={() => setSlides((prev) => prev.filter((_, i) => i !== index))} />
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button
          variant="secondary"
          leadingIcon={<Plus aria-hidden className="size-4" />}
          disabled={slides.length >= MAX_SLIDES}
          onClick={() => setSlides((prev) => [...prev, { id: `slide-${Date.now().toString(36)}`, title: "", body: "", image: null }])}
        >
          Add slide
        </Button>
        <Button type="submit" loading={saving}>Save slides</Button>
      </div>
    </form>
  );
}

export function PresentationTextForm({ support, announcement, slideshow, saving, onSave }: {
  support: string; announcement: Announcement; slideshow: Slideshow; saving: boolean;
  onSave: (next: { support: string; announcement: Announcement; slideshow: Slideshow }) => void;
}) {
  const [text, setText] = useState(support);
  const [banner, setBanner] = useState(announcement);
  const [show, setShow] = useState(slideshow);
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (banner.enabled && !banner.text.trim()) return setError("An active announcement needs text.");
    if (show.intervalSeconds < 6 || show.intervalSeconds > 30) return setError("Choose an interval between 6 and 30 seconds.");
    setError(null);
    onSave({ support: text, announcement: banner, slideshow: show });
  }
  return (
    <form onSubmit={submit} noValidate className="grid max-w-2xl gap-5">
      {error ? <Callout tone="danger" live="assertive" title="Please fix the highlighted fields">{error}</Callout> : null}
      <Field label="Support text" hint="Shown under the sign-in form. Plain text, up to 500 characters.">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={3} />
      </Field>
      <Switch label="Show an announcement" description="A short banner above the sign-in form." checked={banner.enabled} onCheckedChange={(enabled) => setBanner((b) => ({ ...b, enabled }))} />
      {banner.enabled ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Announcement text" required>
            <Input value={banner.text} onChange={(e) => setBanner((b) => ({ ...b, text: e.target.value }))} maxLength={200} />
          </Field>
          <Field label="Tone">
            <Select value={banner.tone} onChange={(e) => setBanner((b) => ({ ...b, tone: e.target.value as Announcement["tone"] }))} options={[{ value: "info", label: "Information" }, { value: "warning", label: "Warning" }]} />
          </Field>
        </div>
      ) : null}
      <Switch label="Advance slides automatically" description="Visitors can always pause. Reduced-motion preferences turn this off." checked={show.autoAdvance} onCheckedChange={(autoAdvance) => setShow((s) => ({ ...s, autoAdvance }))} />
      {show.autoAdvance ? (
        <Field label="Seconds per slide" hint="6 to 30 seconds.">
          <Input type="number" inputMode="numeric" min={6} max={30} value={show.intervalSeconds} onChange={(e) => setShow((s) => ({ ...s, intervalSeconds: Number(e.target.value) }))} />
        </Field>
      ) : null}
      <div className="flex justify-end"><Button type="submit" loading={saving}>Save sign-in text</Button></div>
    </form>
  );
}

export default function PresentationPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const stepUp = useStepUp();
  const toast = useToast();
  const state = useQuery(trpc.platform.admin.presentation.get.queryOptions());
  const update = useMutation(trpc.platform.admin.settings.update.mutationOptions());
  const remove = useMutation(trpc.platform.admin.presentation.deleteImage.mutationOptions());
  const [deleting, setDeleting] = useState<PresentationImageSummary | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState<"slides" | "text" | null>(null);

  const settings = (state.data?.settings ?? []) as SettingView[];
  const images = (state.data?.images ?? []) as PresentationImageSummary[];
  const byKey = (key: string) => settings.find((s) => s.key === key);
  const refresh = () => client.invalidateQueries({ queryKey: trpc.platform.admin.presentation.get.queryKey() });

  async function save(key: string, value: unknown) {
    const view = byKey(key);
    if (!view) return undefined;
    return update.mutateAsync({ key, value: value as never, expectedVersion: view.version });
  }

  async function upload(files: File[]) {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    try {
      // Raw upload endpoint: get a fresh step-up first (the server re-checks it inside the write transaction).
      if (!(await stepUp.request({ reason: "Uploading a sign-in image needs verification." }))) return;
      const response = await sessionFetch(apiUrl("/api/platform/presentation/images"), { method: "POST", body: file, headers: { "Content-Type": file.type }, cache: "no-store" });
      if (!response.ok) {
        toast.show({ tone: "danger", title: "The image was not uploaded", description: response.status === 413 ? "Images must be 2 MB or smaller." : "Use a PNG, JPEG or still WebP image within the size limits." });
      } else toast.show({ tone: "success", title: "Image uploaded", description: "Location and camera details were removed." });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ tone: "danger", title: "The upload was not confirmed", description: "Reload the page to see whether it was stored." });
    } finally {
      setUploading(false);
      await refresh();
    }
  }

  return (
    <>
      <PageHeader title="Sign-in page" description="Slides, support text and announcements shown to everyone before they sign in." />
      <PlatformNav />
      {state.isPending ? (
        <div aria-busy="true"><Skeleton lines={8} /></div>
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={() => void state.refetch()} />
      ) : (
        <div className="space-y-8">
          <Section title="Text and announcement">
            <PresentationTextForm
              key={[KEYS.support, KEYS.announcement, KEYS.slideshow].map((k) => byKey(k)?.version ?? 0).join(":")}
              support={String(byKey(KEYS.support)?.value ?? "")}
              announcement={(byKey(KEYS.announcement)?.value as Announcement | undefined) ?? { enabled: false, text: "", tone: "info" }}
              slideshow={(byKey(KEYS.slideshow)?.value as Slideshow | undefined) ?? { autoAdvance: false, intervalSeconds: 8 }}
              saving={saving === "text"}
              onSave={async (next) => {
                setSaving("text");
                await guarded(async () => {
                  await save(KEYS.support, next.support);
                  await save(KEYS.announcement, next.announcement);
                  await save(KEYS.slideshow, next.slideshow);
                }, { success: "Sign-in text saved", failure: "Some sign-in text was not saved" });
                setSaving(null);
                await refresh();
              }}
            />
          </Section>
          <Section title="Slides" description={`Up to ${MAX_SLIDES} slides.`}>
            <SlidesEditor
              key={byKey(KEYS.slides)?.version ?? 0}
              initial={(byKey(KEYS.slides)?.value as SlideDraft[] | undefined) ?? []}
              images={images}
              saving={saving === "slides"}
              onSave={async (slides) => {
                setSaving("slides");
                await guarded(() => save(KEYS.slides, slides), { success: "Slides saved", failure: "The slides were not saved" });
                setSaving(null);
                await refresh();
              }}
            />
          </Section>
          <Section title="Images" description="Uploaded images have metadata removed and are served with strict security headers.">
            <Card>
              <FileDropzone onFiles={(files) => void upload(files)} accept="image/png,image/jpeg,image/webp" maxSize={MAX_IMAGE_BYTES} disabled={uploading} label="Upload an image" hint="PNG, JPEG or WebP, up to 2 MB." />
            </Card>
            <div className="mt-4">
              <DataTable
                caption="Available images"
                rows={images}
                rowKey={(img) => imageKey(img)}
                empty={<EmptyState icon={ImageOff} title="No images" description="Upload an image to use it on a slide." headingLevel={3} />}
                columns={[
                  { key: "preview", header: "Preview", cell: (img) => <img src={img.path} alt="" className="h-12 w-20 rounded-[var(--radius-control)] border border-line object-cover" loading="lazy" /> },
                  { key: "id", header: "Image", primary: true, cell: (img) => <span className="break-all font-mono text-sm">{img.source === "brand" ? `Brand: ${img.id}` : img.id}</span> },
                  { key: "size", header: "Size", cell: (img) => `${img.width}×${img.height}` },
                  { key: "added", header: "Added", hideOnMobile: true, cell: (img) => (img.createdAt ? <DateTime value={img.createdAt} format="date" /> : "Built in") },
                ]}
                rowActions={(img) => (img.source === "upload" ? <Button size="sm" variant="ghost" onClick={() => setDeleting(img)} aria-label={`Delete image ${img.id}`}>Delete</Button> : null)}
              />
            </div>
          </Section>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}
        destructive
        title="Delete this image?"
        description="Images used on a slide cannot be deleted. Remove them from the slides first."
        confirmLabel="Delete image"
        onConfirm={async () => {
          if (!deleting) return;
          await guarded(() => remove.mutateAsync({ id: deleting.id }), { success: "Image deleted", failure: "The image was not deleted" });
          setDeleting(null);
          await refresh();
        }}
      />
    </>
  );
}
