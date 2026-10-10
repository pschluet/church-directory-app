import { rolesAtLeast } from "../types";
import type { Queryable } from "../db";
import { one } from "../db";
import type { GroupNotificationExceptionDto, GroupNotificationPref } from "../types";

/**
 * A member's effective preference: their own exception if they have one, else
 * the account default, else 'ALL'. `notification_preferences` is sparse -- a
 * missing row means every default is on -- so it is a LEFT JOIN, and the
 * trailing 'ALL' is what an account with no row gets. Both fragments assume the
 * membership alias is `gm`.
 */
export const GROUP_PREF_JOIN =
  "left join notification_preferences np on np.app_user_id = gm.app_user_id";
export const EFFECTIVE_GROUP_PREF =
  "coalesce(gm.notification_pref, np.group_notification_pref, 'ALL')";

/**
 * Fan-out for group activity, following the same shape prayer requests use in
 * services/notifications.ts: write the durable rows inside the caller's
 * transaction, return who was actually notified, and let the route send push
 * after commit with that exact list -- so the bell and the push agree by
 * construction rather than by two copies of the recipient rule.
 *
 * A post can trigger two *different* notifications for two different people
 * sets, and a member in both sets gets only one of them -- the more specific
 * one. Someone @ mentioned in a post gets a GROUP_MENTION, never also a
 * GROUP_POST for the same post, even if their preference is "all posts";
 * otherwise being mentioned would mean two notifications about one post
 * instead of one.
 */

/**
 * Everyone subscribed to "all posts" in this group, except whoever wrote it
 * and anyone this post already mentions (they get `fanOutGroupMention`
 * instead). `on conflict do nothing` against notifications_one_per_group_post_idx
 * makes a retried request idempotent.
 */
export async function fanOutGroupPost(
  q: Queryable,
  options: {
    groupId: string;
    groupPostId: string;
    organizationId: string;
    actingAppUserId: string;
    mentionedAppUserIds: string[];
  }
): Promise<string[]> {
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, group_id, group_post_id)
     select gm.app_user_id, $2, 'GROUP_POST', $1, $3
       from group_members gm
       join app_users u on u.id = gm.app_user_id
       ${GROUP_PREF_JOIN}
      where gm.group_id = $1
        and ${EFFECTIVE_GROUP_PREF} = 'ALL'
        and u.status = 'ACTIVE'
        and gm.app_user_id <> $4
        and gm.app_user_id <> all($5::uuid[])
     on conflict do nothing
     returning app_user_id`,
    [
      options.groupId,
      options.organizationId,
      options.groupPostId,
      options.actingAppUserId,
      options.mentionedAppUserIds,
    ]
  );
  return rows.map((row) => row.app_user_id);
}

/**
 * Everyone this post @ mentions, except the author, and except anyone who has
 * turned this group's notifications off entirely. A "mentions only"
 * preference is exactly the case this exists for -- mentioning someone is the
 * one thing that preference still delivers.
 */
export async function fanOutGroupMention(
  q: Queryable,
  options: {
    groupId: string;
    groupPostId: string;
    organizationId: string;
    actingAppUserId: string;
    mentionedAppUserIds: string[];
  }
): Promise<string[]> {
  if (options.mentionedAppUserIds.length === 0) return [];
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, group_id, group_post_id)
     select gm.app_user_id, $2, 'GROUP_MENTION', $1, $3
       from group_members gm
       join app_users u on u.id = gm.app_user_id
       ${GROUP_PREF_JOIN}
      where gm.group_id = $1
        and gm.app_user_id = any($5::uuid[])
        and ${EFFECTIVE_GROUP_PREF} <> 'NONE'
        and u.status = 'ACTIVE'
        and gm.app_user_id <> $4
     on conflict do nothing
     returning app_user_id`,
    [
      options.groupId,
      options.organizationId,
      options.groupPostId,
      options.actingAppUserId,
      options.mentionedAppUserIds,
    ]
  );
  return rows.map((row) => row.app_user_id);
}

/**
 * Group admins, told that someone is waiting to join a Private group.
 *
 * Deliberately not gated on `notification_pref` -- that switch is about the
 * volume of ordinary conversation, and a pending request is work waiting on
 * them, the same reasoning `fanOutPrayerRequestForReview` gives for ignoring
 * the `prayer_requests` toggle.
 *
 * `on conflict ... do update` rather than `do nothing`: unlike a post, a group
 * has no per-request id to key on (see V16__groups.sql), so the unique index
 * is per (app_user_id, group_id) and a second, different person's request
 * would otherwise be silently dropped once the first has already been
 * delivered. Reviving the same row -- clearing `read_at`, bumping
 * `created_at` -- means a new request re-lights a badge an admin already
 * cleared, which is exactly the point: there is something new to look at.
 */
