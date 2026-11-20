/**
 * Customer packet picker (new-order wizard step 1, increment 02 §C). One card per packet; a radio group per
 * packet (Not included / Basic / Standard / Premium) with price and timeline; the outcome and deliverables
 * of every tier in a native disclosure. Controlled: the wizard owns `selection`. Prices shown are catalog
 * prices per tier; totals come only from the server quote (see PacketSummary).
 */
import { Card, Money, RadioGroup } from "@/ui";
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
}

export function PacketPicker({ groups, selection, onChange, headingLevel = 3 }: PacketPickerProps) {
  const packets = packetGroups(groups);
  return (
    <div className="flex flex-col gap-4">
      {packets.map((packet) => (
        <PacketCard
          key={packet.publicId}
          packet={packet}
          selection={selection}
          headingLevel={headingLevel}
          onSelect={(productPublicId) => onChange({ ...selection, [packet.packetNumber]: productPublicId })}
        />
      ))}
    </div>
  );
}

function PacketCard({ packet, selection, headingLevel, onSelect }: { packet: PacketGroup; selection: PacketSelection; headingLevel: 3 | 4; onSelect: (id: string | null) => void }) {
  const current = selection[packet.packetNumber] ?? null;
  const value = current && packet.tiers.some((tier) => tier.publicId === current) ? current : NOT_INCLUDED;
  return (
    <Card as="section" aria-label={`Packet ${packet.packetNumber}: ${packet.name}`} title={`Packet ${packet.packetNumber}: ${packet.name}`} description={packet.description || undefined} headingLevel={headingLevel}>
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
            label: (
              <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span>{tier.tier}</span>
                <Money value={money(tier.priceMinor, tier.currency)} />
              </span>
            ),
            description: tier.timeline ? `Timeline: ${tier.timeline}` : undefined,
          })),
        ]}
      />
      <div className="mt-4 flex flex-col gap-2">
        {packet.tiers.map((tier) => {
          const base = includedTier(tier.tier);
          return (
            <details key={tier.publicId} className="group rounded-[var(--radius-control)] border border-line bg-surface-soft">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-ink">
                {tier.tier}: outcome and deliverables
              </summary>
              <div className="flex flex-col gap-3 border-t border-line px-3 py-3 text-sm text-body">
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
            </details>
          );
        })}
      </div>
    </Card>
  );
}
