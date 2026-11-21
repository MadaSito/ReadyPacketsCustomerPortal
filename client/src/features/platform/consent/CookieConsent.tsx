/**
 * Cookie banner + preference centre (increment 04, package J). Owner: platform engineer.
 * Mounted by the UI foundation as the FIRST element of every layout (CookieConsentSlot).
 *
 * - The banner is a non-modal region in normal page flow at the very top: it is first in tab order, never
 *   traps focus and never covers the sign-in form on small screens.
 * - "Reject all" and "Accept all" are the same size and style. Nothing is pre-ticked.
 * - Global Privacy Control / Do Not Track: rejected by default without showing the banner; the person can
 *   still opt in through the preference centre.
 */
import { useQuery } from "@tanstack/react-query";
import { Cookie } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { configureConsent, onOpenPreferences, useConsent, type ConsentChoices, type OptionalCategory } from "@/lib/consent";
import { useBootstrap } from "@/lib/features";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, Dialog, Switch, useToast } from "@/ui";
import { ALL_CHOICES, NO_CHOICES, useConsentDecision, type ConsentSource } from "./useConsentDecision";

const OPTIONAL: readonly OptionalCategory[] = ["preferences", "analytics", "session_replay"];

interface InventoryItem {
  id: string;
  name: string;
  provider: string;
  category: "necessary" | OptionalCategory;
  storage: "cookie" | "local_storage" | "session_storage" | "none";
  firstParty: boolean;
  purpose: string;
  duration: string;
}
interface Inventory {
  categories: { key: "necessary" | OptionalCategory; label: string; description: string }[];
  items: InventoryItem[];
}

const STORAGE_LABEL: Record<InventoryItem["storage"], string> = {
  cookie: "Cookie",
  local_storage: "Browser storage",
  session_storage: "Tab storage",
  none: "No storage on your device",
};

export function useCookieInventory(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.platform.consent.inventory.queryOptions(), enabled, staleTime: 5 * 60_000 });
}

/** Keeps the consent store in sync with the public bootstrap. */
function useConfigureConsent(): void {
  const bootstrap = useBootstrap();
  const enabled = bootstrap?.consent.enabled === true;
  const policyVersion = bootstrap?.consent.policyVersion ?? null;
  const renewMonths = bootstrap?.consent.renewMonths ?? 12;
  useEffect(() => {
    configureConsent({ enabled, policyVersion, renewMonths });
  }, [enabled, policyVersion, renewMonths]);
}

