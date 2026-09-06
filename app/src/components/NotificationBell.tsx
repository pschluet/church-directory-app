import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { InboxDto, NotificationType } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatPostedAt } from "../lib/format";
import { useNow } from "./ui";

/**
 * The bell, and the panel behind it.
 *
 * Built on the same footing as `MenuButton` -- click rather than hover, closed
 * by a document `pointerdown` and by Escape, right-aligned to the button and
 * nudged back into view when that would put it over the edge. Not built on
 * `MenuButton` itself: that panel is a `role="menu"` of `menuitem`s with arrow
 * key navigation, and this is a list of links with a heading, which is a
 * different thing to announce. Not built on `useDismissable` either, since that
 * locks page scrolling, which is right for a full-screen Modal and wrong for a
 * popover anchored in a header.
 *
 * Opening it marks everything read, which is what the requirement asks for --
 * "when the notifications are viewed, the badge should go away".
 */
/**
 * What each kind of notification is, in the panel.
 *
 * The title alone is the whole message for a posted request; for one waiting to
 * be reviewed the title only says *which* request, and this is what says it
 * needs the reader to do something.
 */
const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  PRAYER_REQUEST: "Prayer request",
  PRAYER_REQUEST_REVIEW: "Needs your approval",
};

export function NotificationBell({ className = "" }: { className?: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  /**
   * How far right of its `right-0` placement the panel has to sit, in px.
   *
   * Right-aligning to the bell is only enough when the bell is the rightmost
   * thing in the header, and it is not -- the settings gear and the hamburger
   * are outside it. That leaves the panel needing a 388px viewport to clear the
   * left edge, so a 360px phone (a 1080px screen at DPR 3, which is most of
   * them) chops 28px off it, with no horizontal scroll to reach the rest.
   *
   * `max-w` does not help: it caps the width, and the width already fits. It is
   * the position that is out of bounds.
   *
   * Measured rather than written down, the same way `MenuButton` decides
   * whether to flip above its button. The offset depends on whatever else the
   * header has next to the bell, and rearranging that header is what put the
   * panel over the edge in the first place.
   */
  const [shift, setShift] = useState(0);

  const inboxQuery = useQuery({
    queryKey: qk.notifications(),
    queryFn: ({ signal }) => api<InboxDto>("/notifications", { signal, withOrg: false }),
    /*
     * Deliberately not polled. This used to refetch every 60s, because a prayer
     * request is posted by somebody else and there was nothing to invalidate
     * the cache from. There is now: the service worker forwards the push to
     * every open tab and `useRealtimeRefresh` invalidates this key.
     *
     * Polling was dropped rather than tightened because its cost scales with
     * concurrent tabs -- tens of dollars a month at ten thousand members -- to
     * catch something that happens a few times a week.
     *
     * The window-focus refetch stays on for this one query; the app-wide
     * default is off (see lib/queryClient.ts). Coming back to the app is
     * exactly the moment somebody looks at the bell, and it is what covers
     * members who have not enabled notifications and so never get a push. Note
     * it only fires when the data is already stale (30s) or was invalidated.
     */
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: () => api("/notifications/read", { method: "POST", withOrg: false }),
    onMutate: () => {
      // Optimistic, so the badge goes as the panel opens rather than a round
      // trip later.
      queryClient.setQueryData<InboxDto>(qk.notifications(), (previous) =>
        previous
          ? {
              unreadCount: 0,
              notifications: previous.notifications.map((n) => ({ ...n, read: true })),
            }
          : previous
      );
    },
    /*
     * Not optional, and it used to be: this said "a failure is corrected by the
     * next poll", and there is no next poll. Without settling against the
     * server a failed mark-read leaves the badge reading 0 forever, and a push
     * arriving mid-flight can refetch pre-commit state and strand it at the old
     * number instead. Re-reading once is what makes the guess above safe.
     */
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.notifications() }),
    /*
     * Deliberately silent. Marking notifications read is a background
     * courtesy, and a warning about it failing would be more disruptive than
     * the failure -- the badge reappearing after `onSettled` re-reads is the
     * signal, and it is an honest one. Handled explicitly rather than left to
     * the default so the rejection is not merely unobserved.
     */
    onError: (err) => console.warn("Could not mark notifications read", err),
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Or focus lands on <body> and the next Tab starts from the top.
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
   * Placed before the browser paints, so the panel never shows up in the wrong
   * spot for a frame.
   */
  useLayoutEffect(() => {
    // Cleared on the way closed, so the next open measures from `right-0`
    // rather than from wherever the last one ended up.
    if (!open) {
      setShift(0);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;

    // 1rem either side, which is the 2rem the `max-w` reserves.
    const GUTTER = 16;
    const box = panel.getBoundingClientRect();
    const overhang = GUTTER - box.left;
    if (overhang <= 0) return;
    /*
     * The smallest nudge that clears the edge, rather than parking the panel
     * against the right gutter: it stays as close to the bell it belongs to as
     * the screen allows. Capped by the room on the other side so a panel wider
     * than the viewport keeps its left edge -- where the text starts -- in
     * view instead of trading one clipped edge for the other.
     */
    const roomOnTheRight = window.innerWidth - GUTTER - box.right;
    setShift(Math.min(overhang, Math.max(0, roomOnTheRight)));
  }, [open]);

  // So "2 minutes ago" in the panel keeps up with the clock instead of freezing
  // at whatever it said when this last rendered for some other reason.
  const now = useNow();

  const inbox = inboxQuery.data;
  const unread = inbox?.unreadCount ?? 0;
  const notifications = inbox?.notifications ?? [];

  function toggle(): void {
    setOpen((wasOpen) => {
      // Only on the way open, and only when there is something to clear.
      if (!wasOpen && unread > 0) markRead.mutate();
      return !wasOpen;
    });
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        // The count is in the label, not only in the badge: a screen reader
        // gets nothing from a superscript number.
        aria-label={unread === 0 ? "Notifications" : `Notifications, ${unread} unread`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="tap-target relative inline-flex items-center justify-center rounded-md text-ink transition hover:bg-surface-muted hover:text-primary"
      >
        {/* Inline SVG, as everywhere else here -- the app ships no icon package. */}
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
          <path d="M10 2a5 5 0 0 0-5 5v3.28l-1.3 2.44A.75.75 0 0 0 4.36 14h11.28a.75.75 0 0 0 .66-1.28L15 10.28V7a5 5 0 0 0-5-5Z" />
          <path d="M8 15.5a2 2 0 0 0 4 0H8Z" />
        </svg>
        {unread > 0 && (
          <span
            aria-hidden="true"
            /*
             * min-w with px padding rather than a fixed square, so "12" does
             * not get clipped the way a w-4 circle would.
             */
            className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-bold leading-4 text-white"
          >
            {/* Past 9 the exact number stops mattering and the badge stops fitting. */}
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          style={shift > 0 ? { right: -shift } : undefined}
          className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-line bg-surface text-left shadow-lg"
        >
          {notifications.length === 0 ? (
            <p className="px-3 py-4 text-sm text-ink-muted">Nothing new.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <Link
                    to="/prayer-requests"
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2.5 transition hover:bg-surface-muted"
                  >
                    {/*
                     * The title is the whole message for a prayer request
                     * notification, so it gets the emphasis and the unread ones
                     * are the ones in full-strength ink.
                     */}
                    <span
                      className={`block truncate font-bold ${
                        notification.read ? "text-ink-muted" : "text-ink"
                      }`}
                    >
                      {notification.title}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {NOTIFICATION_LABELS[notification.type]} ·{" "}
                      {formatPostedAt(notification.createdAt, now)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
