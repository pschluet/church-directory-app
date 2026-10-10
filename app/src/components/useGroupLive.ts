import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupLiveDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";

/** How often an open group asks whether anything changed. */
export const GROUP_LIVE_INTERVAL_MS = 2000;

/**
 * Makes an open group page live: other people's posts, replies, edits, deletes
 * and RSVPs arrive on their own, and who is typing is known.
 *
 * A poll rather than a pushed connection, on purpose -- the API is one Lambda in
 * a VPC with no NAT and no interface endpoints, so a WebSocket would mean a new
 * API, a connections table and a paid route out of that VPC. What it polls is
 * one primary-key lookup (see V20__group_live.sql), cheap enough to ask every
 * couple of seconds, and it only runs while the group is open and the tab is
 * visible: React Query pauses an interval in a hidden tab, and the focus
 * refetch on the page's own queries catches up when the member returns -- which
 * is also the only thing that works on an iOS PWA frozen in the background.
 *
 * The response carries a stamp that changes whenever anything in the group does.
 * The first one is only remembered; a later, different one means "refetch what
 * is on screen". Only active queries refetch, so a closed tab of the page costs
 * nothing.
 *
 * `markRead` is what keeps the unread badge from climbing while the member is
 * looking right at the new message.
 */
export function useGroupLive(
  groupId: string,
  { enabled, markRead }: { enabled: boolean; markRead?: (() => void) | undefined }
): { typing: string[] } {
  const queryClient = useQueryClient();
  const { organizationId } = useMe();

  const live = useQuery({
    queryKey: qk.groupLive(organizationId, groupId),
    queryFn: ({ signal }) => api<GroupLiveDto>(`/groups/${groupId}/live`, { signal }),
    enabled,
    refetchInterval: GROUP_LIVE_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Always ask the server: a poll that answers from cache is not a poll.
    staleTime: 0,
    gcTime: 0,
  });

  const seen = useRef<string | null>(null);
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  const activityAt = live.data?.activityAt;
  useEffect(() => {
    if (!activityAt) return;
    const previous = seen.current;
    seen.current = activityAt;
    if (previous === null || previous === activityAt) return;

    for (const queryKey of [
      // One prefix: the feed, every open reply thread and RSVP roster.
      qk.groupPosts(organizationId, groupId),
      qk.groupFiles(organizationId, groupId),
      qk.groupEvents(organizationId, groupId),
      qk.notifications(),
    ]) {
      void queryClient.invalidateQueries({ queryKey, refetchType: "active" });
    }
    markReadRef.current?.();
  }, [activityAt, groupId, organizationId, queryClient]);

  // Another group is a new conversation: its first stamp is a baseline too.
  useEffect(() => {
    seen.current = null;
  }, [groupId]);

  return { typing: live.data?.typing ?? [] };
}

/** "Ann is typing…", "Ann and Bo are typing…", "Several people are typing…". */
export function typingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/** Minimum gap between "I am typing" signals from one message bar. */
export const TYPING_SIGNAL_INTERVAL_MS = 3000;
