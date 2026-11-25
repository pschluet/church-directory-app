import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ARRIVAL_PARAM, ARRIVAL_SOURCES, MESSAGE_PARAM, type InboxDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";

/**
 * Marks a message's notifications read when the member arrives at it from a
 * push notification or a notification email -- what clicking the same entry
 * in the bell does.
 *
 * Neither can do it themselves (the service worker has no auth context, see
 * sw.ts; an email is only a link), so their links carry `?from=push` or
 * `?from=email` next to `?message=` and the page does it on landing. Bell
 * links carry no marker: the bell marks read on click.
 *
 * Once per navigation (`location.key`), not per URL: the param stays in the
 * address rather than being stripped, because replacing the entry would be a
 * new navigation and light the message a second time. A reload repeats the
 * call, which by then clears nothing.
 *
 * Optimistic, like the bell's own mark-read, so the badge and the home-screen
 * icon drop with the tap; then settled against the server. Failures are
 * silent, for the reason NotificationBell gives.
 *
 * Mounted once, in AppShell, so it covers every page a message link opens.
 */
export function useMarkReadOnArrival(): void {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { key } = useLocation();
  const handled = useRef<string | null>(null);

  const postId = params.get(MESSAGE_PARAM);
  const from = params.get(ARRIVAL_PARAM);
  const fromNotification = ARRIVAL_SOURCES.some((source) => source === from);

  useEffect(() => {
    if (!postId || !fromNotification || handled.current === key) return;
    handled.current = key;

    queryClient.setQueryData<InboxDto>(qk.notifications(), (previous) => {
      if (!previous) return previous;
      const clearing = previous.notifications.filter(
        (n) => n.groupPostId === postId && !n.read
      ).length;
      if (clearing === 0) return previous;
      return {
        unreadCount: Math.max(0, previous.unreadCount - clearing),
        notifications: previous.notifications.map((n) =>
          n.groupPostId === postId ? { ...n, read: true } : n
        ),
      };
    });

    api(`/notifications/posts/${encodeURIComponent(postId)}/read`, {
      method: "POST",
      withOrg: false,
    })
      .catch((err) => console.warn("Could not mark the notification read", err))
      .finally(() => queryClient.invalidateQueries({ queryKey: qk.notifications() }));
  }, [postId, fromNotification, key, queryClient]);
}
