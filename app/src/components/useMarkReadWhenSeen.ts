import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { notificationMatchesTarget, type InboxDto, type SeenTarget } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { inboxQueryOptions } from "./NotificationBell";

/**
 * Marks an item's notifications read once the member has actually seen it --
 * the message, prayer request, join-requests banner or directory request
 * itself on screen, not merely the page it is on. However they got there: the
 * bell, a push, an email, or just scrolling.
 *
 * Returns a callback ref for the item's element. Seen means:
 *
 *   - the tab is in front (`document.visibilityState`), so a backgrounded tab
 *     that refetches a new message does not read it for nobody;
 *   - at least half of the element is in the viewport -- or, for one taller
 *     than the screen, it fills at least half of it; clipping by a scrolling
 *     pane counts, since the observer measures what is actually visible;
 *   - and for `DWELL_MS`, so flinging a long feed past reads nothing.
 *
 * It only watches an item with something to clear: an unread notification
 * about it in the bell's cache, or -- once -- any item when the inbox holds more
 * unread than the bell lists, since one of those could be about this. So a
 * feed of hundreds of read messages costs nothing, and a notification that
 * arrives for a message already on screen is picked up when the inbox
 * refetches.
 *
 * Optimistic, like the bell's own mark-read, so the badge drops as the item is
 * seen; the server call is batched across items and settled against the
 * server afterwards. Failures are silent, for the reason NotificationBell
 * gives.
 *
 * Reads the inbox cache without fetching it (`enabled: false`): the bell in
 * AppShell owns that query.
 */
export function useMarkReadWhenSeen(target: SeenTarget | null): (el: Element | null) => void {
  const queryClient = useQueryClient();
  const { data: inbox } = useQuery({ ...inboxQueryOptions(), enabled: false });
  const [element, setElement] = useState<Element | null>(null);

  const key = target ? targetKey(target) : null;
  const pending = Boolean(
    target &&
      inbox &&
      key &&
      (hasUnreadMatch(inbox, target) || (overflows(inbox) && !sent.has(key)))
  );

  useEffect(() => {
    if (!element || !pending || !target || typeof IntersectionObserver === "undefined") return;
    return watch(element, () => markSeen(queryClient, target));
    // `target` is a fresh object every render; `key` is what identifies it.
  }, [element, pending, key, queryClient]);

  return useCallback((el: Element | null) => setElement(el), []);
}

/** How long an item has to stay in view to count as seen. */
export const DWELL_MS = 600;

/** How long seen items are gathered before one request reports them all. */
export const FLUSH_MS = 250;

function targetKey(target: SeenTarget): string {
  if ("groupPostId" in target) return `post:${target.groupPostId}`;
  if ("prayerRequestId" in target) return `prayer:${target.prayerRequestId}`;
  if ("directoryRequestId" in target) return `directory:${target.directoryRequestId}`;
  return `join:${target.joinRequestGroupId}`;
}

function hasUnreadMatch(inbox: InboxDto, target: SeenTarget): boolean {
  return inbox.notifications.some((n) => !n.read && notificationMatchesTarget(n, target));
}

/** Whether some unread notifications are past the page the bell lists. */
function overflows(inbox: InboxDto): boolean {
  return inbox.unreadCount > inbox.notifications.filter((n) => !n.read).length;
}

/*
 * Items already reported, so the overflow case -- where the cache cannot say
 * whether an item has anything to clear -- reports each one once rather than
 * every time the inbox refetches. An item with an unread match in the cache is
 * reported regardless: the optimistic update clears that match, so it cannot
 * repeat.
 */
const sent = new Set<string>();

// ---------------------------------------------------------------------------
// Watching: one observer for every item on the page.

interface Watched {
  onSeen: () => void;
  /** Whether the element is far enough in view, regardless of the tab. */
  inView: boolean;
  timer: number | null;
}

const watched = new Map<Element, Watched>();
let observer: IntersectionObserver | null = null;

function isInView(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 0.5) return true;
  const viewport = entry.rootBounds?.height ?? window.innerHeight;
  return viewport > 0 && entry.intersectionRect.height >= viewport * 0.5;
}

function schedule(element: Element, item: Watched): void {
  const shouldTime = item.inView && document.visibilityState === "visible";
  if (shouldTime && item.timer === null) {
    item.timer = window.setTimeout(() => {
      item.timer = null;
      if (watched.get(element) !== item) return;
      unwatch(element);
      item.onSeen();
    }, DWELL_MS);
  } else if (!shouldTime && item.timer !== null) {
    window.clearTimeout(item.timer);
    item.timer = null;
  }
}

function onVisibilityChange(): void {
  for (const [element, item] of watched) schedule(element, item);
}

function watch(element: Element, onSeen: () => void): () => void {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const item = watched.get(entry.target);
          if (!item) continue;
          item.inView = isInView(entry);
          schedule(entry.target, item);
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  const item: Watched = { onSeen, inView: false, timer: null };
  watched.set(element, item);
  observer.observe(element);
  return () => {
    if (watched.get(element) === item) unwatch(element);
  };
}

function unwatch(element: Element): void {
  const item = watched.get(element);
  if (item?.timer != null) window.clearTimeout(item.timer);
  watched.delete(element);
  observer?.unobserve(element);
  if (watched.size === 0 && observer) {
    observer.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}

// ---------------------------------------------------------------------------
// Reporting: optimistic now, one request for everything seen in FLUSH_MS.

const queued = new Map<string, SeenTarget>();
let flushTimer: number | null = null;

function markSeen(queryClient: QueryClient, target: SeenTarget): void {
  queryClient.setQueryData<InboxDto>(qk.notifications(), (previous) => {
    if (!previous) return previous;
    const clearing = previous.notifications.filter(
      (n) => !n.read && notificationMatchesTarget(n, target)
    ).length;
    if (clearing === 0) return previous;
    return {
      // Decremented rather than recounted: the count includes unread
      // notifications past the page the bell lists.
      unreadCount: Math.max(0, previous.unreadCount - clearing),
      notifications: previous.notifications.map((n) =>
        notificationMatchesTarget(n, target) ? { ...n, read: true } : n
      ),
    };
  });

  const key = targetKey(target);
  sent.add(key);
  queued.set(key, target);
  flushTimer ??= window.setTimeout(() => flush(queryClient), FLUSH_MS);
}

function flush(queryClient: QueryClient): void {
  flushTimer = null;
  const body = {
    groupPostIds: [] as string[],
    prayerRequestIds: [] as string[],
    directoryRequestIds: [] as string[],
    joinRequestGroupIds: [] as string[],
  };
  for (const target of queued.values()) {
    if ("groupPostId" in target) body.groupPostIds.push(target.groupPostId);
    else if ("prayerRequestId" in target) body.prayerRequestIds.push(target.prayerRequestId);
    else if ("directoryRequestId" in target)
      body.directoryRequestIds.push(target.directoryRequestId);
    else body.joinRequestGroupIds.push(target.joinRequestGroupId);
  }
  queued.clear();

  api("/notifications/seen", { method: "POST", body, withOrg: false })
    .catch((err) => console.warn("Could not mark the notification read", err))
    .finally(() => queryClient.invalidateQueries({ queryKey: qk.notifications() }));
}

/** Test hook: forget everything reported and watched. */
export function resetMarkReadWhenSeen(): void {
  for (const element of [...watched.keys()]) unwatch(element);
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = null;
  queued.clear();
  sent.clear();
}
