import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { useNow } from "../src/components/ui";

/**
 * The clock behind every relative timestamp.
 *
 * Worth its own file because the bug it fixes was invisible in every other
 * test: "2 minutes ago" is correct when it renders and silently wrong a minute
 * later, and nothing re-renders on its own. A page left open ended up
 * disagreeing with the notification bell about when the same prayer request was
 * posted, from identical data.
 */

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => vi.useRealTimers());

  it("advances on its interval", () => {
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current.getTime();

    act(() => void vi.advanceTimersByTime(30_000));

    expect(result.current.getTime()).toBeGreaterThan(first);
  });

  it("does not advance before the interval elapses", () => {
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current.getTime();

    act(() => void vi.advanceTimersByTime(29_000));

    expect(result.current.getTime()).toBe(first);
  });

  it("stays still while the tab is hidden", () => {
    // Nobody is reading it, and waking the CPU to recompute invisible text is
    // pure waste. On iOS a backgrounded PWA is frozen anyway.
    setVisibility("hidden");
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current.getTime();

    act(() => void vi.advanceTimersByTime(120_000));

    expect(result.current.getTime()).toBe(first);
  });

  it("catches up the moment the tab becomes visible again", () => {
    /*
     * The case that matters most. Somebody returning after an hour wants the
     * times corrected at once -- waiting up to another interval is exactly the
     * stale reading this hook exists to prevent.
     */
    setVisibility("hidden");
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current.getTime();

    act(() => void vi.advanceTimersByTime(3_600_000));
    expect(result.current.getTime()).toBe(first);

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(result.current.getTime()).toBeGreaterThanOrEqual(first + 3_600_000);
  });

  it("stops ticking when unmounted", () => {
    const { unmount } = renderHook(() => useNow(30_000));
    unmount();
    // No pending timer, so nothing can call setState on a gone component.
    expect(vi.getTimerCount()).toBe(0);
  });
});
