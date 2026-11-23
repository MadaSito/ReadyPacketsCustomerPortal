/**
 * Overlays on Radix primitives: focus trap, focus restore to the trigger, Escape to close, scroll lock,
 * aria-modal + labelled title. Never use window.alert/confirm/prompt.
 */
import { Dialog as RDialog, DropdownMenu as RMenu, Tooltip as RTooltip } from "radix-ui";
import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

/**
 * Controlled overlays have no Radix Trigger to return focus to, so remember the element that was focused
 * when the overlay opened and restore it on close (WCAG 2.4.3).
 */
function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function useReturnFocus(open: boolean | undefined, returnFocusRef?: RefObject<HTMLElement | null>) {
  const previous = useRef<HTMLElement | null>(null);
  const openedAt = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      previous.current = document.activeElement;
      openedAt.current = currentUrl();
    }
  }, [open]);
  return (event: Event) => {
    const target = previous.current;
    const navigated = openedAt.current !== null && openedAt.current !== currentUrl();
    previous.current = null;
    openedAt.current = null;
    const explicitTarget = returnFocusRef?.current;
    if (explicitTarget?.isConnected) {
      event.preventDefault();
      explicitTarget.focus();
      return;
    }
    // Closed because the user navigated (e.g. a link in a nav drawer): route focus management owns focus now.
    if (navigated) {
      event.preventDefault();
      return;
    }
    if (target && target.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };
}

const overlayClass = "fixed inset-0 z-50 bg-navy/60 backdrop-blur-[2px] motion-safe:animate-fade-in";

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog (rendered asChild). Omit for controlled dialogs. */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons (right-aligned, stacked on mobile). */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Block closing by Escape/outside click (e.g. while a mutation runs). */
  dismissible?: boolean;
  /** Element to focus first instead of the first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** For a triggerless dialog, focus this connected element on close before trying the opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const dialogSizes = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" } as const;

export function Dialog({ open, onOpenChange, trigger, title, description, children, footer, size = "md", dismissible = true, initialFocusRef, returnFocusRef }: DialogProps) {
  const onCloseAutoFocus = useReturnFocus(trigger ? false : open, returnFocusRef);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RDialog.Trigger asChild>{trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={overlayClass} />
        <RDialog.Content
          onCloseAutoFocus={trigger ? undefined : onCloseAutoFocus}
          onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
          onInteractOutside={(e) => !dismissible && e.preventDefault()}
          onOpenAutoFocus={(e) => {
            if (initialFocusRef?.current) {
              e.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface text-body shadow-[var(--shadow-raised)] outline-none motion-safe:animate-fade-in rp-forced-border",
            "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[85dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
            dialogSizes[size],
          )}
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
            <div className="min-w-0">
          <RDialog.Title className="text-lg font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-body">{description}</RDialog.Description> : <RDialog.Description className="sr-only">Dialog</RDialog.Description>}
            </div>
            {dismissible ? (
              <RDialog.Close asChild>
                <button type="button" aria-label="Close dialog" className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-surface-sunken hover:text-ink">
                  <X aria-hidden="true" className="size-5" />
                </button>
              </RDialog.Close>
            ) : null}
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div> : null}
          {footer ? <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Closes the nearest Dialog/Drawer; wrap a Button: <DialogClose><Button>Cancel</Button></DialogClose>. */
export function DialogClose({ children }: { children: ReactNode }) {
  return <RDialog.Close asChild>{children}</RDialog.Close>;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra body (e.g. consequences list). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger button and focus Cancel first. */
  destructive?: boolean;
  /** May be async; dialog shows loading and stays open until it resolves. Throw to keep it open. */
  onConfirm: () => void | Promise<void>;
  /** Require typing this exact text before confirm is enabled (high-impact actions). */
  confirmText?: string;
}

/** Accessible replacement for window.confirm. */
export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, confirmText }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const blocked = confirmText !== undefined && typed !== confirmText;
  const onCloseAutoFocus = useReturnFocus(open);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setTyped("");
      onOpenChange(false);
    } catch {
      /* caller shows the error (toast/ErrorState); keep dialog open */
    } finally {
      setBusy(false);
    }
  };
  return (
    <RDialog.Root open={open} onOpenChange={(next) => !busy && (setTyped(""), onOpenChange(next))}>
      <RDialog.Portal>
        <RDialog.Overlay className={overlayClass} />
        <RDialog.Content
          role="alertdialog"
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed inset-x-3 top-1/2 z-50 mx-auto flex max-h-[90dvh] w-auto max-w-md -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow-raised)] outline-none sm:w-full rp-forced-border"
          onOpenAutoFocus={(e) => {
            if (destructive) {
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-cancel]")?.focus();
            }
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-1">
          <RDialog.Title className="text-lg font-semibold text-ink">{title}</RDialog.Title>
          {description ? <RDialog.Description className="mt-2 text-sm text-body">{description}</RDialog.Description> : <RDialog.Description className="sr-only">Please confirm</RDialog.Description>}
          {children ? <div className="mt-3 text-sm text-body">{children}</div> : null}
          {confirmText !== undefined ? (
            <div className="mt-4 flex flex-col gap-1.5">
              <label htmlFor="rp-confirm-text" className="text-sm font-medium text-ink">
                Type <strong className="font-mono">{confirmText}</strong> to confirm
              </label>
              <input
                id="rp-confirm-text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-h-11 rounded-[var(--radius-control)] border border-control-border bg-surface px-3 text-ink"
              />
            </div>
          ) : null}
          </div>
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
            <RDialog.Close asChild>
              <Button variant="secondary" data-cancel disabled={busy}>
                {cancelLabel}
              </Button>
            </RDialog.Close>
            <Button variant={destructive ? "danger" : "primary"} onClick={run} loading={busy} disabled={blocked}>
              {confirmLabel}
            </Button>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface DrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  side?: "left" | "right";
  children?: ReactNode;
  footer?: ReactNode;
  /** Width on ≥sm screens. Full width below 24rem. */
  width?: "sm" | "md" | "lg";
  /** Hide the visual title (still labels the drawer). */
  hideTitle?: boolean;
}
const drawerWidths = { sm: "sm:max-w-xs", md: "sm:max-w-md", lg: "sm:max-w-xl" } as const;