export async function fanOutGroupJoinRequest(
  q: Queryable,
  options: { groupId: string; organizationId: string }
): Promise<string[]> {
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, group_id)
     select gm.app_user_id, $2, 'GROUP_JOIN_REQUEST', $1
       from group_members gm
       join app_users u on u.id = gm.app_user_id
      where gm.group_id = $1
        and gm.role = 'ADMIN'
        and u.status = 'ACTIVE'
     on conflict (app_user_id, type, group_id) where type = 'GROUP_JOIN_REQUEST'
       do update set read_at = null, created_at = now()
     returning app_user_id`,
    [options.groupId, options.organizationId]
  );
  return rows.map((row) => row.app_user_id);
}

/**
 * Everyone who RSVP'd to an event, told its date/time/location changed.
 *
 * "Kept and they're notified of the change" (requirements/groups.md) -- every
 * RSVP response qualifies, including NO, since "it moved to a day you said you
 * could not make" is exactly the thing a NO-RSVP needs to hear. Still honours
 * the group's own off-switch (`notification_pref <> 'NONE'`), and still
 * excludes whoever made the edit.
 */
export async function fanOutGroupEventChange(
  q: Queryable,
  options: { groupId: string; groupPostId: string; organizationId: string; actingAppUserId: string }
): Promise<string[]> {
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, group_id, group_post_id)
     select r.app_user_id, $2, 'GROUP_EVENT', $1, $3
       from group_event_rsvps r
       join group_members gm on gm.group_id = $1 and gm.app_user_id = r.app_user_id
       join app_users u on u.id = r.app_user_id
       ${GROUP_PREF_JOIN}
      where r.post_id = $3
        and ${EFFECTIVE_GROUP_PREF} <> 'NONE'
        and u.status = 'ACTIVE'
        and r.app_user_id <> $4
     on conflict do nothing
     returning app_user_id`,
    [options.groupId, options.organizationId, options.groupPostId, options.actingAppUserId]
  );
  return rows.map((row) => row.app_user_id);
}

/**
 * Group admins and parish admins, told that a post was reported.
 *
 * Both, deliberately -- "a group admin may be the problem"
 * (requirements/groups-plan.md), so reporting must not depend entirely on the
 * person it might be about. `rolesAtLeast("ADMIN")` keeps the parish half of
 * this tied to the one hierarchy definition in types.ts rather than a second
 * copy of it.
 */
export async function fanOutGroupPostReport(
  q: Queryable,
  options: {
    groupId: string;
    groupPostId: string;
    organizationId: string;
    reporterAppUserId: string | null;
  }
): Promise<string[]> {
  // No DISTINCT needed: group_members' primary key is (group_id, app_user_id),
  // so the join below matches at most one row per app_user, and a bare
  // DISTINCT here confuses Postgres's placeholder type inference into
  // resolving $2 as text in the select list against uuid in the WHERE clause
  // below -- a real (if obscure) planner quirk, not a parameter mistake.
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, group_id, group_post_id)
     select u.id, $2, 'GROUP_POST_REPORT', $1, $3
       from app_users u
       left join group_members gm on gm.group_id = $1 and gm.app_user_id = u.id
      where u.organization_id = $2
        and u.status = 'ACTIVE'
        and (gm.role = 'ADMIN' or u.role = any($5::text[]))
        and u.id is distinct from $4::uuid
     on conflict do nothing
     returning app_user_id`,
    [
      options.groupId,
      options.organizationId,
      options.groupPostId,
      options.reporterAppUserId,
      rolesAtLeast("ADMIN"),
    ]
  );
  return rows.map((row) => row.app_user_id);
}

/**
 * Set (or, with null, clear) one account's exception for one group. Returns
 * false when they are not a member, which the caller turns into a 403.
 */
export async function setGroupNotificationPref(
  q: Queryable,
  appUserId: string,
  groupId: string,
  pref: GroupNotificationPref | null
): Promise<boolean> {
  const { rows } = await q.query<{ one: number }>(
    `update group_members set notification_pref = $3
      where group_id = $1 and app_user_id = $2
      returning 1 as one`,
    [groupId, appUserId, pref]
  );
  return rows.length > 0;
}

/**
 * Every group this account has an exception for.
 *
 * Deliberately not filtered by organization, like the rest of the account-scoped
 * notification endpoints (see routes/notifications.ts): a super admin can belong
 * to groups in more than one parish.
 */
export async function loadGroupExceptions(
  q: Queryable,
  appUserId: string
): Promise<GroupNotificationExceptionDto[]> {
  const { rows } = await q.query<{
    group_id: string;
    title: string;
    organization_id: string;
    notification_pref: GroupNotificationPref;
  }>(
    `select gm.group_id, g.title, g.organization_id, gm.notification_pref
       from group_members gm
       join groups g on g.id = gm.group_id
      where gm.app_user_id = $1 and gm.notification_pref is not null
      order by g.title`,
    [appUserId]
  );
  return rows.map((row) => ({
    groupId: row.group_id,
    groupTitle: row.title,
    organizationId: row.organization_id,
    notificationPref: row.notification_pref,
  }));
}

export async function loadGroupNotificationDefault(
  q: Queryable,
  appUserId: string
): Promise<GroupNotificationPref> {
  const row = await one<{ group_notification_pref: GroupNotificationPref }>(
    q,
    "select group_notification_pref from notification_preferences where app_user_id = $1",
    [appUserId]
  );
  return row?.group_notification_pref ?? "ALL";
}
