import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, useTRPCClient } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, Card, Field, Input, KeyValueList, PageHeader, RadioGroup, StepUpCancelledError,
  Textarea, useStepUp,
} from "@/ui";

const steps = ["Choose scope", "Review and encrypt"] as const;
type Scope = "all" | "customers" | "orders";
const scopeLabels: Record<Scope, string> = { all: "All available business records", customers: "Selected customers", orders: "Selected orders" };

export default function NewExport() {
  const client = useTRPCClient();
  const stepUp = useStepUp();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<Scope>("all");
  const [roots, setRoots] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const pass = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);
  const ids = roots.trim().split(/[\s,]+/).filter(Boolean);
  useEffect(() => { heading.current?.focus(); }, [step]);

  function select(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (scope !== "all" && (ids.length < 1 || ids.length > 100 ||
      ids.some((id) => !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) || new Set(ids).size !== ids.length)) {
      setError("Enter 1 to 100 different public IDs. Separate IDs with a comma or a new line.");
      return;
    }
    setStep(1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (busy) return;
    const passphrase = pass.current?.value ?? "";
    if (passphrase.length < 16 || passphrase.length > 512 || passphrase !== confirm.current?.value) {
      setError("Enter matching passphrases of 16 to 512 characters.");
      pass.current?.focus();
      return;
    }
    if (pass.current) pass.current.value = "";
    if (confirm.current) confirm.current.value = "";
    setBusy(true);
    try {
      const selection = scope === "all" ? { kind: "all" as const }
        : scope === "customers" ? { kind: "customers" as const, ids } : { kind: "orders" as const, ids };
      // No query/mutation cache receives the passphrase.
      await stepUp.run(() => client.portable.admin.startExport.mutate({ selection, passphrase }),
        { reason: "Verify your identity before exporting business data." });
      navigate("/admin/portable");
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) {
        setError(errorMessage(failure, "The export receipt is unavailable. Check export history before starting again."));
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="New portable export" description="Choose which records to include, then protect the package with a transfer passphrase."
        breadcrumbs={<Breadcrumbs items={[{ label: "Portable transfer", href: "/admin/portable" }, { label: "New export" }]} />} />
      <ol aria-label="Export progress" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}
          className={step === index ? "font-semibold text-ink" : "text-muted"}>Step {index + 1} of {steps.length}: {label}</li>)}
      </ol>
      <Card>
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-ink">{steps[step]}</h2>
        {error ? <Callout tone="danger" live="assertive" title="Check your export details">{error}</Callout> : null}
        {step === 0 ? <form onSubmit={select} className="max-w-2xl space-y-5">
          <RadioGroup legend="Export scope" variant="cards" value={scope} onValueChange={(value) => setScope(value as Scope)}
            options={[
              { value: "all", label: scopeLabels.all, description: "Include all eligible customer profiles, orders and current files." },
              { value: "customers", label: scopeLabels.customers, description: "Include the chosen profiles and their eligible orders and files." },
              { value: "orders", label: scopeLabels.orders, description: "Include the chosen orders, owning customer profiles and current files." },
            ]} />
          {scope !== "all" ? <Field label={scope === "customers" ? "Customer public IDs" : "Order public IDs"} required
            hint="Find a public ID on the individual customer or order record. Enter up to 100 IDs.">
            <Textarea value={roots} onChange={(event) => setRoots(event.target.value)} maxLength={3_000} rows={4} />
          </Field> : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary"><Link href="/admin/portable">Cancel</Link></Button>
            <Button type="submit">Continue</Button>
          </div>
        </form> : <form onSubmit={submit} className="max-w-2xl space-y-5">
          <KeyValueList items={[
            { label: "Scope", value: scopeLabels[scope] },
            { label: "Selected records", value: scope === "all" ? "Complete eligible dataset" : ids.length },
            { label: "Download expiry", value: "24 hours after the request starts" },
          ]} />
          <Callout tone="warning" title="Keep the passphrase separately">
            ReadyPackets cannot recover this passphrase. Keep this page open until encryption finishes and the export appears in history.
          </Callout>
          <Field label="Transfer passphrase" hint="Use a high-entropy passphrase of 16 to 512 characters." required>
            <Input ref={pass} type="password" autoComplete="off" maxLength={512} disabled={busy} />
          </Field>
          <Field label="Confirm transfer passphrase" required>
            <Input ref={confirm} type="password" autoComplete="off" maxLength={512} disabled={busy} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => { setStep(0); setError(undefined); }}>Back</Button>
            <Button type="submit" loading={busy} disabled={busy}>Encrypt and queue export</Button>
          </div>
          {busy ? <p role="status" className="text-sm text-body">Preparing the encrypted package. This can take several minutes.</p> : null}
        </form>}
      </Card>
    </div>
  );
}