/** Side sheet (navigation, filters, detail preview) with the same focus guarantees as Dialog. */
export function Drawer({ open, onOpenChange, trigger, title, description, side = "right", children, footer, width = "md", hideTitle }: DrawerProps) {
  const onCloseAutoFocus = useReturnFocus(trigger ? false : open);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RDialog.Trigger asChild>{trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={overlayClass} />
        <RDialog.Content
          onCloseAutoFocus={trigger ? undefined : onCloseAutoFocus}
          className={cn(
            "fixed inset-y-0 z-50 flex w-[min(100vw,22rem)] flex-col border-line bg-surface text-body shadow-[var(--shadow-raised)] outline-none sm:w-full rp-forced-border",
            side === "left" ? "left-0 border-r motion-safe:animate-slide-in-left" : "right-0 border-l motion-safe:animate-slide-in-right",
            drawerWidths[width],
          )}
        >
          <div className={cn("flex items-center justify-between gap-3 border-b border-line px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]", hideTitle && "border-b-0")}>
            <div className={cn("min-w-0", hideTitle && "sr-only")}>
              <RDialog.Title className="text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="text-sm text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">Panel</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <button type="button" aria-label="Close panel" className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-surface-sunken hover:text-ink">
                <X aria-hidden="true" className="size-5" />
              </button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          {footer ? <div className="flex flex-col-reverse gap-2 border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  /** Render a link-like item: pass a node (e.g. wouter <Link>) and it is used asChild. */
  asChild?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}
export interface DropdownMenuProps {
  /** Trigger element (Button/IconButton), rendered asChild. */
  trigger: ReactNode;
  /** Items; `"separator"` draws a divider; `{ heading }` draws a group label. */
  items: ReadonlyArray<MenuItem | "separator" | { heading: ReactNode }>;
  align?: "start" | "end";
  /** Content shown above the items (e.g. signed-in user). */
  header?: ReactNode;
}

const itemClass = "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-3 text-sm text-ink outline-none select-none data-[highlighted]:bg-surface-sunken data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted";

export function DropdownMenu({ trigger, items, align = "end", header }: DropdownMenuProps) {
  return (
    <RMenu.Root modal={false}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content align={align} sideOffset={6} collisionPadding={8} className="z-50 min-w-56 max-w-[calc(100vw-1rem)] rounded-[var(--radius-card)] border border-line bg-surface p-1.5 shadow-[var(--shadow-raised)] motion-safe:animate-fade-in rp-forced-border">
          {header ? <div className="px-3 py-2">{header}</div> : null}
          {header ? <RMenu.Separator className="my-1 h-px bg-line" /> : null}
          {items.map((item, index) => {
            if (item === "separator") return <RMenu.Separator key={index} className="my-1 h-px bg-line" />;
            if ("heading" in item) return <RMenu.Label key={index} className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{item.heading}</RMenu.Label>;
            if (item.asChild) {
              return (
                <RMenu.Item key={index} asChild disabled={item.disabled} className={cn(itemClass, item.destructive && "text-danger")}>
                  {item.asChild}
                </RMenu.Item>
              );
            }
            return (
              <RMenu.Item key={index} disabled={item.disabled} onSelect={item.onSelect} className={cn(itemClass, item.destructive && "text-danger [&_svg]:text-danger")}>
                {item.icon}
                {item.label}
              </RMenu.Item>
            );
          })}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}
/** Supplementary hint on hover/focus. Never put essential information only in a tooltip. */
export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <RTooltip.Provider delayDuration={300}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content side={side} sideOffset={6} collisionPadding={8} className="z-[70] max-w-xs rounded-md bg-navy px-2.5 py-1.5 text-xs text-on-navy shadow-[var(--shadow-raised)]">
            {content}
            <RTooltip.Arrow className="fill-navy" />
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
