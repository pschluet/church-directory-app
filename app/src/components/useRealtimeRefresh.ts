import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";

/**
 * Refreshes the bell and the prayer requests page when the service worker says
 * something changed.
 *
 * This is the app's whole real-time story, and it exists because nothing polls:
 * a prayer request is posted by somebody else, so the only signal that arrives
 * on its own is the Web Push message the worker already receives. `sw.ts`
 * forwards it to every open tab; this turns it into a cache invalidation.
 *
 * It follows that members who have not enabled notifications get no live
 * updates at all -- for them the refresh button on the page and the refetch on
 * window focus are the whole mechanism. That is deliberate: see the plan's
 * costing of the poll it replaces.
 *
 * Mounted once, in AppShell. Not in NotificationBell, which AppShell renders
 * *twice* (a phone copy beside the hamburger and a desktop copy in the account
 * row) -- a listener there would register twice and invalidate twice per push.
 */

/** Must match `CHANGED_MESSAGE` in app/src/sw.ts, which cannot import from here. */
const CHANGED_MESSAGE = "prayer-requests-changed";

/**
 * Long enough to collapse a burst, short enough to feel immediate.
 *
 * Two approvals seconds apart, or one member with two subscriptions on the same
 * browser profile, each deliver their own message.
 */
const DEBOUNCE_MS = 250;

export function useRealtimeRefresh(): void {
  const queryClient = useQueryClient();
  const { organizationId } = useMe();

  useEffect(() => {
    /*
     * The type says `navigator.serviceWorker` is always there; it is undefined
     * in jsdom, and AppShell renders for real in its tests. Without this guard
     * every one of them throws.
     */
    const container = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    function refresh(): void {
      /*
       * A hidden tab is marked invalid but not refetched: `"none"` skips the
       * network entirely and the focus refetch on both queries picks it up when
       * the member comes back. That is also the only thing that works on iOS,
       * where a backgrounded PWA is frozen and the message is queued or dropped.
       */
      const refetchType = document.visibilityState === "visible" ? "active" : "none";
      // Prefix match, so `qk.pendingPrayerRequests` -- nested under the feed --
      // is swept by the same call. Sibling keys (families, directory) are not.
      void queryClient.invalidateQueries({ queryKey: qk.notifications(), refetchType });
      void queryClient.invalidateQueries({
        queryKey: qk.prayerRequests(organizationId),
        refetchType,
      });
    }

    function onMessage(event: MessageEvent): void {
      // Workbox and virtual:pwa-register use this same channel for their own
      // lifecycle messages, so an unguarded handler would refetch on every
      // worker update.
      if ((event.data as { type?: string } | null)?.type !== CHANGED_MESSAGE) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    }

    container.addEventListener("message", onMessage);
    /*
     * Messages are queued until after DOMContentLoaded unless something starts
     * the flow. Module scripts are deferred, so this listener is normally
     * registered in time -- but calling it removes the whole class of "the
     * first push after a cold start was swallowed".
     */
    container.startMessages?.();

    return () => {
      clearTimeout(timer);
      container.removeEventListener("message", onMessage);
    };
  }, [queryClient, organizationId]);
}
