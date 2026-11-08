import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { syncAppBadge } from "../lib/appBadge";
import { inboxQueryOptions } from "./NotificationBell";

/**
 * Mirrors the bell's unread count onto the home-screen icon.
 *
 * Reads the same query as the bell -- same key, same options -- so it shares
 * its cache and costs no extra request; it follows every change the bell sees,
 * including the optimistic 0 when the panel is opened, which is what clears the
 * icon.
 *
 * Mounted once, in AppShell, for the reason `useRealtimeRefresh` is: AppShell
 * renders the bell twice.
 */
export function useAppBadge(): void {
  const { data } = useQuery(inboxQueryOptions());
  const unread = data?.unreadCount;

  useEffect(() => {
    // Nothing loaded yet is not "nothing unread": leave whatever the service
    // worker last set until the real number arrives.
    if (unread === undefined) return;
    syncAppBadge(unread);
  }, [unread]);
}
