import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * A height that makes an element end at the bottom of the window.
 *
 * For the map, which is the only thing in this app that wants all the room
 * there is. It used to be `h-[60vh] md:h-[70vh]`, and on a desktop its bottom
 * edge landed a couple of hundred pixels below the fold: 70% of the viewport,
 * plus a header that measures 167px from `md` up and 232px for a super admin,
 * plus the page padding and the heading, does not fit in 100%.
 *
 * Measured rather than `calc(100dvh - var(--app-header-height) - 14rem)`,
 * because the part being subtracted is not a constant. It is `main`'s padding,
 * the page heading's margin, and an administrator's missing-church-address
 * notice that is absent, one paragraph or two. A magic number would be correct
 * on exactly one screen, and `--app-header-height` only accounts for the
 * header.
 *
 * Returns null until it has measured, and null in an environment that cannot
 * measure -- callers keep a viewport-relative class as the fallback so a map
 * still appears either way.
 */
/** A field that takes typed text has focus, so a software keyboard may be up. */
function isTyping(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

/** A finger rather than a mouse -- the case where a keyboard takes half the screen. */
function isTouchScreen(): boolean {
  return window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;
}

/**
 * The home-indicator strip at the bottom of a notched iPhone, in pixels. Read by
 * letting CSS resolve `env()` on a probe, since JavaScript has no direct access.
 * Zero anywhere there is no inset, and in jsdom, which does not parse `env()`.
 */
function safeAreaBottom(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingBottom);
  probe.remove();
  return Number.isFinite(inset) ? inset : 0;
}

export function useFillViewport(
  ref: RefObject<HTMLElement | null>,
  {
    gap = 24,
    min = 320,
    holdWhileTyping = false,
    clearHomeIndicator = false,
  }: {
    gap?: number;
    min?: number;
    holdWhileTyping?: boolean;
    /** Also leave room for the home-indicator strip, so a bottom bar clears the bezel. */
    clearHomeIndicator?: boolean;
  } = {}
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;

    /*
     * `holdWhileTyping`: on a phone, leave the height alone while a field has
     * focus. Opening the keyboard shrinks the visual viewport and, separately,
     * the browser pans it down to bring the field into view -- by an amount
     * worked out for the layout as it stood. Shrinking the box to the smaller
     * viewport at the same moment moves the field *up* by roughly what the pan
     * moved the window down, and it ends up above the top of what is visible.
     * (And answering the pan by growing the box again, or by looking more
     * often, only made the two chase each other.) Held still, the browser's own
     * reveal lands the field right above the keyboard, as it does on any page.
     * Only for a touch screen: on a laptop a field having focus says nothing
     * about the window, and it should keep following it.
     */
    if (holdWhileTyping && isTouchScreen() && isTyping()) return;

    /*
     * `visualViewport` first. On iOS `innerHeight` counts the strip the address
     * bar sits over, so sizing to it puts the bottom of the map behind browser
     * chrome -- the same class of bug as the one on the desktop, one device
     * down.
     */
    const viewport = window.visualViewport?.height ?? window.innerHeight;

    /*
     * The element's distance down the *document*, not down the viewport, so the
     * answer does not change as the page is scrolled. `rect.top` alone would
     * shrink the map every time somebody scrolled and then grow it back.
     */
    const top = element.getBoundingClientRect().top + window.scrollY;

    const bottomGap = gap + (clearHomeIndicator ? safeAreaBottom() : 0);
    setHeight(Math.max(Math.round(viewport - top - bottomGap), min));
  }, [ref, gap, min, holdWhileTyping, clearHomeIndicator]);

  useEffect(() => {
    measure();

    window.addEventListener("resize", measure);
    // A phone rotating, or iOS' address bar sliding away, moves the visual
    // viewport without firing `resize` on the window.
    window.visualViewport?.addEventListener("resize", measure);

    /*
     * And the page itself can change height above the element without the
     * window changing at all: the header grows by 65px for a super admin, and
     * the church-address notice appears once the data arrives. Observing the
     * root catches both without knowing about either.
     */
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.documentElement);

    /*
     * Measuring was skipped while a field had focus, so catch up once it lets
     * go -- after a moment, so the keyboard has finished going away and the
     * viewport has its full height back before it is read.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    function catchUp(): void {
      clearTimeout(settle);
      settle = setTimeout(measure, 400);
    }
    if (holdWhileTyping) document.addEventListener("focusout", catchUp);

    return () => {
      document.removeEventListener("focusout", catchUp);
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure, holdWhileTyping]);

  return height;
}
