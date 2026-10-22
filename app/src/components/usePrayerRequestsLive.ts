import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrayerRequestsLiveDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { GROUP_LIVE_INTERVAL_MS } from "./useGroupLive";

/** How often an open prayer requests page asks whether anything changed -- as often as a group. */
export const PRAYER_REQUESTS_LIVE_INTERVAL_MS = GROUP_LIVE_INTERVAL_MS;

/**
 * Makes the open prayer requests page live, as useGroupLive does a group:
 * requests posted, withdrawn or decided, and other people's reactions, arrive
 * on their own.
 *
 * It polls a stamp that changes whenever anything on the page does (see
 * V28__prayer_request_reactions.sql) for the reasons useGroupLive gives: one
 * primary-key lookup, only while the page is open and the tab visible. The
 * first stamp is only remembered; a later, different one refetches the feed
 * and the review queue, and the bell, whose count a newly posted request moves.
 */
export function usePrayerRequestsLive(): void {
  const queryClient = useQueryClient();
  const { organizationId } = useMe();

  const live = useQuery({
    queryKey: qk.prayerRequestsLive(organizationId),
    queryFn: ({ signal }) => api<PrayerRequestsLiveDto>("/prayer-requests/live", { signal }),
    refetchInterval: PRAYER_REQUESTS_LIVE_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Always ask the server: a poll that answers from cache is not a poll.
    staleTime: 0,
    gcTime: 0,
  });

  const seen = useRef<string | null>(null);
  const activityAt = live.data?.activityAt;
  useEffect(() => {
    if (!activityAt) return;
    const previous = seen.current;
    seen.current = activityAt;
    if (previous === null || previous === activityAt) return;

    // One prefix: the feed and the review queue nested under it.
    for (const queryKey of [qk.prayerRequests(organizationId), qk.notifications()]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: "active" });
    }
  }, [activityAt, organizationId, queryClient]);
}
