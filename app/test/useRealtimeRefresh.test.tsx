import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { MeDto } from "@shared";
import { useRealtimeRefresh } from "../src/components/useRealtimeRefresh";
import { qk } from "../src/lib/queryKeys";
import { testQueryClient } from "./utils";

/**
 * The push-to-cache bridge, which is the whole of the app's real-time now that
 * nothing polls.
 *
 * A bare `EventTarget` stands in for `navigator.serviceWorker` -- the pattern
 * test/push.test.ts already uses -- because jsdom has no service worker at all
 * and the hook only ever calls addEventListener/removeEventListener on it.
 */

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }) as unknown as MeDto & { organizationId: string },
}));

const CHANGED = "prayer-requests-changed";

function installServiceWorker(): EventTarget & { startMessages?: () => void } {
  const target = new EventTarget() as EventTarget & { startMessages?: () => void };
  target.startMessages = vi.fn();
  Object.defineProperty(navigator, "serviceWorker", { value: target, configurable: true });
  return target;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function mount() {
  const queryClient = testQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useRealtimeRefresh(), { wrapper });
  return { ...view, invalidate };
}

describe("useRealtimeRefresh", () => {
  let sw: EventTarget & { startMessages?: () => void };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sw = installServiceWorker();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error -- putting jsdom back the way it was
    delete navigator.serviceWorker;
  });

  const post = (data: unknown) => sw.dispatchEvent(new MessageEvent("message", { data }));

  it("invalidates the bell and the prayer requests page", async () => {
    const { invalidate } = mount();

    post({ type: CHANGED });
    await vi.advanceTimersByTimeAsync(300);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.notifications(),
      refetchType: "active",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.prayerRequests("org-1"),
      refetchType: "active",
    });
  });

  it("marks invalid without a request when the tab is hidden", async () => {
    // The focus refetch on both queries picks it up on return. On iOS a
    // backgrounded PWA is frozen anyway, so a fetch here would be wasted.
    setVisibility("hidden");
    const { invalidate } = mount();

    post({ type: CHANGED });
    await vi.advanceTimersByTimeAsync(300);

    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ refetchType: "none" }));
  });

  it("ignores messages it does not recognise", async () => {
    // Workbox and virtual:pwa-register share this channel for their own
    // lifecycle messages; an unguarded handler would refetch on every update.
    const { invalidate } = mount();

    post({ type: "SKIP_WAITING" });
    post({ meta: "workbox-broadcast-update" });
    post(undefined);
    await vi.advanceTimersByTimeAsync(300);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("collapses a burst into one round", async () => {
    const { invalidate } = mount();

    post({ type: CHANGED });
    post({ type: CHANGED });
    post({ type: CHANGED });
    await vi.advanceTimersByTimeAsync(300);

    // Two keys, once each -- not six calls.
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("starts the message queue, so a cold start does not swallow the first push", () => {
    mount();
    expect(sw.startMessages).toHaveBeenCalled();
  });

  it("stops listening when unmounted", async () => {
    const { unmount, invalidate } = mount();
    unmount();

    post({ type: CHANGED });
    await vi.advanceTimersByTimeAsync(300);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does nothing at all where there is no service worker", () => {
    // @ts-expect-error -- a browser without one, and jsdom by default
    delete navigator.serviceWorker;
    expect(() => mount()).not.toThrow();
  });
});
