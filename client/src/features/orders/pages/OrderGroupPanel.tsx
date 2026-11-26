/**
 * Increment 08 (D3): order groups on the order page. Owner: orders_engineer.
 * - `OrderGroupPanel`: "Orders in this project" — every order of the project with a link (customer and console).
 *   Shown only when the project has more than one order.
 * - `AddPacketsLink`: the customer's "Add packets to this project" entry point (`/orders/new?addTo=<publicId>`).
 * URLs carry public ids only, never references.
 */
import { Link } from "wouter";
import { Button, Card, DateTime } from "@/ui";

export interface OrderGroupView {
  rootPublicId: string;
  orders: { publicId: string; reference: string; createdAt: Date | string; statusLabel: string; packetNumbers: number[]; current: boolean }[];
}

export function addPacketsHref(orderPublicId: string): string {
  return `/orders/new?addTo=${encodeURIComponent(orderPublicId)}`;
}

export function AddPacketsLink({ orderPublicId, canAddPackets }: { orderPublicId: string; canAddPackets: boolean }) {
  if (!canAddPackets) return null;
  return (
    <Button asChild variant="secondary">
      <Link href={addPacketsHref(orderPublicId)}>Add packets to this project</Link>
    </Button>
  );
}

function packetText(numbers: number[]): string {
  if (numbers.length === 0) return "No packets";
  return `${numbers.length === 1 ? "Packet" : "Packets"} ${numbers.join(", ")}`;
}

export function OrderGroupPanel({ group, area }: { group: OrderGroupView | undefined; area: "customer" | "console" }) {
  if (!group || group.orders.length < 2) return null;
  const base = area === "console" ? "/admin/orders" : "/orders";
  return (
    <div className="mb-6">
      <Card title="Orders in this project" description="Each addition is its own order with its own invoice and progress." headingLevel={2}>
        <ul className="flex flex-col divide-y divide-line" data-testid="order-group">
          {group.orders.map((member) => (
            <li key={member.publicId} className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <div className="min-w-0">
                {member.current ? (
                  <span className="font-semibold break-words text-ink" aria-current="page">
                    {member.reference} <span className="font-normal text-muted">(this order)</span>
                  </span>
                ) : (
                  <Link href={`${base}/${member.publicId}`} className="font-semibold break-words text-action underline underline-offset-2">
                    {member.reference}
                  </Link>
                )}
                <p className="text-sm break-words text-body">
                  {packetText(member.packetNumbers)}
                  {member.publicId === group.rootPublicId ? " · first order" : ""}
                </p>
              </div>
              <p className="text-sm text-muted sm:shrink-0 sm:text-right">
                {member.statusLabel} · <DateTime value={member.createdAt} format="date" />
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
