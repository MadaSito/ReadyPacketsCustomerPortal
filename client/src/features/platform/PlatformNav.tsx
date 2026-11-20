import { Link, useLocation } from "wouter";
import { cn } from "@/ui";

const ITEMS = [
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/settings/features", label: "Features" },
  { href: "/admin/settings/presentation", label: "Sign-in page" },
  { href: "/admin/settings/transfer", label: "Export and import" },
  { href: "/admin/health", label: "Health" },
] as const;

/** Sub-navigation shared by every platform console page. */
export function PlatformNav() {
  const [location] = useLocation();
  const path = location.split("?")[0];
  return (
    <nav aria-label="Platform administration" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 px-1">
        {ITEMS.map((item) => {
          const current = path === item.href;
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
