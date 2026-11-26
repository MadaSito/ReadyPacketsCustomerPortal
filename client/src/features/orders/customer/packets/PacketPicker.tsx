/**
 * Customer packet picker (new-order wizard step 1, increment 02 §C). One card per packet; a radio group per
 * packet (Not included / Basic / Standard / Premium) with price and timeline; the outcome and deliverables
 * of every tier in a disclosure. Controlled: the wizard owns `selection`. Prices shown are catalog
 * prices per tier; totals come only from the server quote (see PacketSummary).
 *
 * Increment 08 (D7): choosing a tier expands that tier's outcome and deliverables and collapses the others;
 * "Not included" collapses all. Manual toggling still works. Disclosures are buttons with `aria-expanded`;
 * focus stays on the radio and a polite status names the expanded tier.
 * Add-on orders (D3): `alreadyInProject` lists packet numbers the project already has; those cards show
 * "Already in this project" and offer no tier choice (the server refuses them with PACKET_ALREADY_IN_PROJECT).
 */
import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Card, cn, Money, RadioGroup } from "@/ui";
import { money } from "../../shared";
import { includedTier, packetGroups, type PacketGroup } from "./model";
import type { PacketSelection, PickerGroup } from "./types";

export const NOT_INCLUDED = "none";

export interface PacketPickerProps {
  groups: readonly PickerGroup[];
  selection: Record<number, string | null>;
  onChange: (selection: Record<number, string | null>) => void;
  /** Heading level of each packet card (the wizard step heading is h2). */
  headingLevel?: 3 | 4;
  /** Increment 08 (D3): packet numbers already bought in this project (add-on order); shown, not selectable. */
  alreadyInProject?: readonly number[];
}

export function PacketPicker({ groups, selection, onChange, headingLevel = 3, alreadyInProject = [] }: PacketPickerProps) {
  const packets = packetGroups(groups);
  return (
    <div className="flex flex-col gap-4">
      {packets.map((packet) => (
        <PacketCard
          key={packet.publicId}
          packet={packet}
          selection={selection}
          headingLevel={headingLevel}
          owned={alreadyInProject.includes(packet.packetNumber)}
          onSelect={(productPublicId) => onChange({ ...selection, [packet.packetNumber]: productPublicId })}
        />
      ))}
    </div>
  );
}

/**
 * Which tier disclosures are open. Starts with the selected tier open; a selection change opens only the new tier
 * (derived-state reset during render, React's documented pattern; no effect).
 */
function useTierDisclosure(selected: string) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(selected === NOT_INCLUDED ? [] : [selected]));
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    setOpen(new Set(selected === NOT_INCLUDED ? [] : [selected]));
  }
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { open, toggle };
}

function PacketCard({ packet, selection, headingLevel, owned, onSelect }: { packet: PacketGroup; selection: PacketSelection; headingLevel: 3 | 4; owned: boolean; onSelect: (id: string | null) => void }) {
  const current = selection[packet.packetNumber] ?? null;
  const value = !owned && current && packet.tiers.some((tier) => tier.publicId === current) ? current : NOT_INCLUDED;
  const { open, toggle } = useTierDisclosure(value);
  const baseId = useId();
  const selectedTier = packet.tiers.find((tier) => tier.publicId === value);
  const title = `Packet ${packet.packetNumber}: ${packet.name}`;
  return (
    <Card as="section" aria-label={title} title={title} description={packet.description || undefined} headingLevel={headingLevel} data-packet-card={packet.packetNumber}>
      {owned ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-body" data-testid={`packet-${packet.packetNumber}-owned`}>
          <Badge tone="neutral">Already in this project</Badge>
          <span>This project already has this packet, so it can't be added again.</span>
        </p>
      ) : (
        <RadioGroup
          legend={`Tier for ${packet.name}`}
          name={`packet-${packet.packetNumber}`}
          orientation="horizontal"
          variant="cards"
          className="[&_[role=radiogroup]]:grid [&_[role=radiogroup]]:grid-cols-1 [&_[role=radiogroup]]:gap-2 sm:[&_[role=radiogroup]]:grid-cols-2 xl:[&_[role=radiogroup]]:grid-cols-4"
          value={value}
          onValueChange={(next) => onSelect(next === NOT_INCLUDED ? null : next)}
          options={[
            { value: NOT_INCLUDED, label: "Not included", description: "Leave this packet out" },
            ...packet.tiers.map((tier) => ({
              value: tier.publicId,
              // Name, price and timeline each on their own line so every tile reads the same at any width.
              label: (
                <span className="flex flex-col">
                  <span>{tier.tier}</span>
                  <Money value={money(tier.priceMinor, tier.currency)} className="block" />
                </span>
              ),
              description: tier.timeline ? `Timeline: ${tier.timeline}` : undefined,
            })),
          ]}
        />
      )}
      {/* Says which details opened after a tier choice; focus stays on the radio. */}
      <p className="sr-only" aria-live="polite" data-testid={`packet-${packet.packetNumber}-disclosure-status`}>
        {owned ? "" : selectedTier ? `${selectedTier.tier}: outcome and deliverables shown below.` : ""}
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {packet.tiers.map((tier) => {
          const base = includedTier(tier.tier);
          const expanded = open.has(tier.publicId);
          const panelId = `${baseId}-${tier.publicId}`;
          return (
            <div key={tier.publicId} className="rounded-[var(--radius-control)] border border-line bg-surface-soft" data-tier-disclosure={tier.tier}>
              <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(tier.publicId)}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-sm font-medium text-ink hover:bg-surface-sunken"
                >
                  <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 motion-safe:transition-transform", expanded && "rotate-90")} />
                  <span className="min-w-0 break-words">{tier.tier}: outcome and deliverables</span>
              </button>
              <div id={panelId} hidden={!expanded} className="flex flex-col gap-3 border-t border-line px-3 py-3 text-sm text-body">
                {tier.outcome ? (
                  <p>
                    <span className="font-semibold text-ink">Outcome: </span>
                    {tier.outcome}
                  </p>
                ) : null}
                {tier.timeline ? (
                  <p>
                    <span className="font-semibold text-ink">Timeline: </span>
                    {tier.timeline}
                  </p>
                ) : null}
                {base && packet.tiers.some((t) => t.tier === base) ? <p className="font-medium text-ink">Everything in {base}, plus:</p> : null}
                {tier.deliverables.length > 0 ? (
                  <ul className="flex list-disc flex-col gap-2 pl-5">
                    {tier.deliverables.map((item) => (
                      <li key={item.title} className="break-words">
                        <span className="font-semibold text-ink">{item.title}</span>
                        {item.detail ? <span className="block">{item.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
