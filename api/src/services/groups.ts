import { HTTPException } from "hono/http-exception";
import type { Caller } from "../auth";
import { one, type Queryable } from "../db";
import { photoUrls } from "../photos";
import {
  canConvertGroupVisibility,
  fullName,
  type GroupMemberRole,
  type GroupNotificationPref,
  type GroupRsvpResponse,
  type GroupVisibility,
} from "../types";

/**
 * Groups: a second permission axis.
 *
 * Every other feature in this app asks one question -- "what can this role do
 * across the parish" (see services/access.ts). A group adds a second,
 * independent one -- "what can this account do *inside this one group*" -- and
 * the two combine rather than nest: a parish ADMIN is not automatically a
 * group admin, and being a group's creator does not touch their parish role at
 * all. `groupAccess` below is where the two are combined into one set of
 * capability flags, the same shape `canEditFamily` already is for families,
 * just wider.
 *
 * See requirements/groups.md for the product rules and
 * requirements/groups-plan.md for why each of these was decided the way it was.
 */

export interface GroupRow {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  photo_key: string | null;
  photo_width: number | null;
  photo_height: number | null;
  /** Whether `photo_key` has a third rendition framed for the groups-page card. */
  photo_has_card: boolean;
  visibility: GroupVisibility;
  posting_restricted: boolean;
  invites_restricted: boolean;
  replies_restricted: boolean;
  archived_at: Date | string | null;
  created_by_person_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export const GROUP_COLUMNS = `
  g.id, g.organization_id, g.title, g.description, g.photo_key, g.photo_width, g.photo_height,
  g.photo_has_card, g.visibility, g.posting_restricted, g.invites_restricted,
  g.replies_restricted, g.archived_at, g.created_by_person_id, g.created_at, g.updated_at
`;

export async function loadGroupRow(
  q: Queryable,
  groupId: string,
  organizationId: string
): Promise<GroupRow> {
  const row = await one<GroupRow>(
    q,
    `select ${GROUP_COLUMNS} from groups g where g.id = $1 and g.organization_id = $2`,
    [groupId, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Group not found" });
  return row;
}

export interface MembershipRow {
  role: GroupMemberRole;
  notification_pref: GroupNotificationPref;
  last_read_at: Date | string | null;
}

export async function loadMembership(
  q: Queryable,
  groupId: string,
  appUserId: string | null
): Promise<MembershipRow | null> {
  if (!appUserId) return null;
  return one<MembershipRow>(
    q,
    `select role, notification_pref, last_read_at
       from group_members where group_id = $1 and app_user_id = $2`,
    [groupId, appUserId]
  );
}

export interface GroupAccess {
  /** The caller's own row, or null when they are not a member. */
  membership: MembershipRow | null;
  isMember: boolean;
  /**
   * `membership.role` when the caller is a member; a parish ADMIN or SUPER_ADMIN
   * who is not a member is treated as an ADMIN here too -- "admins and super
   * admins ... can also do anything group admins can"
   * (requirements/groups.md). This is the one place that combines the two
   * permission axes; nothing downstream re-derives it.
   */
  effectiveRole: GroupMemberRole | null;
  /** True exactly when `effectiveRole` comes from parish authority, not membership. */
  viewingAsAdmin: boolean;
  /** Whether the group's existence/metadata is visible to this caller at all. */
  canRead: boolean;
  /** Whether messages, files, events and the member list are visible. */
  canReadContent: boolean;
  canPost: boolean;
  canReply: boolean;
  canInvite: boolean;
  /** Group-admin powers: delete any post, remove members, restrict, promote, archive. */
  canModerate: boolean;
  /** Legal visibility targets from here, or an empty list if the caller cannot convert. */
  canConvertTo: GroupVisibility[];
  /** Hard delete. Parish-admin only, regardless of group role -- see loadGroupRow. */
  canDelete: boolean;
  canRequestToJoin: boolean;
}

export function groupAccess(
  caller: Caller,
  group: GroupRow,
  membership: MembershipRow | null
): GroupAccess {
  const isMember = membership !== null;
  const viewingAsAdmin = !isMember && caller.isAdmin;
  const effectiveRole: GroupMemberRole | null =
    membership?.role ?? (caller.isAdmin ? "ADMIN" : null);
  const isAdminRole = effectiveRole === "ADMIN";
  const isArchived = group.archived_at !== null;

  const canRead = group.visibility !== "SECRET" || isMember || caller.isAdmin;
  const canReadContent = group.visibility === "PUBLIC" || isMember || caller.isAdmin;

  const canPost =
    !isArchived &&
    canReadContent &&
    (isAdminRole || (effectiveRole === "MEMBER" && !group.posting_restricted));
  const canReply =
    !isArchived &&
    canReadContent &&
    (isAdminRole || (effectiveRole === "MEMBER" && !group.replies_restricted));
  const canInvite =
    !isArchived &&
    canReadContent &&
    (isAdminRole || (effectiveRole === "MEMBER" && !group.invites_restricted));

  return {
    membership,
    isMember,
    effectiveRole,
    viewingAsAdmin,
    canRead,
    canReadContent,
    canPost,
    canReply,
    canInvite,
    canModerate: isAdminRole,
    canConvertTo: isAdminRole ? [...GROUP_VISIBILITY_TARGETS[group.visibility]] : [],
    canDelete: caller.isAdmin,
    canRequestToJoin:
      !isMember && !isArchived && group.visibility === "PRIVATE" && caller.personId !== null,
  };
}

/** Re-exported shape of the legal-conversion table, for `canConvertTo` above. */
const GROUP_VISIBILITY_TARGETS: Record<GroupVisibility, GroupVisibility[]> = {
  PUBLIC: ["PRIVATE", "SECRET"],
  PRIVATE: ["SECRET"],
  SECRET: ["PRIVATE"],
};

export function assertCanReadGroup(access: GroupAccess): void {
  // 404, not 403: a Secret group's existence is itself the thing being hidden
  // from a non-member, so a 403 ("exists, but you may not see it") would leak
  // exactly what the visibility rule withholds.
  if (!access.canRead) throw new HTTPException(404, { message: "Group not found" });
}

export function assertCanReadGroupContent(access: GroupAccess): void {
  if (!access.canReadContent) {
    throw new HTTPException(403, { message: "Only members of this group can see this" });
  }
}

export function assertCanPost(access: GroupAccess): void {
  if (!access.canPost) {
    throw new HTTPException(403, { message: "You cannot post in this group" });
  }
}

export function assertCanReply(access: GroupAccess): void {
  if (!access.canReply) {
    throw new HTTPException(403, { message: "You cannot reply in this group" });
  }
}

export function assertCanInvite(access: GroupAccess): void {
  if (!access.canInvite) {
    throw new HTTPException(403, { message: "You cannot add members to this group" });
  }
}

export function assertCanModerate(access: GroupAccess): void {
  if (!access.canModerate) {
    throw new HTTPException(403, { message: "Only a group admin can do that" });
  }
}

export function assertCanConvertVisibility(access: GroupAccess, to: GroupVisibility): void {
  if (!access.canModerate) {
    throw new HTTPException(403, { message: "Only a group admin can change who can join" });
  }
  if (!access.canConvertTo.includes(to)) {
    throw new HTTPException(409, { message: "That visibility change is not allowed" });
  }
}

export function assertCanDeleteGroup(access: GroupAccess): void {
  if (!access.canDelete) {
    throw new HTTPException(403, { message: "Only a parish administrator can delete a group" });
  }
}

/** Recomputes visibility, kept as one function so the rule lives in one place. */
export { canConvertGroupVisibility };

/**
 * Every mentioned app_user_id must already be a member -- "you can only
 * mention people who are already in the group" (requirements/groups.md). Done
 * as a set-difference query rather than N lookups.
 */
export async function assertMentionsAreMembers(
  q: Queryable,
  groupId: string,
  appUserIds: string[]
): Promise<void> {
  if (appUserIds.length === 0) return;
  const { rows } = await q.query<{ app_user_id: string }>(
    `select app_user_id from group_members where group_id = $1 and app_user_id = any($2::uuid[])`,
    [groupId, appUserIds]
  );
  const found = new Set(rows.map((r) => r.app_user_id));
  if (appUserIds.some((id) => !found.has(id))) {
    throw new HTTPException(400, { message: "You can only mention members of this group" });
  }
}

/**
 * Threading is exactly one level: a reply's parent must itself be a root.
 * Postgres CHECK constraints cannot consult another row, so this -- like the
 * inheritance invariants in V1__init.sql -- is a service-layer rule rather
 * than a database one. Also confirms the parent belongs to the same group,
 * which stops a reply from being filed against a post in a different group
 * entirely.
 */
export async function assertValidReplyParent(
  q: Queryable,
  groupId: string,
  parentPostId: string
): Promise<void> {
  const parent = await one<{
    group_id: string;
    parent_post_id: string | null;
    deleted_at: Date | null;
  }>(q, `select group_id, parent_post_id, deleted_at from group_posts where id = $1`, [
    parentPostId,
  ]);
  if (!parent || parent.group_id !== groupId) {
    throw new HTTPException(404, { message: "That post was not found" });
  }
  if (parent.parent_post_id !== null) {
    throw new HTTPException(400, { message: "You can only reply to a top-level post" });
  }
  if (parent.deleted_at !== null) {
    throw new HTTPException(409, { message: "That post has been deleted" });
  }
}

/** The group photo's thumb/full URLs -- see `familyCardUrl` for the card rendition. */
export function groupPhotoFields(row: Pick<GroupRow, "photo_key">): {
  thumbUrl: string | null;
  fullUrl: string | null;
} {
  return photoUrls(row.photo_key);
}

export interface GroupMemberNameRow {
  person_id: string;
  app_user_id: string;
  first_name: string;
  last_name: string | null;
  photo_key: string | null;
  role: GroupMemberRole;
  joined_at: Date | string;
}

export async function loadGroupMembers(
  q: Queryable,
  groupId: string
): Promise<GroupMemberNameRow[]> {
  const { rows } = await q.query<GroupMemberNameRow>(
    `select gm.person_id, gm.app_user_id, p.first_name, p.last_name, p.photo_key,
            gm.role, gm.joined_at
       from group_members gm
       join persons_resolved p on p.id = gm.person_id
      where gm.group_id = $1
      order by gm.role, p.first_name, p.last_name`,
    [groupId]
  );
  return rows;
}

export function toGroupMemberDto(row: GroupMemberNameRow) {
  return {
    personId: row.person_id,
    appUserId: row.app_user_id,
    name: fullName({ firstName: row.first_name, lastName: row.last_name }),
    thumbUrl: photoUrls(row.photo_key).thumbUrl,
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString(),
  };
}

export interface GroupEventRsvpRow {
  app_user_id: string;
  first_name: string;
  last_name: string | null;
  photo_key: string | null;
  response: GroupRsvpResponse;
  guest_count: number;
}

/**
 * The full RSVP roster for one event post, with names -- what backs the "who
 * said yes, and how many guests" view, since `rsvpCounts` on the post itself
 * is only ever a headcount. Joined on `app_user_id`, not `person_id`: RSVPs
 * are keyed by account (`group_event_rsvps`'s primary key), the same reason
 * the mentions subquery in group-posts.ts joins the same way.
 */
export async function loadGroupEventRsvps(
  q: Queryable,
  postId: string
): Promise<GroupEventRsvpRow[]> {
  const { rows } = await q.query<GroupEventRsvpRow>(
    `select r.app_user_id, p.first_name, p.last_name, p.photo_key, r.response, r.guest_count
       from group_event_rsvps r
       join persons_resolved p on p.app_user_id = r.app_user_id
      where r.post_id = $1
      order by r.response, p.first_name, p.last_name`,
    [postId]
  );
  return rows;
}

export function toGroupRsvpDto(row: GroupEventRsvpRow) {
  return {
    appUserId: row.app_user_id,
    name: fullName({ firstName: row.first_name, lastName: row.last_name }),
    thumbUrl: photoUrls(row.photo_key).thumbUrl,
    response: row.response,
    guestCount: row.guest_count,
  };
}
