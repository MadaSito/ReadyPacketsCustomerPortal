/**
 * Customer order wizard (/orders/new): choose items → details → review. Owner: orders_engineer.
 * Packet catalogs (increment 02) use the packet picker from ./customer/packets; any other groups keep the
 * quantity list. Every amount shown comes from the server quote (`orders.quote`); the client never prices.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useFeatureEnabled } from "@/lib/features";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, EmptyState, ErrorState, Field, Input, KeyValueList, Money, PageHeader, Skeleton, Textarea, useToast } from "@/ui";
import { isPacketCatalog, nonPacketGroups, PacketPicker, packetItems, PacketSummary, useOrderQuote } from "../customer/packets";
import { money, newIdempotencyKey } from "../shared";

const REASON_MESSAGES: Record<string, string> = {
  PRODUCT_UNAVAILABLE: "An item is no longer available. Go back and review your choices.",
  PACKET_TIER_CONFLICT: "Choose one tier per packet.",
  PACKET_QUANTITY_ONE: "Each packet can be ordered once.",
  MIXED_CURRENCY: "Items priced in different currencies must be ordered separately.",
};

const STEPS = ["Choose items", "Details", "Review"] as const;
const MAX_QUANTITY = 1000;

export default function NewOrderPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const catalog = useQuery(trpc.orders.catalog.list.queryOptions());
  const create = useMutation(trpc.orders.create.mutationOptions());
  // Increment 04: with the cart feature on, the wizard fills the cart and checkout creates the order.
  const cartEnabled = useFeatureEnabled("cart");
  const addToCart = useMutation(trpc.cart.addItems.mutationOptions());
  const [step, setStep] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Record<number, string | null>>({});
  const [projectName, setProjectName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Server-side race: a required policy was published (or not yet accepted) after this page loaded.
  const [policyBlocked, setPolicyBlocked] = useState(false);
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

  const groups = useMemo(() => catalog.data ?? [], [catalog.data]);
  const packetCatalog = isPacketCatalog(groups);
  const listGroups = useMemo(() => (packetCatalog ? nonPacketGroups(groups) : groups), [groups, packetCatalog]);
  const products = useMemo(() => groups.flatMap((group) => group.products.map((product) => ({ ...product, groupName: group.name }))), [groups]);
  const listProducts = useMemo(() => listGroups.flatMap((group) => group.products), [listGroups]);
  const chosenList = listProducts
    .map((product) => ({ product, quantity: Number(quantities[product.publicId] ?? "0") }))
    .filter((line) => Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= MAX_QUANTITY);
  const packetLines = packetCatalog ? packetItems(selection, groups) : [];
  const items = [...packetLines, ...chosenList.map((line) => ({ productPublicId: line.product.publicId, quantity: line.quantity }))];
  const chosen = items.flatMap((item) => {
    const product = products.find((candidate) => candidate.publicId === item.productPublicId);
    return product ? [{ product, quantity: item.quantity }] : [];
  });
  const mixedCurrency = new Set(chosen.map((line) => line.product.currency)).size > 1;
  const quote = useOrderQuote(mixedCurrency ? [] : items);
  const quoteReason = quote.error ? safeError(quote.error)?.reasonCode : undefined;
  const quoteProblem = quote.error ? (quoteReason && REASON_MESSAGES[quoteReason]) || "The total could not be calculated. Please try again." : null;

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
      if (chosen.length === 0) return setError(packetCatalog ? "Choose at least one packet or item to continue." : "Choose at least one item to continue.");
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
    setPolicyBlocked(false);
    try {
      if (cartEnabled) {
        await addToCart.mutateAsync({ items, projectName: projectName.trim(), note: note.trim() ? note.trim() : undefined });
        await queryClient.invalidateQueries({ queryKey: trpc.cart.pathKey() });
        toast.show({ tone: "success", title: "Added to your cart", description: "Review and check out when you are ready." });
        navigate("/cart");
        return;
      }
      const result = await create.mutateAsync({
        projectName: projectName.trim(),
        items,
        note: note.trim() ? note.trim() : undefined,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: trpc.orders.list.pathKey() });
      toast.show({ tone: "success", title: "Order submitted", description: `Reference ${result.reference}` });
      navigate(`/orders/${result.publicId}`);
    } catch (err) {
      const safe = safeError(err);
      if (safe?.reasonCode === "POLICY_ACCEPTANCE_REQUIRED") {
        setPolicyBlocked(true);
        // Refresh the customer policy status so the policy gate and /policies show what is pending.
        await queryClient.invalidateQueries({ queryKey: trpc.compliance.policies.myStatus.queryKey() });
        return;
      }
      setError((safe?.reasonCode && REASON_MESSAGES[safe.reasonCode]) || errorMessage(err));
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
      {policyBlocked ? (
        <Callout tone="warning" live="assertive" title="Please review our policies first" className="mb-4">
          <p>
            A policy you need to accept has been published or updated. Your order has not been placed yet.{" "}
            <Link href="/policies" className="font-medium text-action underline underline-offset-2">
              Review and accept policies
            </Link>
            , then come back and submit again. Your choices on this page are kept.
          </p>
        </Callout>
      ) : null}
      {error ? (
        <div ref={errorRef} tabIndex={-1} className="mb-4 outline-none">
          <Callout tone="danger" live="assertive" title="Please check your order">
            {error}
          </Callout>
        </div>
      ) : null}
      <form onSubmit={step === STEPS.length - 1 ? (e) => (e.preventDefault(), void submit()) : next} noValidate className={`flex flex-col gap-5 ${packetCatalog && step === 0 ? "max-w-6xl" : "max-w-3xl"}`}>
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          {STEPS[step]}
        </h2>
        {step === 0 ? (
          <div className="flex flex-col gap-4">
            {packetCatalog ? (
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <PacketPicker groups={groups} selection={selection} onChange={setSelection} headingLevel={3} />
                <PacketSummary groups={groups} selection={selection} quote={quote.quote} pending={quote.pending} error={quote.error} headingLevel={3} />
              </div>
            ) : null}
            {listGroups.map((group) => (
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
            {packetCatalog && listGroups.length === 0 ? null : (
              <p className="text-body" aria-live="polite">
                {chosen.length === 0 ? (
                  "No items chosen yet."
                ) : quoteProblem ? (
                  quoteProblem
                ) : quote.quote && !quote.pending ? (
                  <>
                    Estimated total: <Money value={money(quote.quote.totalMinor, quote.quote.currency)} />
                    {quote.quote.discountMinor > 0 ? <> (includes {quote.quote.discountLabel ?? "discount"})</> : null}
                  </>
                ) : (
                  "Calculating total…"
                )}
              </p>
            )}
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
                ...(quote.quote && !quote.pending && !quoteProblem
                  ? [
                      ...(quote.quote.discountMinor > 0
                        ? [
                            { label: "Subtotal", value: <Money value={money(quote.quote.subtotalMinor, quote.quote.currency)} /> },
                            {
                              label: quote.quote.discountLabel ?? "Discount",
                              value: (
                                <>
                                  −<Money value={money(quote.quote.discountMinor, quote.quote.currency)} />
                                </>
                              ),
                            },
                          ]
                        : []),
                      { label: "Total", value: <Money value={money(quote.quote.totalMinor, quote.quote.currency)} /> },
                    ]
                  : [{ label: "Total", value: quoteProblem ?? "Calculating…" }]),
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
          <Button type="submit" loading={create.isPending || addToCart.isPending}>
            {step === STEPS.length - 1 ? (cartEnabled ? "Add to cart" : "Submit order") : "Continue"}
          </Button>
        </div>
      </form>
    </>
  );
}
