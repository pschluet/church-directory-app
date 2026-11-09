import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "./nav";
import {
  NOTIFICATION_LABELS,
  notificationPath as notificationHref,
  type InboxDto,
  type NotificationDto,
  type NotificationType,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatPostedAt } from "../lib/format";
import { useNow } from "./ui";

/**
 * The inbox query, shared with `useAppBadge` so the icon reads the same cache.
 */
export function inboxQueryOptions() {
  return queryOptions({
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
}

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
 * Opening it reads nothing: a notification is read once it is clicked, and
 * "Mark all read" in the panel's header clears the rest in one go.
 */
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

  const inboxQuery = useQuery(inboxQueryOptions());

  /*
   * Set for a moment after "Mark all read", so the rows let go of their unread
   * marks one after another rather than all in the same frame. Purely visual:
   * the cache has already changed by the time this is read.
   */
  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    if (!sweeping) return;
    const timer = window.setTimeout(() => setSweeping(false), 900);
    return () => window.clearTimeout(timer);
  }, [sweeping]);

  /*
   * Both mutations write optimistically, so the bell -- and the home-screen
   * icon, which `useAppBadge` drives off this same cache entry -- change with
   * the tap rather than a round trip later.
   *
   * Then they settle against the server, and that is not optional: without it
   * a failed write leaves the badge wrong indefinitely (there is no poll to
   * correct it), and a push arriving mid-flight can refetch pre-commit state
   * and strand it at the old number instead.
   *
   * Failures are deliberately silent. A read receipt is a background courtesy,
   * and a warning about it would be more disruptive than the failure -- the
   * badge coming back after the settle is the signal, and an honest one.
   * Handled explicitly so the rejection is not merely unobserved.
   */
  const settle = () => queryClient.invalidateQueries({ queryKey: qk.notifications() });

  const markOneRead = useMutation({
    mutationFn: (id: string) =>
      api(`/notifications/${id}/read`, { method: "POST", withOrg: false }),
    onMutate: (id) => {
      queryClient.setQueryData<InboxDto>(qk.notifications(), (previous) => {
        if (!previous) return previous;
        const target = previous.notifications.find((n) => n.id === id);
        if (!target || target.read) return previous;
        return {
          // The count can include unread notifications past the page the panel
          // lists, so it is decremented rather than recounted from the list.
          unreadCount: Math.max(0, previous.unreadCount - 1),
          notifications: previous.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        };
      });
    },
    onSettled: settle,
    onError: (err) => console.warn("Could not mark the notification read", err),
  });

  const markAllRead = useMutation({
    mutationFn: () => api("/notifications/read", { method: "POST", withOrg: false }),
    onMutate: () => {
      queryClient.setQueryData<InboxDto>(qk.notifications(), (previous) =>
        previous
          ? {
              unreadCount: 0,
              notifications: previous.notifications.map((n) => ({ ...n, read: true })),
            }
          : previous
      );
    },
    onSettled: settle,
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

  /*
   * Opening the panel reads nothing. It used to mark everything read, which
   * cleared the badge for notifications nobody had looked at past their title;
   * now each one is read when it is clicked, and "Mark all read" is the
   * explicit way to clear the rest.
   */
  function toggle(): void {
    setOpen((wasOpen) => !wasOpen);
  }

  function markEverythingRead(): void {
    setSweeping(true);
    markAllRead.mutate();
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
          className="absolute right-0 z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface text-left shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-muted px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-sm font-bold text-ink">Notifications</h2>
              {unread > 0 ? (
                <span
                  aria-live="polite"
                  className="inline-flex items-center rounded-full bg-primary px-2 text-[0.6875rem] font-bold leading-5 text-white"
                >
                  {unread} new
                </span>
              ) : notifications.length > 0 ? (
                <span
                  aria-live="polite"
                  className="inline-flex items-center gap-1 text-xs text-ink-muted"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                  All caught up
                </span>
              ) : null}
            </div>
            {unread > 0 && (
              <button
                type="button"
                onClick={markEverythingRead}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-primary transition hover:bg-primary/10 focus-visible:bg-primary/10"
              >
                <DoubleCheckIcon className="h-4 w-4" />
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <p className="px-3 py-4 text-sm text-ink-muted">Nothing new.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {notifications.map((notification, index) => (
                <li key={notification.id}>
                  <NotificationRow
                    notification={notification}
                    now={now}
                    // Staggered only for the sweep, so a single click or a
                    // refetch changes its row at once.
                    delayMs={sweeping ? Math.min(index, 10) * 45 : 0}
                    onClick={() => {
                      if (!notification.read) markOneRead.mutate(notification.id);
                      setOpen(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One line of the panel.
 *
 * Unread and read differ in four ways at once, so the difference survives a
 * glance, a small screen and somebody who cannot tell red from grey: a tinted
 * row with a rail down its left edge, a coloured glyph, a bold title, and a
 * live dot on the glyph that becomes a check mark once read. All of it is
 * rendered in both states and transitioned, so a row visibly settles into
 * "read" -- one after another when everything is marked at once -- instead of
 * being swapped for a different element.
 */
function NotificationRow({
  notification,
  now,
  delayMs,
  onClick,
}: {
  notification: NotificationDto;
  now: Date;
  delayMs: number;
  onClick: () => void;
}) {
  const unread = !notification.read;
  const transition = "transition-all duration-300 ease-out motion-reduce:transition-none";
  const delay = delayMs > 0 ? { transitionDelay: `${delayMs}ms` } : undefined;

  return (
    <Link
      to={notificationHref(notification)}
      onClick={onClick}
      data-unread={unread || undefined}
      style={delay}
      className={`relative flex items-start gap-3 px-3 py-3 ${transition} ${
        unread ? "bg-primary/[0.06] hover:bg-primary/10" : "bg-surface hover:bg-surface-muted"
      }`}
    >
      {/* The rail: unread rows hang off it, and it retracts as they are read. */}
      <span
        aria-hidden="true"
        style={delay}
        className={`absolute inset-y-0 left-0 w-[3px] origin-top rounded-r bg-primary ${transition} ${
          unread ? "scale-y-100" : "scale-y-0"
        }`}
      />

      <span
        aria-hidden="true"
        style={delay}
        className={`relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${transition} ${
          unread
            ? "bg-primary/10 text-primary ring-1 ring-primary/20"
            : "bg-surface-muted text-ink-muted ring-1 ring-line"
        }`}
      >
        <TypeIcon type={notification.type} className="h-[1.125rem] w-[1.125rem]" />

        {/* Unread: a live dot, with a slow halo where motion is welcome. */}
        <span
          style={delay}
          className={`absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface bg-primary ${transition} ${
            unread ? "notification-live scale-100 opacity-100" : "scale-0 opacity-0"
          }`}
        />
        {/* Read: the dot's place taken by a quiet check mark. */}
        <span
          style={delay}
          className={`absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line bg-surface text-ink-muted ${transition} ${
            unread ? "scale-0 opacity-0" : "scale-100 opacity-100"
          }`}
        >
          <CheckIcon className="h-2.5 w-2.5" />
        </span>
      </span>

      <span className="min-w-0 flex-1">
        {unread && <span className="sr-only">Unread: </span>}
        {/*
         * The title is the whole message for a prayer request notification,
         * so it gets the emphasis, and the unread ones are the ones in
         * full-strength ink.
         */}
        <span
          style={delay}
          className={`block truncate ${transition} ${
            unread ? "font-bold text-ink" : "font-normal text-ink-muted"
          }`}
        >
          {notification.title}
        </span>
        <span className="block text-xs text-ink-muted">
          {NOTIFICATION_LABELS[notification.type]} · {formatPostedAt(notification.createdAt, now)}
        </span>
      </span>
    </Link>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`${className} fill-none stroke-current`}
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`${className} fill-none stroke-current`}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m1.5 10.5 3.5 3.5 7-8" />
      <path d="m9.5 13.5.5.5 7-8" />
    </svg>
  );
}

/** A glyph per kind of notification, so the list can be scanned by shape. */
function TypeIcon({ type, className }: { type: NotificationType; className?: string }) {
  const paths: Record<NotificationType, ReactNode> = {
    // A candle, lit.
    PRAYER_REQUEST: (
      <>
        <path d="M10 2.5c1.6 1.9 2.6 3.1 2.6 4.6a2.6 2.6 0 0 1-5.2 0c0-1.5 1-2.7 2.6-4.6Z" />
        <rect x="7.75" y="11" width="4.5" height="6.5" rx="1" />
      </>
    ),
    // A clipboard waiting for its tick.
    PRAYER_REQUEST_REVIEW: (
      <>
        <rect x="4.5" y="3.5" width="11" height="14" rx="2" />
        <path d="M8 2.5h4v2.5H8z" />
        <path d="m7.5 11 1.8 1.8 3.4-3.6" />
      </>
    ),
    GROUP_POST: (
      <path d="M4 6a2.5 2.5 0 0 1 2.5-2.5h7A2.5 2.5 0 0 1 16 6v4.5a2.5 2.5 0 0 1-2.5 2.5H9.5L6 16v-3a2 2 0 0 1-2-2Z" />
    ),
    GROUP_MENTION: (
      <>
        <circle cx="10" cy="10" r="2.75" />
        <path d="M12.75 10v1.1a2 2 0 0 0 4 0V10a6.75 6.75 0 1 0-2.7 5.4" />
      </>
    ),
    GROUP_EVENT: (
      <>
        <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
        <path d="M3.5 8.5h13M7 2.75v3.5M13 2.75v3.5" />
      </>
    ),
    GROUP_JOIN_REQUEST: (
      <>
        <circle cx="8" cy="7" r="3" />
        <path d="M2.75 16.5a5.25 5.25 0 0 1 10.5 0M15.5 6.5v5M13 9h5" />
      </>
    ),
    GROUP_POST_REPORT: <path d="M5 17.5V3.5M5 4h9.5l-2 3.25 2 3.25H5" />,
    DIRECTORY_REQUEST: (
      <>
        <rect x="3.5" y="3" width="12" height="14.5" rx="1.75" />
        <circle cx="9.5" cy="8.5" r="2.25" />
        <path d="M6 14.25a3.5 3.5 0 0 1 7 0" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`${className} fill-none stroke-current`}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[type]}
    </svg>
  );
}