export function CookieConsent() {
  useConfigureConsent();
  const state = useConsent();
  const { decide, pending } = useConsentDecision();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const gpcTried = useRef<number | null>(null);

  useEffect(() => onOpenPreferences(() => setOpen(true)), []);

  // GPC / DNT: record a signal-made rejection once per policy version. Nothing optional runs meanwhile.
  useEffect(() => {
    if (!state.enabled || state.decided || !state.gpc || state.policyVersion === null) return;
    if (gpcTried.current === state.policyVersion) return;
    gpcTried.current = state.policyVersion;
    void decide(NO_CHOICES, "reject_all", "gpc");
  }, [state.enabled, state.decided, state.gpc, state.policyVersion, decide]);

  async function choose(choices: ConsentChoices, action: "accept_all" | "reject_all" | "save", source: ConsentSource): Promise<boolean> {
    const result = await decide(choices, action, source);
    if (result.ok) {
      setAnnouncement("Cookie preferences saved");
      return true;
    }
    toast.show({ tone: result.policyChanged ? "warning" : "danger", title: "Cookie preferences", description: result.message });
    return false;
  }

  if (!state.enabled) return null;
  const showBanner = !state.decided && !state.gpc;

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {showBanner ? (
        <section aria-labelledby="rp-cookie-banner-title" className="border-b border-line bg-surface-raised text-body">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-6">
            <div className="flex min-w-0 flex-1 gap-3">
              <Cookie className="mt-0.5 hidden size-5 shrink-0 text-ink sm:block" aria-hidden />
              <div className="min-w-0">
                <h2 id="rp-cookie-banner-title" className="text-sm font-semibold text-ink">
                  Your cookie choices
                </h2>
                <p className="text-sm break-words">
                  We use necessary cookies to keep you signed in and secure. With your permission we would also use optional tools to remember preferences, measure use and record anonymised sessions. Nothing optional runs until you choose.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => void choose(NO_CHOICES, "reject_all", "banner")}>
                Reject all
              </Button>
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => void choose(ALL_CHOICES, "accept_all", "banner")}>
                Accept all
              </Button>
              <Button variant="ghost" size="sm" className="col-span-2" onClick={() => setOpen(true)}>
                Manage choices
              </Button>
            </div>
          </div>
        </section>
      ) : null}
      {open ? (
        <PreferencesDialog
          initial={state.decided ? state.choices : NO_CHOICES}
          pending={pending}
          onOpenChange={setOpen}
          onSubmit={async (choices, action) => {
            if (await choose(choices, action, "preferences")) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function PreferencesDialog({
  initial,
  pending,
  onOpenChange,
  onSubmit,
}: {
  initial: ConsentChoices;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (choices: ConsentChoices, action: "accept_all" | "reject_all" | "save") => void | Promise<void>;
}) {
  const [choices, setChoices] = useState<ConsentChoices>(initial);
  const inventory = useCookieInventory(true);
  const data = inventory.data as Inventory | undefined;
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="lg"
      title="Cookie preferences"
      description="Choose which optional tools may run. You can change this at any time from the footer link or your account."
      footer={
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:justify-end">
          <Button variant="secondary" disabled={pending} onClick={() => void onSubmit(NO_CHOICES, "reject_all")}>
            Reject all
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => void onSubmit(ALL_CHOICES, "accept_all")}>
            Accept all
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void onSubmit(choices, "save")}>
            Save choices
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <CategoryBlock title={labelOf(data, "necessary", "Necessary")} description={descriptionOf(data, "necessary")} items={itemsOf(data, "necessary")}>
          <p className="text-sm font-medium text-ink">Always on</p>
        </CategoryBlock>
        {OPTIONAL.map((key) => (
          <CategoryBlock key={key} title={labelOf(data, key, key)} description={descriptionOf(data, key)} items={itemsOf(data, key)}>
            <Switch label={`Allow ${labelOf(data, key, key).toLowerCase()}`} checked={choices[key]} onCheckedChange={(on) => setChoices((c) => ({ ...c, [key]: on }))} />
          </CategoryBlock>
        ))}
        <Callout tone="info">
          When you withdraw a choice we remove the cookies this site can reach. Cookies a provider set on its own domain can only be removed from your browser settings.
        </Callout>
      </div>
    </Dialog>
  );
}

function labelOf(data: Inventory | undefined, key: string, fallback: string): string {
  return data?.categories.find((c) => c.key === key)?.label ?? fallback;
}
function descriptionOf(data: Inventory | undefined, key: string): string {
  return data?.categories.find((c) => c.key === key)?.description ?? "";
}
function itemsOf(data: Inventory | undefined, key: string): InventoryItem[] {
  return data?.items.filter((i) => i.category === key) ?? [];
}

function CategoryBlock({ title, description, items, children }: { title: string; description: string; items: InventoryItem[]; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-control)] border border-line p-3" aria-label={title}>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description ? <p className="mt-1 text-sm text-body break-words">{description}</p> : null}
      <div className="mt-3">{children}</div>
      {items.length > 0 ? (
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-ink">
            {items.length === 1 ? "1 item" : `${items.length} items`} in this category
          </summary>
          <ul className="mt-2 space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-[var(--radius-control)] bg-surface-soft p-2 text-sm break-words">
                <p className="font-medium text-ink">
                  {item.name} <span className="font-normal text-body">· {item.provider}</span>
                </p>
                <p>{item.purpose}</p>
                <p className="text-body">
                  {STORAGE_LABEL[item.storage]} · {item.firstParty ? "This site" : "Third party"} · {item.duration}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export default CookieConsent;
