/** /admin/session-restrictions — concurrency limit, per-role lifetimes, console network allow-list, country rule. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Button, Callout, Card, ErrorState, Field, Input, KeyValueList, PageHeader, Select, Skeleton, StepUpCancelledError, Switch, TagInput,
  useStepUp, useToast,
} from "@/ui";
import { ROLE_LABELS } from "../shared";

type View = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["restrictions"]["get"]["query"]>>;
type Role = "customer" | "staff" | "admin";
const ROLES: Role[] = ["customer", "staff", "admin"];
type Mode = "off" | "allow" | "deny";
type Scope = "all" | "customers" | "console";

const header = (
  <PageHeader
    title="Session restrictions"
    description="Limit how many devices each person may use, how long sessions last, and where people may sign in from. Restrictions are off until you turn them on."
  />
);

const MODE_OPTIONS = [
  { value: "off", label: "No country rule" },
  { value: "allow", label: "Allow only these countries" },
  { value: "deny", label: "Block these countries" },
];
const SCOPE_OPTIONS = [
  { value: "all", label: "Everyone" },
  { value: "customers", label: "Customers only" },
  { value: "console", label: "Staff and administrators only" },
];

const ADMISSION_TEXT: Record<string, string> = {
  RESTRICTION_IP: "Your current address is not on the console allow-list. Saving these settings with restrictions on would sign you out.",
  RESTRICTION_COUNTRY: "Your current country is not allowed by the country rule.",
};

export default function SessionRestrictionsPage() {
  const trpc = useTRPC();
  const view = useQuery(trpc.identity.admin.restrictions.get.queryOptions());
  if (view.isPending) return <>{header}<div role="status"><span className="sr-only">Loading restrictions</span><Skeleton lines={6} /></div></>;
  if (view.isError) return <>{header}<ErrorState error={view.error} onRetry={() => void view.refetch()} /></>;
  return <>{header}<RestrictionsForm key={view.data.version} view={view.data} onSaved={() => void view.refetch()} /></>;
}

const numText = (value: number | null) => (value === null ? "" : String(value));

function RestrictionsForm({ view, onSaved }: { view: View; onSaved: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const update = useMutation(trpc.identity.admin.restrictions.update.mutationOptions());
  const [enabled, setEnabled] = useState(view.enabled);
  const [maxConcurrent, setMaxConcurrent] = useState(numText(view.maxConcurrentPerUser));
  const [idle, setIdle] = useState<Record<Role, string>>({ customer: numText(view.idleMinutes.customer), staff: numText(view.idleMinutes.staff), admin: numText(view.idleMinutes.admin) });
  const [absolute, setAbsolute] = useState<Record<Role, string>>({ customer: numText(view.absoluteHours.customer), staff: numText(view.absoluteHours.staff), admin: numText(view.absoluteHours.admin) });
  const [networks, setNetworks] = useState<string[]>([...view.consoleIpAllowList]);
  const [mode, setMode] = useState<Mode>(view.countryMode);
  const [scope, setScope] = useState<Scope>(view.countryScope);
  const [countries, setCountries] = useState<string[]>([...view.countries]);
  const [allowUnknown, setAllowUnknown] = useState(view.allowUnknownCountry);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const parse = (text: string, field: string, min: number, max: number, found: Record<string, string>, unit: string): number | null => {
    if (text.trim() === "") return null;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) found[field] = `Use ${min} to ${max} ${unit}, or leave empty for the default.`;
    return Number.isInteger(n) ? n : null;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    const max = parse(maxConcurrent, "maxConcurrentPerUser", 1, 50, found, "sessions");
    const idleMinutes = Object.fromEntries(ROLES.map((r) => [r, parse(idle[r], `idleMinutes.${r}`, 5, 240, found, "minutes")])) as Record<Role, number | null>;
    const absoluteHours = Object.fromEntries(ROLES.map((r) => [r, parse(absolute[r], `absoluteHours.${r}`, 1, 72, found, "hours")])) as Record<Role, number | null>;
    if (mode !== "off" && countries.length === 0) found.countries = "Choose at least one country, or turn the country rule off.";
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length) return;
    try {
      await stepUp.run(
        () => update.mutateAsync({
          expectedVersion: view.version, enabled, maxConcurrentPerUser: max, idleMinutes, absoluteHours,
          consoleIpAllowList: networks, countryMode: mode, countryScope: scope, countries, allowUnknownCountry: allowUnknown,
        }),
        { reason: "Confirm it's you to change session restrictions." },
      );
      toast.show({ tone: "success", title: "Session restrictions saved" });
      onSaved();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      const field = (safe?.details as { field?: string } | undefined)?.field;
      if (safe?.reasonCode === "RESTRICTIONS_INVALID" && field) setErrors({ [field]: safe.safeMessage });
      else if (safe?.reasonCode === "STALE_VERSION") setFormError("Someone else changed these settings. Reload the page to see their changes.");
      else setFormError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {view.breakGlassActive ? (
        <Callout tone="warning" title="Break-glass mode is on">
          The server was started with protection disabled, so network and country restrictions are not enforced. Concurrency and lifetime limits still apply.
        </Callout>
      ) : null}
      {formError ? <Callout tone="danger" live="assertive">{formError}</Callout> : null}

      <Card as="section" aria-label="Status" title="Status">
        <div className="flex flex-col gap-4">
          <Switch label="Enforce session restrictions" description="When off, only the platform's default session lifetimes apply." checked={enabled} onCheckedChange={setEnabled} />
          <KeyValueList
            columns={2}
            items={[
              { label: "Your address", value: <span className="break-all">{view.yourAddress ?? "Unknown"}</span> },
              { label: "Your country", value: view.yourCountry ?? "Unknown" },
              { label: "With these saved settings", value: view.yourAdmission ? ADMISSION_TEXT[view.yourAdmission] ?? "You would be blocked." : "You would still be allowed in.", wide: true },
              { label: "Last changed", value: view.updatedAt ? new Date(view.updatedAt).toLocaleString() : "Never" },
              { label: "Version", value: view.version },
            ]}
          />
        </div>
      </Card>

      <Card as="section" aria-label="Devices and lifetimes" title="Devices and lifetimes" description="Leave a value empty to use the platform default.">
        <div className="flex flex-col gap-6">
          <Field label="Maximum sessions per person" hint="1 to 50. When exceeded, the oldest sessions are signed out." error={errors.maxConcurrentPerUser}>
            <Input inputMode="numeric" value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} className="sm:max-w-40" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            {ROLES.map((role) => (
              <Field key={`idle-${role}`} label={`${ROLE_LABELS[role]} idle timeout (minutes)`} hint="5 to 240" error={errors[`idleMinutes.${role}`]}>
                <Input inputMode="numeric" value={idle[role]} onChange={(e) => setIdle({ ...idle, [role]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {ROLES.map((role) => (
              <Field key={`abs-${role}`} label={`${ROLE_LABELS[role]} maximum lifetime (hours)`} hint="1 to 72" error={errors[`absoluteHours.${role}`]}>
                <Input inputMode="numeric" value={absolute[role]} onChange={(e) => setAbsolute({ ...absolute, [role]: e.target.value })} />
              </Field>
            ))}
          </div>
        </div>
      </Card>

      <Card as="section" aria-label="Console networks" title="Console networks" description="Staff and administrators may only sign in from these addresses or networks. Leave empty to allow any network.">
        <TagInput
          label="Allowed addresses and networks"
          value={networks}
          onValueChange={setNetworks}
          max={100}
          maxLength={64}
          normalize={(tag) => tag.trim()}
          placeholder="For example 203.0.113.0/24"
          hint="IPv4 or IPv6 addresses or CIDR networks. Add your own network first so you are not locked out."
          error={errors.consoleIpAllowList}
        />
      </Card>

      <Card as="section" aria-label="Country rule" title="Country rule" description="Countries come from your network edge (for example a CDN header). Location is never looked up any further.">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rule">
              <Select options={MODE_OPTIONS} value={mode} onChange={(e) => setMode(e.target.value as Mode)} />
            </Field>
            <Field label="Applies to">
              <Select options={SCOPE_OPTIONS} value={scope} onChange={(e) => setScope(e.target.value as Scope)} disabled={mode === "off"} />
            </Field>
          </div>
          <TagInput
            label="Countries"
            value={countries}
            onValueChange={setCountries}
            max={250}
            maxLength={2}
            normalize={(tag) => tag.trim().toUpperCase()}
            validate={(tag) => (/^[A-Z]{2}$/.test(tag) ? null : "Use a two-letter ISO country code, for example US.")}
            placeholder="For example US"
            disabled={mode === "off"}
            error={errors.countries}
          />
          <Switch label="Allow sign-ins when the country is unknown" description="Turn off to refuse sign-ins the network edge could not place." checked={allowUnknown} onCheckedChange={setAllowUnknown} disabled={mode === "off"} />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={update.isPending}>Save restrictions</Button>
      </div>
    </form>
  );
}
