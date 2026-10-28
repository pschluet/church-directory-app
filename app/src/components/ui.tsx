import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

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
 *
 * A grid rather than a flex column, because `titleAction` needs to sit *beside*
 * the title on a narrow screen while `actions` wraps to a row of its own
 * underneath -- which a single flex line cannot express without either
 * duplicating a node per breakpoint or absolutely positioning something. From
 * `md` up it becomes an ordinary flex row and `mr-auto` on the title does the
 * spreading. Both pre-existing layouts come out identical: one column is a
 * stack, and two columns with a `1fr` first is the same as `justify-between`.
 */
export function PageHeading({
  title,
  subtitle,
  actions,
  filters,
  /**
   * An action that belongs with the title rather than with `actions`.
   *
   * On a phone it sits top right, level with the heading, and `actions` drops
   * to the full-width row beneath it; from `md` up it joins `actions` on the
   * right, last. That is for the Directory's "Map View" link, which is a way to
   * *another page* rather than something that narrows this one: stacked under a
   * search box it read as part of the search, and a search box is the thing
   * somebody came to the Directory to type in, so it keeps the wide row.
   */
  titleAction,
  /** Something small that sits inline right after the title, such as an info button. */
  titleAdornment,
  /**
   * For `actions` that are icon-sized -- a lone three-dots menu, say. Keeps
   * them beside the title even on a phone, where the default stacking would
   * give a 24px button a row of its own and a page about saving space would
   * open by wasting some.
   */
  compactActions = false,
  /**
   * Less room below, for a page whose content wants every pixel it can get --
   * a conversation, where the gap under the title is height the messages could
   * have had. Every other page keeps the generous default.
   */
  tight = false,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  titleAction?: ReactNode;
  titleAdornment?: ReactNode;
  compactActions?: boolean;
  tight?: boolean;
}) {
  // Anything sharing the heading's row needs a second column to sit in.
  const besideTitle = compactActions || titleAction !== undefined;

  return (
    <header className={tight ? "mb-2" : "mb-6 md:mb-8"}>
      <div
        className={`grid gap-3 md:flex md:flex-wrap md:items-end ${
          besideTitle ? "grid-cols-[minmax(0,1fr)_auto] items-start" : "grid-cols-1"
        }`}
      >
        {/* `mr-auto` is what pushes everything else right once this is a flex row. */}
        <div className="min-w-0 md:mr-auto">
          {titleAdornment ? (
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-ink md:text-3xl">{title}</h1>
              {titleAdornment}
            </div>
          ) : (
            <h1 className="text-2xl font-bold text-ink md:text-3xl">{title}</h1>
          )}
          {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
        </div>
        {titleAction && (
          // Last on a wide screen, so the search box stays next to the title it
          // belongs to and this sits at the far edge.
          <div className="justify-self-end md:order-last">{titleAction}</div>
        )}
        {actions && (
          <div className={`flex flex-wrap justify-end gap-2 ${titleAction ? "col-span-2" : ""}`}>
            {actions}
          </div>
        )}
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
 * The page-scroll half of `useDismissable`, factored out and reference-counted
 * so two dismissables open at once (the group photo lightbox over the members
 * modal, say) don't fight over `document.body.style.overflow`. Each caller's
 * own "previous value" only matters for the first lock and the last unlock;
 * the module-level counter is what makes the ones in between no-ops instead
 * of each stomping on the other's restore.
 */
let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock = "";

function lockBodyScroll(): () => void {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount++;
  return () => {
    bodyScrollLockCount--;
    if (bodyScrollLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

/**
 * Keeps the page itself from scrolling while something with its own scroll area
 * fills the screen -- a conversation, whose messages scroll inside a pane and
 * whose message bar must stay put at the bottom. The shell's footer and the
 * padding under `main` would otherwise make the page a little taller than the
 * window and let the whole thing slide, bar and all.
 *
 * Goes to the top first: locking mid-scroll would freeze the header off screen.
 * Shares the reference-counted lock with the dialogs, so a modal opened over a
 * conversation does not unlock it on close.
 */
export function usePageScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    window.scrollTo(0, 0);
    const release = lockBodyScroll();
    // No rubber-band either, on a touch screen, where "locked" still bounces.
    const root = document.documentElement;
    const overscroll = root.style.overscrollBehavior;
    root.style.overscrollBehavior = "none";

    /*
     * On iOS, focusing the message field pans the page up to clear the
     * keyboard. With the body locked there is nothing to scroll it back, so
     * when the keyboard goes away the pan can stay and the header is stranded
     * above the top edge. Scroll back as the field lets go, so the glide shares
     * the keyboard's own closing animation instead of following it as a second
     * one. A check once the keyboard is gone snaps it only if that was not
     * enough.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    const offTop = () => window.scrollY > 1 || (window.visualViewport?.offsetTop ?? 0) > 1;
    function backToTop(event: FocusEvent): void {
      // Focus moving to another field keeps the keyboard up.
      const next = event.relatedTarget;
      if (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement) return;
      clearTimeout(settle);
      if (!offTop()) return;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      settle = setTimeout(() => {
        if (offTop()) window.scrollTo(0, 0);
      }, 600);
    }
    document.addEventListener("focusout", backToTop);

    return () => {
      document.removeEventListener("focusout", backToTop);
      clearTimeout(settle);
      release();
      root.style.overscrollBehavior = overscroll;
    };
  }, [enabled]);
}

/**
 * Closes on Escape and stops the page behind from scrolling.
 *
 * Shared by Modal and PhotoLightbox: on a phone the scrim covers the viewport,
 * so without the lock a scroll gesture that misses the dialog moves the page
 * underneath it instead.
 *
 * Two separate effects, not one keyed on `[onClose]`: every call site passes
 * an inline arrow, which is a new identity on every render, and the scroll
 * lock must only run once per mount/unmount regardless -- re-running it on
 * every render was `lockBodyScroll`'s whole bug, re-capturing "previous
 * overflow" from whatever another concurrently-open dismissable had already
 * set it to. The keydown listener still wants the *latest* `onClose`, which a
 * ref gives it without that effect needing to depend on `onClose` either.
 */
export function useDismissable(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(lockBodyScroll, []);
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
  portal = false,
  trigger,
  align = "right",
  buttonClassName = "tap-target inline-flex items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-primary",
}: {
  /** What the button opens, for screen readers -- e.g. "Actions for Paul". */
  label: string;
  children: ReactNode;
  className?: string;
  /**
   * Render the panel on `document.body`, fixed to the button, instead of inside
   * it. For a button that lives in a scrolling pane: an absolutely positioned
   * panel there is clipped by the pane's own overflow, and the flip below would
   * be measuring the window rather than the room the pane actually leaves.
   */
  portal?: boolean;
  /** Replaces the three dots, e.g. a "+" for an add menu. */
  trigger?: ReactNode;
  /** Which edge of the button the panel lines up with. */
  align?: "left" | "right";
  /** Replaces the button's own look, for a trigger that draws its own shape. */
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Which side of the button the panel sits on. Always "below" until it has been
   * measured, which is the common case and avoids a frame of it in the wrong
   * place.
   */
  const [placement, setPlacement] = useState<"below" | "above">("below");
  /** Where a portalled panel sits, in viewport pixels. Null until measured. */
  const [fixedAt, setFixedAt] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // A portalled panel is not inside the container in the DOM.
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape has to hand focus back, or it lands on <body> and the next Tab
      // starts from the top of the page.
      buttonRef.current?.focus();
    };
    // A fixed panel does not follow its button when the pane underneath scrolls.
    const onScroll = () => {
      if (portal) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, portal]);

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
    if (portal) {
      const horizontal =
        align === "right"
          ? { right: Math.max(8, window.innerWidth - buttonBox.right) }
          : { left: Math.max(8, buttonBox.left) };
      setFixedAt(
        flip
          ? { bottom: window.innerHeight - buttonBox.top + 4, ...horizontal }
          : { top: buttonBox.bottom + 4, ...horizontal }
      );
    }

    items(panel)[0]?.focus({ preventScroll: true });
  }, [open, portal, align]);

  const wrapPanel = (panel: ReactNode) => (portal ? createPortal(panel, document.body) : panel);

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
        className={buttonClassName}
      >
        {trigger ?? (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
            <circle cx="10" cy="4" r="1.75" />
            <circle cx="10" cy="10" r="1.75" />
            <circle cx="10" cy="16" r="1.75" />
          </svg>
        )}
      </button>

      {open &&
        wrapPanel(
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
            style={
              portal ? { position: "fixed", ...(fixedAt ?? { top: -9999, left: 0 }) } : undefined
            }
            className={
              portal
                ? "z-50 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-line bg-surface py-1 text-left shadow-lg"
                : `absolute ${align === "left" ? "left-0" : "right-0"} z-30 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-line bg-surface py-1 text-left shadow-lg ${
                    placement === "above" ? "bottom-full mb-1" : "top-full mt-1"
                  }`
            }
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

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * The open list of a Select or MultiSelect: portalled, fixed to its button,
 * following it as anything scrolls, and dismissed by a pointer outside it or a
 * resize. Also keeps the highlighted option scrolled into view.
 */
function useAnchoredList(open: boolean, dismiss: () => void, activeOptionId: string | null) {
  const [fixedAt, setFixedAt] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The listeners below are attached once per opening; this keeps them calling
  // the latest `dismiss` rather than the one from that render.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  /*
   * Placed below the button unless there is more room above, as MenuButton is.
   * The side is chosen once, on opening, so the list does not jump from one to
   * the other while it follows the button.
   */
  const flipRef = useRef(false);
  function place(choose: boolean): void {
    const button = buttonRef.current;
    const list = listRef.current;
    if (!button || !list) return;
    const box = button.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const GAP = 4;
    if (choose) {
      const roomBelow = window.innerHeight - box.bottom;
      flipRef.current = roomBelow < listBox.height + GAP && box.top > roomBelow;
    }
    const listWidth = Math.max(box.width, listBox.width);
    const left = Math.max(8, Math.min(box.left, window.innerWidth - listWidth - 8));
    setFixedAt(
      flipRef.current
        ? { bottom: window.innerHeight - box.top + GAP, left, minWidth: box.width }
        : { top: box.bottom + GAP, left, minWidth: box.width }
    );
  }

  useLayoutEffect(() => {
    if (open) place(true);
    else setFixedAt(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => dismissRef.current();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close();
    };
    /*
     * A fixed list does not move with the page, so it follows the button
     * instead. Closing on scroll was the alternative, and the wrong one: a
     * scroll still settling as the list opens -- momentum on a phone, or a
     * dialog bringing the focused button into view -- shut it again at once.
     */
    let frame = 0;
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = buttonRef.current?.getBoundingClientRect();
        // Gone off screen entirely: there is nothing left to anchor to.
        if (!box || box.bottom < 0 || box.top > window.innerHeight) close();
        else place(false);
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  /*
   * Keeps the highlighted option in view as the arrow keys move it. By hand
   * rather than with scrollIntoView, which would also scroll the page -- and on
   * the first render the list is still parked off screen, waiting to be placed.
   */
  useEffect(() => {
    const list = listRef.current;
    const option = activeOptionId ? document.getElementById(activeOptionId) : null;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  });

  return {
    buttonRef,
    listRef,
    // Parked off screen until it has been measured and placed.
    fixedAt: fixedAt ?? { top: -9999, left: 0, minWidth: 0 },
  };
}

const LIST_PANEL_CLASS =
  "z-[60] max-h-72 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-md border border-line bg-surface py-1 text-left shadow-lg ring-1 ring-ink/5 motion-safe:animate-[select-in_120ms_ease-out]";

/**
 * Letters typed within half a second of each other build one search, so "ma"
 * reaches March past May, as on a native select. The index of the first option
 * starting with what has been typed, or -1.
 */
function typeaheadMatch(
  state: { text: string; at: number },
  event: React.KeyboardEvent,
  options: { label: string }[]
): number {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return -1;
  const now = Date.now();
  const text = now - state.at < 500 ? state.text + event.key : event.key;
  state.text = text.toLowerCase();
  state.at = now;
  return options.findIndex((option) => option.label.toLowerCase().startsWith(state.text));
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`h-5 w-5 shrink-0 fill-current text-ink-muted transition-transform duration-150 motion-reduce:transition-none ${
        open ? "rotate-180 text-accent" : ""
      }`}
    >
      <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

function CheckMark({ shown }: { shown: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`h-4 w-4 shrink-0 fill-current ${shown ? "" : "invisible"}`}
    >
      <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
    </svg>
  );
}

/**
 * A dropdown, in place of a native `<select>`.
 *
 * The native control's open state is whatever the OS draws -- a grey system
 * list on a desktop, a full-screen wheel on a phone -- and none of it can be
 * styled, so it was the one part of every form that did not look like this app.
 * This draws its own list in the same panel MenuButton and LookupPicker use.
 *
 * It follows the WAI-ARIA "select-only combobox" pattern: focus stays on the
 * button, the arrow keys move a highlight through the list and
 * `aria-activedescendant` points at it, and typing a letter jumps to the first
 * option that starts with it, as a native select does.
 *
 * The list is portalled and fixed to the button, because most of these live in
 * a Modal whose own scroll area would otherwise clip it. For the same reason it
 * closes if anything outside it scrolls, since a fixed panel would not follow.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  required = false,
  compact = false,
  className = "",
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /** Shown, muted, while the value matches no option -- "Choose a church…". */
  placeholder?: string;
  disabled?: boolean;
  /** Blocks the form from submitting while the value is empty, as on a select. */
  required?: boolean;
  /** Sized to its content and a row of text, for a control sitting inline. */
  compact?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const { buttonRef, listRef, fixedAt } = useAnchoredList(
    open,
    () => setOpen(false),
    open && activeIndex >= 0 ? optionId(activeIndex) : null
  );

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function show(index = selectedIndex >= 0 ? selectedIndex : 0): void {
    if (disabled || options.length === 0) return;
    setActiveIndex(index);
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
  }

  function choose(index: number): void {
    const option = options[index];
    close();
    buttonRef.current?.focus();
    if (option && option.value !== value) onChange(option.value);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (disabled) return;
    const last = options.length - 1;

    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(last, index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        return;
      case "Escape":
        // Stopped here so a Modal underneath does not close along with the list.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Tab":
        close();
        return;
    }

    const match = typeaheadMatch(typeahead.current, event, options);
    if (match >= 0) setActiveIndex(match);
  }

  const sizing = compact
    ? "tap-target rounded-md border border-line bg-surface pl-3 pr-2 py-1"
    : `${inputClass} pr-2`;

  return (
    <span className={`relative min-w-0 ${compact ? "inline-flex" : "flex"} ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={`${sizing} flex w-full min-w-0 items-center justify-between gap-2 text-left transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line ${
          open ? "border-accent" : ""
        }`}
      >
        {/*
         * Every label stacked in one grid cell, all but the current one hidden,
         * so a compact control is as wide as its longest option -- as a native
         * select is -- and does not change width as the choice changes. Still
         * free to shrink and truncate when there is not that much room.
         */}
        <span className="grid min-w-0 grid-cols-[minmax(0,max-content)]">
          <span className={`col-start-1 row-start-1 truncate ${selected ? "" : "text-ink-muted"}`}>
            {selected?.label ?? placeholder ?? "\u00a0"}
          </span>
          {compact &&
            [placeholder, ...options.map((option) => option.label)].map((label, index) => (
              <span
                key={index}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 h-0 truncate"
              >
                {label}
              </span>
            ))}
        </span>
        <Chevron open={open} />
      </button>

      {required && (
        // Something for the browser's constraint validation to hold on to: a
        // button takes no part in it. Focus is handed straight to the button,
        // which is where the browser sends it when it reports this as empty.
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value}
          onChange={() => {}}
          onFocus={() => buttonRef.current?.focus()}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px w-full opacity-0"
        />
      )}

      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              ...fixedAt,
            }}
            className={LIST_PANEL_CLASS}
          >
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                // As in LookupPicker: options are not focusable, focus stays on
                // the button and aria-activedescendant points here.
                // biome-ignore lint/a11y/useFocusableInteractive: see above
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  data-value={option.value}
                  // mousedown would move focus off the button before the click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`tap-target flex cursor-pointer items-center gap-2 px-3 py-2 ${
                    index === activeIndex ? "bg-surface-muted" : ""
                  } ${isSelected ? "font-bold text-primary" : "text-ink"}`}
                >
                  <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  <CheckMark shown={isSelected} />
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </span>
  );
}

/**
 * Select's look, choosing any number of options rather than one -- a filter
 * where nothing chosen means "all of them".
 *
 * A listbox with `aria-multiselectable`: choosing an option toggles it and
 * leaves the list open for the next, which is the difference from Select.
 * Escape, Tab or a click elsewhere closes it. The button names the one option
 * chosen, or says how many when there are several.
 */
export function MultiSelect<T extends string>({
  values,
  onChange,
  options,
  allLabel,
  summarize,
  className = "",
  "aria-label": ariaLabel,
}: {
  values: T[];
  onChange: (values: T[]) => void;
  options: SelectOption<T>[];
  /** What the button says with nothing chosen -- "All roles". */
  allLabel: string;
  /** What it says with more than one chosen -- "3 roles". */
  summarize: (count: number) => string;
  className?: string;
  "aria-label": string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const { buttonRef, listRef, fixedAt } = useAnchoredList(
    open,
    () => setOpen(false),
    open && activeIndex >= 0 ? optionId(activeIndex) : null
  );

  const chosen = options.filter((option) => values.includes(option.value));
  const summary =
    chosen.length === 0
      ? allLabel
      : chosen.length === 1
        ? chosen[0]!.label
        : summarize(chosen.length);

  function toggle(index: number): void {
    const option = options[index];
    if (!option) return;
    setActiveIndex(index);
    // In the options' order rather than the order they were picked, so the
    // same choice always reads -- and serializes -- the same way.
    const next = values.includes(option.value)
      ? values.filter((value) => value !== option.value)
      : [...values, option.value];
    onChange(options.map((o) => o.value).filter((value) => next.includes(value)));
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const last = options.length - 1;

    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setActiveIndex(0);
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(last, index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        toggle(activeIndex);
        return;
      case "Escape":
        // Stopped here so a Modal underneath does not close along with the list.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      case "Tab":
        setOpen(false);
        return;
    }

    const match = typeaheadMatch(typeahead.current, event, options);
    if (match >= 0) setActiveIndex(match);
  }

  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        onClick={() => {
          if (!open) setActiveIndex(0);
          setOpen(!open);
        }}
        onKeyDown={onKeyDown}
        className={`${inputClass} flex w-full min-w-0 items-center justify-between gap-2 pr-2 text-left transition hover:border-accent ${
          open ? "border-accent" : ""
        }`}
      >
        <span className={`truncate ${chosen.length === 0 ? "text-ink-muted" : ""}`}>{summary}</span>
        <Chevron open={open} />
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-multiselectable="true"
            style={{ position: "fixed", ...fixedAt }}
            className={LIST_PANEL_CLASS}
          >
            {options.map((option, index) => {
              const isSelected = values.includes(option.value);
              return (
                // As in Select: focus stays on the button.
                // biome-ignore lint/a11y/useFocusableInteractive: see above
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  data-value={option.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggle(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`tap-target flex cursor-pointer items-center gap-2 px-3 py-2 ${
                    index === activeIndex ? "bg-surface-muted" : ""
                  } ${isSelected ? "font-bold text-primary" : "text-ink"}`}
                >
                  <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  <CheckMark shown={isSelected} />
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </span>
  );
}

/**
 * The part of the window actually on screen, as `top` and `height` for a
 * `position: fixed` box, kept current as it moves. Null where there is no
 * `visualViewport` to read (jsdom, old browsers); callers fall back to `inset-0`.
 *
 * On iOS `position: fixed` is relative to the layout viewport, which the
 * keyboard does not shrink. A bottom sheet pinned there has its fields behind
 * the keyboard, so focusing one makes Safari pan the page to reveal it -- and
 * carries the fixed sheet up off the screen with it. Sized to the visual
 * viewport instead, the sheet sits right above the keyboard with the field
 * already in view, and there is nothing to pan.
 */
function useVisualViewportBox(): { top: number; height: number } | null {
  const read = () => {
    const viewport = window.visualViewport;
    return viewport ? { top: viewport.offsetTop, height: viewport.height } : null;
  };
  const [box, setBox] = useState(read);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setBox(read());
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return box;
}

export function Modal({
  title,
  onClose,
  children,
  /** For a dialog that needs the width, such as the photo cropper. */
  wide = false,
  noSelect = false,
  dismissable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /**
   * False for a dialog that must be answered from its own buttons: no ×, and
   * neither Escape nor a backdrop click closes it. The scroll lock still holds.
   */
  dismissable?: boolean;
  /**
   * No text selection or touch callout anywhere in it. For a sheet opened by a
   * long press: the OS is still treating that press as "select", and without
   * this it highlights whatever is under the finger in the sheet that has just
   * appeared there.
   */
  noSelect?: boolean;
}) {
  useDismissable(dismissable ? onClose : () => {});
  // Over what is on screen, not the layout viewport -- see useVisualViewportBox.
  const onScreen = useVisualViewportBox();

  /*
   * Portalled to the body, like PhotoLightbox, rather than rendered where it
   * was written.
   *
   * `position: fixed` is only relative to the viewport while no ancestor has
   * made itself a containing block. Google's InfoWindow positions its bubble
   * with a transform and clips it, so the maps chooser opened from an address
   * inside a map popover came out as a sliver a few pixels wide, pinned inside
   * the bubble and unusable. Nothing else in the app had an ancestor that did
   * that, which is why this went unnoticed -- and why the fix belongs here
   * rather than at the one call site that exposed it.
   */
  return createPortal(
    <div
      className={`fixed inset-x-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6 ${
        onScreen ? "" : "inset-y-0"
      } ${noSelect ? "select-none [-webkit-touch-callout:none]" : ""}`}
      style={onScreen ? { top: onScreen.top, height: onScreen.height } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (dismissable && event.target === event.currentTarget) onClose();
      }}
    >
      {/* Full-height sheet on a phone, centred dialog from md up. A share of the
          overlay, not of `vh`, which on iOS includes the part under the keyboard. */}
      <div
        className={`max-h-[92%] w-full overflow-y-auto rounded-t-xl bg-surface p-5 shadow-xl md:rounded-xl md:p-6 ${
          wide ? "md:max-w-4xl" : "md:max-w-2xl"
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold text-ink">{title}</h2>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="tap-target -mr-2 -mt-2 text-2xl leading-none text-ink-muted hover:text-primary"
            >
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body
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
