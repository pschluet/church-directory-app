import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GroupSummaryDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import type { MentionableGroup } from "./RichComposerEditor";

/**
 * The groups list -- every group the caller may know about, as the server
 * filters it -- under the one query key the Groups page and the composer's
 * # list share, so opening one after the other costs no second request.
 */
export function useGroupsList() {
  const { organizationId } = useMe();
  return useQuery({
    queryKey: qk.groups(organizationId),
    queryFn: ({ signal }) => api<{ groups: GroupSummaryDto[] }>("/groups", { signal }),
  });
}

/**
 * The groups a message may # mention: the ones the writer can open -- their
 * own, and Public ones (every group, for a parish admin) -- leaving out
 * archived groups, alphabetically.
 */
export function useMentionableGroups(): MentionableGroup[] {
  const { isAdmin } = useMe();
  const groups = useGroupsList().data?.groups;
  return useMemo(
    () =>
      (groups ?? [])
        .filter(
          (g) =>
            g.archivedAt === null && (g.visibility === "PUBLIC" || g.myRole !== null || isAdmin)
        )
        .map((g) => ({ id: g.id, title: g.title, visibility: g.visibility }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [groups, isAdmin]
  );
}
