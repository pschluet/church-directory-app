import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

/** How long a press must last to count as a long press. The same as a message's. */
export const LONG_PRESS_MS = 450;

/**
 * A long press on something that is also a link or a button: hold it for
 * `LONG_PRESS_MS` and `onLongPress` runs instead of the tap.
 *
 * Moving more than a few pixels is a scroll, not a press, and the browser also
 * cancels the pointer once it takes over a scroll. The lift that ends a long
 * press must not also follow the link underneath, so its click is swallowed;
 * Android's own long-press menu, and any text selection the OS starts during
 * the hold, are kept out of the way too.
 *
 * Spread `handlers` on the element; `pressing` is true while the press is
 * held, for showing that it has been noticed.
 */
export function useLongPress(onLongPress: () => void) {
  const [pressing, setPressing] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const latest = useRef(onLongPress);
  latest.current = onLongPress;

  function cancel(): void {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setPressing(false);
  }
  useEffect(() => cancel, []);

  const handlers = {
    onPointerDown(event: PointerEvent) {
      // A mouse's right button opens its own menu; only a primary press counts.
      if (event.pointerType === "mouse" && event.button !== 0) return;
      cancel();
      setPressing(true);
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          setPressing(false);
          // Most browsers fire no click after a long press, so the flag must
          // not outlive the lift or it would eat the next real tap.
          swallowClick.current = true;
          window.setTimeout(() => {
            swallowClick.current = false;
          }, 400);
          navigator.vibrate?.(10);
          window.getSelection()?.removeAllRanges();
          latest.current();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove(event: PointerEvent) {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(event: MouseEvent) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event: MouseEvent) {
      // Android raises its own menu on a long press; the long press replaces it.
      if (window.matchMedia?.("(hover: none)").matches) event.preventDefault();
    },
  };

  return { pressing, handlers };
}
