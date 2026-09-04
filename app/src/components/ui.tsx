import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * The small shared pieces. Kept in one file because each is a handful of lines
 * and they are almost always imported together.
 */

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-ink-muted" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-primary/30 bg-primary/5 p-4 text-ink">
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 font-bold text-primary underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-surface-muted px-6 py-12 text-center">
      <p className="font-bold text-ink">{title}</p>
      {children && <div className="mt-2 text-ink-muted">{children}</div>}
    </div>
  );
}

/**
 * `actions` sits to the right of the title and bottom-aligns with the subtitle.
 * `filters` gets a row of its own underneath, aligned back to the left under
 * the title -- a filter belongs with the thing it narrows, and putting it in
 * `actions` instead would push whatever is up there out of line.
 */
export function PageHeading({
  title,
  subtitle,
  actions,
  filters,
  /**
   * For `actions` that are icon-sized -- a lone three-dots menu, say. Keeps
   * them beside the title even on a phone, where the default stacking would
   * give a 24px button a row of its own and a page about saving space would
   * open by wasting some.
   */
  compactActions = false,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  compactActions?: boolean;
}) {
  return (
    <header className="mb-6 md:mb-8">
      <div
        className={
          compactActions
            ? "flex flex-row items-start justify-between gap-3 md:items-end"
            : "flex flex-col gap-3 md:flex-row md:items-end md:justify-between"
        }
      >
        <div>
          <h1 className="text-2xl font-bold text-ink md:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
      </div>
      {filters && <div className="mt-3 flex flex-wrap gap-4">{filters}</div>}
    </header>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-dark disabled:bg-primary/50",
  secondary: "border border-primary text-primary hover:border-accent hover:text-accent",
  ghost: "text-ink-muted hover:text-primary",
  danger: "border border-primary text-primary hover:bg-primary hover:text-white",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`tap-target inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

/** A labelled form field. Inputs are full width and 16px to avoid iOS zoom. */
export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    // The input arrives as `children` and is wrapped by this label, which is a
    // valid implicit association -- the rule just cannot see through the prop.
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`
    <label className={`block ${className}`}>
      <span className="mb-1 block font-bold text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-sm text-ink-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-sm font-bold text-primary">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-muted/60 focus:border-accent focus:outline-none";

/**
 * Closes on Escape and stops the page behind from scrolling.
 *
 * Shared by Modal and PhotoLightbox: on a phone the scrim covers the viewport,
 * so without the lock a scroll gesture that misses the dialog moves the page
 * underneath it instead.
 */
export function useDismissable(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
}

/**
 * A clock that advances, for relative timestamps.
 *
 * "2 minutes ago" is computed at render, and React has no reason to render
 * again -- so without this a label sits frozen at whatever it said when the
 * component mounted. That is not a cosmetic problem: with nothing polling, a
 * page left open showed "1 hour ago" beside a bell that had re-rendered for its
 * own reasons and said "2 hours ago", from identical data. Two clocks, one of
 * them stopped.
 *
 * Ticks only while the document is visible -- nobody is reading a hidden tab,
 * and waking the CPU to recompute invisible text is pure waste -- and re-syncs
 * on `visibilitychange`, which is the case that matters most: somebody
 * returning after an hour wants the times right immediately, not up to
 * `intervalMs` later.
 *
 * 30 seconds by default, which is half the granularity of the shortest label
 * `formatPostedAt` produces, so no reading is ever more than a minute stale.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}

/**
 * Whether a media query currently matches.
 *
 * For the rare case where two layouts are different enough that `md:hidden` on
 * one and `hidden md:block` on the other is the wrong tool -- the family page's
 * member list is rows on a phone and photo tiles on a desktop, and rendering
 * both would put every member in the document twice, duplicating their link and
 * their menu for assistive technology as well as for the DOM.
 *
 * Pass a raw query rather than a breakpoint name; Tailwind's `md` is
 * `(min-width: 48rem)`.
 */
export function useMinWidth(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * A three-dots menu, for actions that would otherwise crowd a heading or repeat
 * themselves down a list.
 *
 * Built on the same footing as InfoPopover rather than on `useDismissable`:
 * that locks page scrolling, which is right for a Modal covering the viewport
 * and wrong for a menu anchored in a list row. Click rather than hover, for the
 * reason given there -- this directory is used mostly on phones.
 *
 * The panel is right-aligned and clamped to the viewport because these sit near
 * the right edge of a narrow screen, where a left-aligned panel runs off it.
 */
export function MenuButton({
  label,
  children,
  className = "",
}: {
  /** What the button opens, for screen readers -- e.g. "Actions for Paul". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Which side of the button the panel sits on. Always "below" until it has been
   * measured, which is the common case and avoids a frame of it in the wrong
   * place.
   */
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape has to hand focus back, or it lands on <body> and the next Tab
      // starts from the top of the page.
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /*
   * Opening moves focus into the menu, which is what makes the arrow keys below
   * land somewhere sensible and what a keyboard user expects of a menu button.
   *
   * Placement is settled first, and the focus is `preventScroll`. The last row
   * of a list is the case that forces both: a panel hanging off the bottom gets
   * flipped above the button rather than left off-screen, and without
   * preventScroll the browser would then scroll something -- the page, or any
   * clipping ancestor -- to reveal the item we just deliberately placed in view.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;

    const buttonBox = button.getBoundingClientRect();
    const panelHeight = panel.getBoundingClientRect().height;
    const GAP = 8;
    const roomBelow = window.innerHeight - buttonBox.bottom;
    // Only flip when there is genuinely more room the other way, so a panel
    // taller than the whole viewport does not end up pinned to the top.
    const flip = roomBelow < panelHeight + GAP && buttonBox.top > roomBelow;
    setPlacement(flip ? "above" : "below");

    items(panel)[0]?.focus({ preventScroll: true });
  }, [open]);

  function onPanelKeyDown(event: React.KeyboardEvent): void {
    const focusable = items(panelRef.current);
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Wraps, so a short menu does not dead-end at either edge.
      const next = (current + step + focusable.length) % focusable.length;
      focusable[next]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      focusable[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    }
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() =>
          setOpen((wasOpen) => {
            if (wasOpen) setPlacement("below");
            return !wasOpen;
          })
        }
        className="tap-target inline-flex items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-primary"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
          <circle cx="10" cy="4" r="1.75" />
          <circle cx="10" cy="10" r="1.75" />
          <circle cx="10" cy="16" r="1.75" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          // Closes after any activation, so every item does not have to
          // remember to. Capturing on click covers pointer and Enter/Space
          // alike, since a button fires click for all three.
          onClick={() => setOpen(false)}
          className={`absolute right-0 z-30 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-line bg-surface py-1 text-left shadow-lg ${
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The focusable entries in an open menu, in document order. */
function items(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
}

export function MenuItem({
  onSelect,
  danger = false,
  children,
}: {
  onSelect: () => void;
  /** For an entry that takes something away -- removing, leaving, deleting. */
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`block w-full px-4 py-2.5 text-left transition hover:bg-surface-muted focus-visible:bg-surface-muted ${
        danger ? "text-primary" : "text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  /** For a dialog that needs the width, such as the photo cropper. */
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useDismissable(onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* Full-height sheet on a phone, centred dialog from md up. */}
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-surface p-5 shadow-xl md:rounded-xl md:p-6 ${
          wide ? "md:max-w-4xl" : "md:max-w-2xl"
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap-target -mr-2 -mt-2 text-2xl leading-none text-ink-muted hover:text-primary"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A modal that asks before doing something that cannot be undone from the same
 * screen. Pass the consequence as children -- "Are you sure?" on its own tells
 * nobody anything.
 */
export function ConfirmDialog({
  title,
  confirmLabel = "Confirm",
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-ink-muted">{children}</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "accent";
}) {
  const tones = {
    neutral: "bg-surface-muted text-ink-muted ring-line",
    primary: "bg-primary/10 text-primary ring-primary/20",
    accent: "bg-accent/10 text-accent ring-accent/30",
  } as const;
  // A badge is a one-line pill: never wrap it and never let a flex row squeeze
  // it, or it grows a second line and shoves its neighbours around.
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A short "why does this look like that?" note behind an info icon.
 *
 * Click rather than hover: hover has no equivalent on a touch screen, and this
 * directory is used mostly on phones. Deliberately not built on
 * `useDismissable` -- that locks page scrolling, which is right for a
 * viewport-covering Modal and wrong for a note anchored inside a list row.
 */
export function InfoPopover({
  label,
  title,
  children,
}: {
  /** What the icon does, for screen readers -- e.g. "Why is this year hidden?" */
  label: string;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex text-ink-muted transition hover:text-accent"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
          <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM9 8.5h2v6H9v-6Zm0-3h2v2H9v-2Z" />
        </svg>
      </button>
      {open && (
        // Anchored under the icon and clamped to the viewport, so it stays
        // readable on a narrow phone instead of running off the right edge.
        <span
          id={panelId}
          role="note"
          className="absolute left-1/2 top-6 z-20 w-64 max-w-[calc(100vw-3rem)] -translate-x-1/2 rounded-md border border-line bg-surface p-3 text-left text-sm font-normal text-ink-muted shadow-lg"
        >
          <span className="mb-1 block font-bold text-ink">{title}</span>
          {children}
        </span>
      )}
    </span>
  );
}
