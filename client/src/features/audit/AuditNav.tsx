import { Link, useLocation } from "wouter";
import { cn } from "@/ui";

const ITEMS = [
  { href: "/admin/audit", label: "Events" },
  { href: "/admin/audit/saved", label: "Saved searches" },
  { href: "/admin/audit/incidents", label: "Incidents" },
  { href: "/admin/audit/cases", label: "Cases" },
  { href: "/admin/audit/exports", label: "Exports" },
  { href: "/admin/audit/integrity", label: "Integrity" },
  { href: "/admin/audit/retention", label: "Retention" },
] as const;

/** Sub-navigation shared by every audit center page. */
export function AuditNav() {
  const [location] = useLocation();
  const path = location.split("?")[0];
  return (
    <nav aria-label="Audit center" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 px-1">
        {ITEMS.map((item) => {
          const current = path === item.href || (item.href === "/admin/audit/incidents" && path.startsWith("/admin/audit/incidents/"));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium",
                  current ? "bg-surface-sunken text-ink" : "text-body hover:bg-surface-soft hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
