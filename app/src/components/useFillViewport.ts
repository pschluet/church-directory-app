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
export function useFillViewport(
  ref: RefObject<HTMLElement | null>,
  { gap = 24, min = 320 }: { gap?: number; min?: number } = {}
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;

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

    setHeight(Math.max(Math.round(viewport - top - gap), min));
  }, [ref, gap, min]);

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

    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  return height;
}
