/** Customer order wizard (/orders/new): choose items → details → review. Owner: orders_engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, EmptyState, ErrorState, Field, Input, KeyValueList, Money, PageHeader, Skeleton, Textarea, useToast } from "@/ui";
import { money, newIdempotencyKey } from "../shared";

const STEPS = ["Choose items", "Details", "Review"] as const;
const MAX_QUANTITY = 1000;

export default function NewOrderPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const catalog = useQuery(trpc.orders.catalog.list.queryOptions());
  const create = useMutation(trpc.orders.create.mutationOptions());
  const [step, setStep] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  // One key per wizard visit: a double submit or retry resolves to the same order on the server.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const products = useMemo(() => (catalog.data ?? []).flatMap((group) => group.products.map((product) => ({ ...product, groupName: group.name }))), [catalog.data]);
  const chosen = products
    .map((product) => ({ product, quantity: Number.parseInt(quantities[product.publicId] ?? "0", 10) }))
    .filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
  const currency = chosen[0]?.product.currency ?? products[0]?.currency ?? "USD";
  const total = chosen.reduce((sum, line) => sum + line.product.priceMinor * line.quantity, 0);
  const mixedCurrency = new Set(chosen.map((line) => line.product.currency)).size > 1;

  const header = (
    <PageHeader
      breadcrumbs={<Breadcrumbs items={[{ label: "Orders", href: "/orders" }, { label: "New order" }]} />}
      title="New order"
      description="Choose what you need, add a few details, then review and submit."
    />
  );
  if (catalog.isPending)
    return (
      <>
        {header}
        <Skeleton lines={5} />
      </>
    );
  if (catalog.error)
    return (
      <>
        {header}
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </>
    );
  if (products.length === 0)
    return (
      <>
        {header}
        <EmptyState
          icon={PackageOpen}
          title="Nothing is available to order yet"
          description="The catalog has not been set up. Please check back later or contact ReadyPackets."
          action={
            <Button asChild variant="secondary">
              <Link href="/orders">Back to orders</Link>
            </Button>
          }
        />
      </>
    );

  const next = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (step === 0) {
      const invalid = products.some((product) => {
        const raw = quantities[product.publicId];
        if (raw === undefined || raw === "") return false;
        const value = Number(raw);
        return !Number.isInteger(value) || value < 0 || value > MAX_QUANTITY;
      });
      if (invalid) return setError(`Quantities must be whole numbers from 0 to ${MAX_QUANTITY}.`);
      if (chosen.length === 0) return setError("Choose at least one item to continue.");
      if (mixedCurrency) return setError("Items priced in different currencies must be ordered separately.");
    }
    if (step === 1) {
      if (projectName.trim().length === 0) {
        setNameError("Enter a project name.");
        return setError("Please fix the highlighted field.");
      }
      setNameError(undefined);
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const submit = async () => {
    setError(null);
    try {
      const result = await create.mutateAsync({
        projectName: projectName.trim(),
        items: chosen.map((line) => ({ productPublicId: line.product.publicId, quantity: line.quantity })),
        note: note.trim() ? note.trim() : undefined,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.list.pathKey() });
      toast.show({ tone: "success", title: "Order submitted", description: `Reference ${result.reference}` });
      navigate(`/orders/${result.publicId}`);
    } catch (err) {
      const safe = safeError(err);
      setError(safe?.reasonCode === "PRODUCT_UNAVAILABLE" ? "An item is no longer available. Go back and review your choices." : errorMessage(err));
    }
  };

  return (
    <>
      {header}
      <ol aria-label="Progress" className="mb-6 flex flex-col gap-2 sm:flex-row sm:gap-6">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={index === step ? "font-semibold text-ink" : index < step ? "text-body" : "text-muted"}
          >
            <span className="sr-only">{index < step ? "Completed: " : index === step ? "Current: " : ""}</span>
            Step {index + 1} of {STEPS.length}: {label}
          </li>
        ))}
      </ol>
      {error ? (
        <div ref={errorRef} tabIndex={-1} className="mb-4 outline-none">
          <Callout tone="danger" live="assertive" title="Please check your order">
            {error}
          </Callout>
        </div>
      ) : null}
      <form onSubmit={step === STEPS.length - 1 ? (e) => (e.preventDefault(), void submit()) : next} noValidate className="flex max-w-3xl flex-col gap-5">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          {STEPS[step]}
        </h2>
        {step === 0 ? (
          <div className="flex flex-col gap-4">
            {(catalog.data ?? []).map((group) => (
              <Card key={group.publicId} title={group.name} description={group.description || undefined} headingLevel={3}>
                <ul className="flex flex-col divide-y divide-line">
                  {group.products.map((product) => (
                    <li key={product.publicId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-semibold break-words text-ink">{product.name}</p>
                        {product.description ? <p className="text-sm break-words text-body">{product.description}</p> : null}
                        {product.features.length > 0 ? (
                          <ul className="mt-1 list-inside list-disc text-sm text-muted">
                            {product.features.map((feature) => (
                              <li key={feature}>{feature}</li>
                            ))}
                          </ul>
                        ) : null}
                        <p className="mt-1 text-sm text-ink">
                          <Money value={money(product.priceMinor, product.currency)} /> each
                        </p>
                      </div>
                      <div className="w-full sm:w-32">
                        <Field label={`Quantity of ${product.name}`}>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={MAX_QUANTITY}
                            step={1}
                            value={quantities[product.publicId] ?? ""}
                            placeholder="0"
                            onChange={(event) => setQuantities((current) => ({ ...current, [product.publicId]: event.target.value }))}
                          />
                        </Field>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            <p className="text-body" aria-live="polite">
              {chosen.length === 0 ? "No items chosen yet." : <>Estimated total: <Money value={money(total, currency)} /></>}
            </p>
          </div>
        ) : null}
        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <Field label="Project name" hint="A short name you will recognise later." required error={nameError}>
              <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={160} autoComplete="off" />
            </Field>
            <Field label="Note for ReadyPackets" hint="Optional. Anything we should know before we start.">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} rows={5} />
            </Field>
          </div>
        ) : null}
        {step === 2 ? (
          <Card title="Summary" headingLevel={3}>
            <KeyValueList
              items={[
                { label: "Project", value: <span className="break-words">{projectName.trim()}</span>, wide: true },
                ...chosen.map((line) => ({
                  label: line.product.name,
                  value: (
                    <>
                      {line.quantity} × <Money value={money(line.product.priceMinor, line.product.currency)} />
                    </>
                  ),
                })),
                { label: "Total", value: <Money value={money(total, currency)} /> },
                ...(note.trim() ? [{ label: "Note", value: <span className="break-words whitespace-pre-wrap">{note.trim()}</span>, wide: true }] : []),
              ]}
            />
            <p className="mt-4 text-sm text-muted">Prices are fixed when you submit. Later catalog changes do not affect this order.</p>
          </Card>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {step === 0 ? (
            <Button variant="secondary" asChild>
              <Link href="/orders">Cancel</Link>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => (setError(null), setStep((current) => current - 1))}>
              Back
            </Button>
          )}
          <Button type="submit" loading={create.isPending}>
            {step === STEPS.length - 1 ? "Submit order" : "Continue"}
          </Button>
        </div>
      </form>
    </>
  );
}
