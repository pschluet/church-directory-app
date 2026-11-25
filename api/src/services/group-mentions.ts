import type { GroupMentionDto } from "../types";

/**
 * # mentions of groups, resolved for one reader.
 *
 * A body says `<#group-id>` (see GROUP_MENTION_TOKEN in rich-text.ts); what
 * that reads as depends on who is reading:
 *
 *   - a group that still exists, which the reader may know about (Public or
 *     Private, or Secret and the reader is a member or a parish admin -- the
 *     groups list's own rule): its name, and a link to it. Archived groups
 *     still link; their page still opens.
 *   - a deleted group the reader could have known about: its name, from
 *     `deleted_groups` (V40), and no link.
 *   - anything else -- a Secret group the reader is not in, a group in another
 *     parish, an id that never was a group: no name ("#secret group").
 *
 * Done in SQL, as a subselect of the query that reads the post, so every place
 * that reads posts resolves them the same way without a second round trip.
 */

const TOKEN_PATTERN = "<#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>";

/**
 * A JSON array of `GroupMentionDto`, one per distinct group `body` mentions.
 * Each argument is a SQL expression: the body text, the organization the post
 * belongs to, and the reader's `app_users.id`.
 */
export function groupMentionsSubselect(body: string, organizationId: string, appUserId: string) {
  return `(
           select coalesce(
                    json_agg(
                      json_build_object(
                        'groupId', ids.id,
                        'title', case
                          when g.id is not null
                            and (g.visibility <> 'SECRET' or gm.app_user_id is not null or viewer.is_admin)
                            then g.title
                          when g.id is null and dg.id is not null
                            and (dg.visibility <> 'SECRET'
                                 or ${appUserId} = any(dg.member_app_user_ids)
                                 or viewer.is_admin)
                            then dg.title
                        end,
                        'linkable', g.id is not null
                          and (g.visibility <> 'SECRET' or gm.app_user_id is not null or viewer.is_admin)
                      )
                    ),
                    '[]'::json
                  )
             from (
               select distinct lower(m.parts[1])::uuid as id
                 from regexp_matches(coalesce(${body}, ''), '${TOKEN_PATTERN}', 'gi') as m(parts)
             ) ids
             cross join (
               select exists (
                        select 1 from app_users au
                         where au.id = ${appUserId} and au.role in ('ADMIN', 'SUPER_ADMIN')
                      ) as is_admin
             ) viewer
             left join groups g on g.id = ids.id and g.organization_id = ${organizationId}
             left join group_members gm on gm.group_id = g.id and gm.app_user_id = ${appUserId}
             left join deleted_groups dg on dg.id = ids.id and dg.organization_id = ${organizationId}
         )`;
}

/** The JSON the subselect returns, as the DTO; null (no body) reads as none. */
export function toGroupMentionDtos(rows: GroupMentionDto[] | null | undefined): GroupMentionDto[] {
  return (rows ?? []).map((row) => ({
    groupId: row.groupId,
    title: row.title ?? null,
    linkable: row.linkable === true,
  }));
}

/** A lookup from group id to the name the reader may see, for rendering a body. */
export function groupLabelsOf(mentions: GroupMentionDto[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const mention of mentions) if (mention.title) labels[mention.groupId] = mention.title;
  return labels;
}
