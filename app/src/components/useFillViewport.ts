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
  {
    gap = 24,
    min = 320,
    followPan = false,
  }: { gap?: number; min?: number; followPan?: boolean } = {}
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
     * `followPan`: end at the bottom of what is *visible*, wherever the browser
     * has moved the visual viewport. When iOS opens the keyboard it shrinks the
     * visual viewport and pans it to reveal the focused field, so its top is no
     * longer the layout viewport's top (`offsetTop` > 0). A box sized as if the
     * window began at the top then ends below the keyboard -- which is how a
     * message bar pinned to the bottom of the pane ended up scrolled out of
     * view. Measured from the element's place in the layout viewport to the
     * bottom of the visual one, it lands on top of the keyboard instead.
     */
    if (followPan) {
      const pan = window.visualViewport?.offsetTop ?? 0;
      setHeight(
        Math.max(Math.round(pan + viewport - element.getBoundingClientRect().top - gap), min)
      );
      return;
    }

    /*
     * The element's distance down the *document*, not down the viewport, so the
     * answer does not change as the page is scrolled. `rect.top` alone would
     * shrink the map every time somebody scrolled and then grow it back.
     */
    const top = element.getBoundingClientRect().top + window.scrollY;

    setHeight(Math.max(Math.round(viewport - top - gap), min));
  }, [ref, gap, min, followPan]);

  useEffect(() => {
    measure();

    window.addEventListener("resize", measure);
    // A phone rotating, or iOS' address bar sliding away, moves the visual
    // viewport without firing `resize` on the window.
    window.visualViewport?.addEventListener("resize", measure);
    // Panning to reveal a field moves the visual viewport without resizing it.
    if (followPan) window.visualViewport?.addEventListener("scroll", measure);

    /*
     * And the page itself can change height above the element without the
     * window changing at all: the header grows by 65px for a super admin, and
     * the church-address notice appears once the data arrives. Observing the
     * root catches both without knowing about either.
     */
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.documentElement);

    /*
     * `followPan` again. iOS reports the keyboard late and in pieces: the
     * visual viewport's resize event fires as the keyboard starts to rise, with
     * the height it has *then*, and the pan to reveal the field can land after
     * it with no event the first time round -- which left the message bar under
     * the keyboard until the next keystroke made it move. So while a field has
     * focus, and for a moment after it loses it, look again every so often
     * rather than trusting that every change announces itself. Cheap: a
     * `getBoundingClientRect` and a state set that is skipped when unchanged.
     */
    let poll: ReturnType<typeof setInterval> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    function startPolling(): void {
      clearTimeout(settle);
      poll ??= setInterval(measure, 100);
    }
    function stopPollingSoon(): void {
      clearTimeout(settle);
      // Long enough for the keyboard to finish going away and the page to settle.
      settle = setTimeout(() => {
        clearInterval(poll);
        poll = undefined;
        measure();
      }, 900);
    }
    if (followPan) {
      document.addEventListener("focusin", startPolling);
      document.addEventListener("focusout", stopPollingSoon);
    }

    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      document.removeEventListener("focusin", startPolling);
      document.removeEventListener("focusout", stopPollingSoon);
      clearInterval(poll);
      clearTimeout(settle);
      observer?.disconnect();
    };
  }, [measure, followPan]);

  return height;
}
