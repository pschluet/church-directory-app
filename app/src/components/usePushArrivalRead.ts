import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MESSAGE_PARAM, PUSH_ARRIVAL_PARAM, PUSH_ARRIVAL_VALUE, type InboxDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";

/**
 * Marks a message's notifications read when the member arrives at it from a
 * push notification -- what clicking the same entry in the bell does.
 *
 * The service worker cannot do this itself (it has no auth context; see
 * sw.ts), so the push link carries `?from=push` next to `?message=` and the
 * page does it on landing. Only push links carry the marker, so bell clicks
 * (which already mark read) and email links are left alone.
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
export function usePushArrivalRead(): void {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { key } = useLocation();
  const handled = useRef<string | null>(null);

  const postId = params.get(MESSAGE_PARAM);
  const fromPush = params.get(PUSH_ARRIVAL_PARAM) === PUSH_ARRIVAL_VALUE;

  useEffect(() => {
    if (!postId || !fromPush || handled.current === key) return;
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
  }, [postId, fromPush, key, queryClient]);
}
