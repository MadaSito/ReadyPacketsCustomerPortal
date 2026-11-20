import { useState, type FormEvent } from "react";
import { Bell, Search } from "lucide-react";
import { useLocation } from "wouter";
import { Field, IconButton, Input } from "@/ui";

export interface NotificationBellPopoverProps {
  area: "customer" | "console";
}

export interface GlobalSearchBoxProps {
  className?: string;
}

/**
 * Shell header notification bell (44 px IconButton).
 * Wired to `trpc.engagement.notifications.*` once engagementRouter procedures are mounted.
 */
export function NotificationBellPopover({ area: _area }: NotificationBellPopoverProps) {
  const [, navigate] = useLocation();
  return (
    <IconButton
      label="Notifications"
      icon={<Bell className="h-5 w-5" aria-hidden="true" />}
      variant="ghost"
      onClick={() => navigate("/notifications")}
    />
  );
}

/**
 * Console/shell bounded global search input.
 */
export function GlobalSearchBox({ className }: GlobalSearchBoxProps) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.normalize("NFC").trim();
    if (trimmed.length >= 2) {
      navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    }
  };

  return (
    <form role="search" onSubmit={onSubmit} className={className ?? "flex items-center gap-2"}>
      <Field label="Global search" hideLabel>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search orders, tickets, messages…"
          maxLength={64}
        />
      </Field>
      <IconButton
        type="submit"
        label="Run search"
        icon={<Search className="h-4 w-4" aria-hidden="true" />}
        variant="ghost"
      />
    </form>
  );
}
