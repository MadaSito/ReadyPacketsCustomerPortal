import {
  Component,
  lazy,
  Suspense,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import type { TicketCategory } from "@server/modules/engagement/types";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from "@/ui";
import { makeIdempotencyKey, TICKET_CATEGORY_OPTIONS } from "../helpers";

interface RelatedSlotProps {
  query: string;
  category?: string;
}

const relatedSlotModules = import.meta.glob<{ default: ComponentType<RelatedSlotProps> }>(
  "../../knowledge/RelatedArticlesSlot.tsx",
);
const RelatedSlotEntry = Object.values(relatedSlotModules)[0];
const LazyRelatedArticlesSlot = RelatedSlotEntry ? lazy(RelatedSlotEntry) : null;

class OptionalSlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function NewSupportTicketPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const toast = useToast();

  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<TicketCategory>("general");
  const [relatedOrderId, setRelatedOrderId] = useState("");
  const [body, setBody] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [idemKey] = useState(() => makeIdempotencyKey("tkt"));
  const errorRef = useRef<HTMLDivElement | null>(null);

  const createMutation = useMutation(trpc.engagement.tickets.create.mutationOptions());

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normSubject = subject.normalize("NFC").trim();
    const normBody = body.normalize("NFC").trim();
    const normOrderId = relatedOrderId.trim();

    const nextErrors: Record<string, string> = {};
    if (normSubject.length < 5) {
      nextErrors.subject = "Enter a subject of at least 5 characters.";
    }
    if (normBody.length < 10) {
      nextErrors.body = "Describe your question in at least 10 characters.";
    }
    if (normOrderId && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(normOrderId)) {
      nextErrors.relatedOrderId = "Enter a valid 26-character order ID or leave blank.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setFormError("Please fix the highlighted fields.");
      setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    try {
      const detail = await createMutation.mutateAsync({
        subject: normSubject,
        category,
        body: normBody,
        relatedOrderId: normOrderId || undefined,
        idempotencyKey: idemKey,
      });
      void queryClient.invalidateQueries({ queryKey: trpc.engagement.tickets.pathKey() });
      toast.show({
        tone: "success",
        title: `Ticket ${detail.ticket.ticketNumber} created`,
      });
      navigate(`/support/${detail.ticket.publicId}`);
    } catch (err) {
      const safe = safeError(err);
      const mapped: Record<string, string> = {};
      if (safe?.fieldErrors) {
        for (const [k, vals] of Object.entries(safe.fieldErrors)) {
          if (vals[0]) mapped[k] = vals[0];
        }
      }
      setFieldErrors(mapped);
      setFormError(errorMessage(err));
      setTimeout(() => errorRef.current?.focus(), 0);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Support tickets", href: "/support" },
              { label: "New ticket" },
            ]}
          />
        }
        title="New support ticket"
        description="Tell us how we can help. Plain-text details are encrypted at rest and never emailed in plaintext."
      />

      <Card className="max-w-2xl">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          {formError ? (
            <div ref={errorRef} tabIndex={-1} className="outline-none">
              <Callout tone="danger" live="assertive" title="Could not create support ticket">
                {formError}
              </Callout>
            </div>
          ) : null}

          <Field
            label="Subject"
            required
            error={fieldErrors.subject}
            hint="Brief summary of your request (5–190 characters)."
          >
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={190}
              placeholder="e.g. Question about exhibit formatting"
            />
          </Field>

          {LazyRelatedArticlesSlot ? (
            <OptionalSlotBoundary>
              <Suspense fallback={null}>
                <LazyRelatedArticlesSlot query={subject} category={category} />
              </Suspense>
            </OptionalSlotBoundary>
          ) : null}

          <Field label="Category" required error={fieldErrors.category}>
            <Select
              value={category}
              onChange={(event) => setCategory(event.target.value as TicketCategory)}
              options={TICKET_CATEGORY_OPTIONS}
            />
          </Field>

          <Field
            label="Related order ID (optional)"
            error={fieldErrors.relatedOrderId}
            hint="Paste a 26-character order ID from an order you have access to, or leave blank."
          >
            <Input
              value={relatedOrderId}
              onChange={(event) => setRelatedOrderId(event.target.value)}
              maxLength={26}
              spellCheck={false}
              placeholder="Optional order ID"
            />
          </Field>

          <Field
            label="Details"
            required
            error={fieldErrors.body}
            hint="Plain text only (10–8,000 characters). Never include passwords or payment card numbers."
            labelAside={<span className="text-xs text-muted">{body.length} / 8000</span>}
          >
            <Textarea
              rows={6}
              maxLength={8000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Include relevant dates, document names, or steps we can check…"
            />
          </Field>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" asChild>
              <Link href="/support">Cancel</Link>
            </Button>
            <Button type="submit" loading={createMutation.isPending}>
              Submit ticket
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
