import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, requireRole, type AppEnv } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import {
  deleteGroupAttachmentFile,
  deletePhoto,
  groupAttachmentFileUrl,
  groupAttachmentPrefix,
  photoChange,
  photoUrls,
} from "../photos";
import { parseLimit } from "./paging";
import {
  assertCanConvertVisibility,
  assertCanDeleteGroup,
  assertCanInvite,
  assertCanModerate,
  assertCanPost,
  assertCanReadGroup,
  assertCanReadGroupContent,
  assertCanReply,
  assertMentionsAreMembers,
  assertValidReplyParent,
  groupAccess,
  GROUP_COLUMNS,
  loadGroupMembers,
  loadGroupRow,
  loadMembership,
  toGroupMemberDto,
  type GroupAccess,
  type GroupRow,
} from "../services/groups";
import {
  GROUP_POST_SELECT,
  loadGroupPostRow,
  toGroupPostDto,
  type GroupPostRow,
} from "../services/group-posts";
import {
  fanOutGroupEventChange,
  fanOutGroupJoinRequest,
  fanOutGroupMention,
  fanOutGroupPost,
  fanOutGroupPostReport,
} from "../services/group-notifications";
import { unreadNotificationCounts } from "../services/notifications";
import { sendToUsers, type PushPayload } from "../services/push";
import {
  groupCreateSchema,
  groupMemberAddSchema,
  groupNotificationPrefUpdateSchema,
  groupPostCreateSchema,
  groupPostReportSchema,
  groupPostUpdateSchema,
  groupRsvpSchema,
  groupSettingsSchema,
  groupUpdateSchema,
  groupVisibilityChangeSchema,
  fullName,
  photoAttachSchema,
  uuidSchema,
  type GroupDto,
  type GroupFileDto,
  type GroupJoinRequestDto,
  type GroupMemberRole,
  type GroupPostDto,
  type GroupPostReportDto,
  type GroupSummaryDto,
} from "../types";

/**
 * Groups: browsing, membership, posts, events and moderation.
 *
 * `services/groups.ts` owns the visibility and permission rules; this file is
 * about which route checks which capability flag before doing anything. See
 * requirements/groups.md for the product rules this is built from.
 */
const routes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

async function loadAccess(
  q: Queryable,
  caller: { appUserId: string; isAdmin: boolean; personId: string | null },
  group: GroupRow
): Promise<GroupAccess> {
  const membership = await loadMembership(q, group.id, caller.appUserId);
  return groupAccess(caller as never, group, membership);
}

function toGroupSummary(
  row: GroupRow & {
    member_count: string;
    unread_count: string;
    pending_join_request_id: string | null;
  },
  access: GroupAccess
): GroupSummaryDto {
  const { thumbUrl, fullUrl } = photoUrls(row.photo_key);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    thumbUrl,
    fullUrl,
    visibility: row.visibility,
    memberCount: Number(row.member_count),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    myRole: access.effectiveRole && access.isMember ? access.membership!.role : null,
    unreadCount: Number(row.unread_count),
    pendingJoinRequestId: row.pending_join_request_id,
  };
}

/**
 * Logs an admin looking at, or acting in, a group they do not belong to --
 * "disclosed in the UI and audited" (requirements/groups.md, Membership &
 * Admins). Fire-and-forget like every other audit write; a failure here must
 * not block the read.
 */
async function logAdminViewIfNeeded(
  db: Queryable,
  caller: Parameters<typeof audit>[1],
  group: GroupRow,
  access: GroupAccess
): Promise<void> {
  if (!access.viewingAsAdmin) return;
  await audit(db, caller, {
    action: "group.adminView",
    entityType: "group",
    entityId: group.id,
    changes: { title: group.title, visibility: group.visibility },
  });
}

// ---------------------------------------------------------------------------
// Browsing and creating
// ---------------------------------------------------------------------------

/**
 * Every group the caller may know exists: Public and Private groups parish-
 * wide, Secret groups only if the caller is a member or a parish admin, and
 * archived groups only if the caller is a member of that one -- "hidden from
 * browse" (requirements/groups-plan.md) for everyone else.
 */
routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = await db.query<
    GroupRow & {
      member_count: string;
      unread_count: string;
      pending_join_request_id: string | null;
      my_role: GroupMemberRole | null;
    }
  >(
    `select ${GROUP_COLUMNS},
            (select count(*) from group_members gm2 where gm2.group_id = g.id) as member_count,
            my.role as my_role,
            -- Only a member has a reading position to be behind on -- a
            -- non-member of a Private group can see that it exists but has no
            -- "unread" of something they were never shown in the first place.
            (case when my.app_user_id is null then 0 else (
              select count(*) from group_posts gp
                where gp.group_id = g.id
                  and gp.parent_post_id is null
                  and (my.last_read_at is null or gp.created_at > my.last_read_at)
                  and gp.author_person_id is distinct from $3::uuid
            ) end) as unread_count,
            (select jr.id from group_join_requests jr
              where jr.group_id = g.id and jr.person_id = $3 and jr.status = 'PENDING') as pending_join_request_id
       from groups g
       left join group_members my on my.group_id = g.id and my.app_user_id = $2
      where g.organization_id = $1
        and (g.visibility <> 'SECRET' or my.app_user_id is not null or $4)
        and (g.archived_at is null or my.app_user_id is not null)
      order by g.title`,
    [organizationId, caller.appUserId, caller.personId, caller.isAdmin]
  );

  const groups: GroupSummaryDto[] = rows.map((row) => {
    const access: GroupAccess = groupAccess(
      caller,
      row,
      row.my_role ? { role: row.my_role, notification_pref: "ALL", last_read_at: null } : null
    );
    return toGroupSummary(row, access);
  });
  return c.json({ groups });
});

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = groupCreateSchema.parse(await c.req.json());

  if (!caller.personId) {
    throw new HTTPException(400, { message: "Your own directory record is missing" });
  }

  const groupId = await db.transaction(async (tx) => {
    const created = await one<{ id: string }>(
      tx,
      `insert into groups (organization_id, title, description, visibility, created_by_person_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [organizationId, payload.title, payload.description, payload.visibility, caller.personId]
    );
    if (!created) throw new HTTPException(500, { message: "Could not create that group" });

    await tx.query(
      `insert into group_members (group_id, app_user_id, person_id, role)
       values ($1, $2, $3, 'ADMIN')`,
      [created.id, caller.appUserId, caller.personId]
    );
    return created.id;
  });

  await audit(db, caller, {
    action: "group.create",
    entityType: "group",
    entityId: groupId,
    changes: { title: payload.title, visibility: payload.visibility },
  });

  return c.json({ id: groupId }, 201);
});

// ---------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------

routes.get("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroup(access);

  const [members, pendingJoinRequests, memberCount, creator] = await Promise.all([
    access.canReadContent ? loadGroupMembers(db, id) : Promise.resolve([]),
    access.canModerate
      ? db
          .query<{
            id: string;
            person_id: string;
            first_name: string;
            last_name: string | null;
            status: GroupJoinRequestDto["status"];
            requested_at: Date | string;
            decided_at: Date | string | null;
          }>(
            `select jr.id, jr.person_id, p.first_name, p.last_name, jr.status, jr.requested_at, jr.decided_at
               from group_join_requests jr
               join persons_resolved p on p.id = jr.person_id
              where jr.group_id = $1 and jr.status = 'PENDING'
              order by jr.requested_at`,
            [id]
          )
          .then(({ rows }) =>
            rows.map(
              (row): GroupJoinRequestDto => ({
                id: row.id,
                groupId: id,
                groupTitle: group.title,
                personId: row.person_id,
                personName: fullName({ firstName: row.first_name, lastName: row.last_name }),
                status: row.status,
                requestedAt: new Date(row.requested_at).toISOString(),
                decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
              })
            )
          )
      : Promise.resolve<GroupJoinRequestDto[]>([]),
    one<{ count: string }>(db, "select count(*) as count from group_members where group_id = $1", [
      id,
    ]),
    group.created_by_person_id
      ? one<{ first_name: string; last_name: string | null }>(
          db,
          "select first_name, last_name from persons_resolved where id = $1",
          [group.created_by_person_id]
        )
      : Promise.resolve(null),
  ]);

  const pendingJoinRequestId = await one<{ id: string }>(
    db,
    `select id from group_join_requests where group_id = $1 and person_id = $2 and status = 'PENDING'`,
    [id, caller.personId]
  );

  // Only a member has a reading position to be behind on -- see the matching
  // comment on GET / for why a non-member's count is not computed at all.
  const unread = access.isMember
    ? await one<{ count: string }>(
        db,
        `select count(*) as count
           from group_posts gp
          where gp.group_id = $1
            and gp.parent_post_id is null
            and ($2::timestamptz is null or gp.created_at > $2::timestamptz)
            and gp.author_person_id is distinct from $3::uuid`,
        [id, access.membership?.last_read_at ?? null, caller.personId]
      )
    : null;

  await logAdminViewIfNeeded(db, caller, group, access);

  const { thumbUrl, fullUrl } = photoUrls(group.photo_key);
  const body: GroupDto = {
    id: group.id,
    title: group.title,
    description: group.description,
    thumbUrl,
    fullUrl,
    visibility: group.visibility,
    memberCount: Number(memberCount?.count ?? 0),
    archivedAt: group.archived_at ? new Date(group.archived_at).toISOString() : null,
    myRole: access.membership?.role ?? null,
    unreadCount: Number(unread?.count ?? 0),
    pendingJoinRequestId: pendingJoinRequestId?.id ?? null,
    organizationId: group.organization_id,
    photoWidth: group.photo_width,
    photoHeight: group.photo_height,
    postingRestricted: group.posting_restricted,
    invitesRestricted: group.invites_restricted,
    repliesRestricted: group.replies_restricted,
    createdByPersonId: group.created_by_person_id,
    createdByName: creator
      ? fullName({ firstName: creator.first_name, lastName: creator.last_name })
      : null,
    createdAt: new Date(group.created_at).toISOString(),
    members: members.map(toGroupMemberDto),
    pendingJoinRequests,
    notificationPref: access.membership?.notification_pref ?? "ALL",
    canPost: access.canPost,
    canInvite: access.canInvite,
    canReply: access.canReply,
    canModerate: access.canModerate,
    canConvertVisibility: access.canConvertTo,
    canArchive: access.canModerate && !group.archived_at,
    canRequestToJoin: access.canRequestToJoin,
    viewingAsAdmin: access.viewingAsAdmin,
  };
  return c.json(body);
});

routes.patch("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = groupUpdateSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  await db.query("update groups set title = $2, description = $3 where id = $1", [
    id,
    payload.title,
    payload.description,
  ]);
  await audit(db, caller, {
    action: "group.update",
    entityType: "group",
    entityId: id,
    changes: payload,
  });
  return c.body(null, 204);
});

routes.put("/:id/photo", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { photoKey, photoWidth, photoHeight } = photoAttachSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  if (photoKey && !photoKey.startsWith(`photos/${organizationId}/group/${id}/`)) {
    throw new HTTPException(400, { message: "That photo does not belong to this group" });
  }

  const width = photoKey ? (photoWidth ?? null) : null;
  const height = photoKey ? (photoHeight ?? null) : null;

  await db.query(
    "update groups set photo_key = $2, photo_width = $3, photo_height = $4 where id = $1",
    [id, photoKey, width, height]
  );

  const change = photoChange(group.photo_key, photoKey);
  if (change) {
    await audit(db, caller, {
      action: "group.update",
      entityType: "group",
      entityId: id,
      changes: { photo: change },
    });
  }
  if (group.photo_key && group.photo_key !== photoKey) await deletePhoto(group.photo_key);

  return c.json(photoUrls(photoKey));
});

routes.post("/:id/visibility", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { visibility } = groupVisibilityChangeSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanConvertVisibility(access, visibility);

  await db.query("update groups set visibility = $2 where id = $1", [id, visibility]);
  await audit(db, caller, {
    action: "group.convertVisibility",
    entityType: "group",
    entityId: id,
    changes: { from: group.visibility, to: visibility },
  });
  return c.json({ visibility });
});

routes.post("/:id/settings", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = groupSettingsSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  await db.query(
    `update groups
        set posting_restricted = $2, invites_restricted = $3, replies_restricted = $4
      where id = $1`,
    [id, payload.postingRestricted, payload.invitesRestricted, payload.repliesRestricted]
  );
  await audit(db, caller, {
    action: "group.update",
    entityType: "group",
    entityId: id,
    changes: payload,
  });
  return c.body(null, 204);
});

routes.post("/:id/archive", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  await db.query("update groups set archived_at = coalesce(archived_at, now()) where id = $1", [
    id,
  ]);
  await audit(db, caller, {
    action: "group.archive",
    entityType: "group",
    entityId: id,
    changes: { title: group.title },
  });
  return c.body(null, 204);
});

/** Hard delete. Parish-admin only -- see assertCanDeleteGroup. */
routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanDeleteGroup(access);

  const { rows: attachments } = await db.query<{ photo_key: string; kind: "IMAGE" | "FILE" }>(
    `select a.photo_key, a.kind
       from group_post_attachments a
       join group_posts p on p.id = a.post_id
      where p.group_id = $1`,
    [id]
  );

  await db.query("delete from groups where id = $1", [id]);
  await audit(db, caller, {
    action: "group.delete",
    entityType: "group",
    entityId: id,
    changes: { title: group.title },
  });

  if (group.photo_key) await deletePhoto(group.photo_key);
  for (const attachment of attachments) {
    if (attachment.kind === "IMAGE") await deletePhoto(attachment.photo_key);
    else await deleteGroupAttachmentFile(attachment.photo_key);
  }

  return c.body(null, 204);
});

routes.put("/:id/notification-preference", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { notificationPref } = groupNotificationPrefUpdateSchema.parse(await c.req.json());

  await loadGroupRow(db, id, organizationId);
  const membership = await loadMembership(db, id, caller.appUserId);
  if (!membership) throw new HTTPException(403, { message: "You are not a member of this group" });

  await db.query(
    "update group_members set notification_pref = $3 where group_id = $1 and app_user_id = $2",
    [id, caller.appUserId, notificationPref]
  );
  return c.json({ notificationPref });
});

/** Marks everything posted so far as read, for the per-group unread badge. */
routes.post("/:id/read", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  await loadGroupRow(db, id, organizationId);
  await db.query(
    "update group_members set last_read_at = now() where group_id = $1 and app_user_id = $2",
    [id, caller.appUserId]
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Join a Public group outright, or add someone else -- the instant-add invite. */
routes.post("/:id/members", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { personId } = groupMemberAddSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);

  const selfJoin = personId === caller.personId;
  if (selfJoin) {
    if (group.visibility !== "PUBLIC") {
      throw new HTTPException(403, { message: "Ask to join or get invited to this group" });
    }
    if (group.archived_at) throw new HTTPException(409, { message: "This group is archived" });
  } else {
    assertCanInvite(access);
  }

  const person = await one<{ app_user_id: string | null; organization_id: string }>(
    db,
    "select app_user_id, organization_id from persons where id = $1 and deleted_at is null",
    [personId]
  );
  if (!person || person.organization_id !== organizationId) {
    throw new HTTPException(404, { message: "That person was not found" });
  }
  if (!person.app_user_id) {
    throw new HTTPException(400, { message: "Only people with an account can join a group" });
  }

  const existing = await one<{ app_user_id: string }>(
    db,
    "select app_user_id from group_members where group_id = $1 and app_user_id = $2",
    [id, person.app_user_id]
  );
  if (existing) throw new HTTPException(409, { message: "They are already in this group" });

  await db.transaction(async (tx) => {
    await tx.query(
      "insert into group_members (group_id, app_user_id, person_id) values ($1, $2, $3)",
      [id, person.app_user_id, personId]
    );
    await tx.query(
      `update group_join_requests
          set status = 'APPROVED', decided_at = now(), decided_by_person_id = $3
        where group_id = $1 and person_id = $2 and status = 'PENDING'`,
      [id, personId, caller.personId]
    );
  });

  await audit(db, caller, {
    action: "group.addMember",
    entityType: "group",
    entityId: id,
    changes: { personId, selfJoin },
  });
  return c.body(null, 204);
});

/** Leaving the group yourself -- separate from removal, for the sole-admin guard below. */
routes.post("/:id/leave", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  await loadGroupRow(db, id, organizationId);
  const membership = await loadMembership(db, id, caller.appUserId);
  if (!membership) throw new HTTPException(404, { message: "You are not a member of this group" });

  if (membership.role === "ADMIN") {
    const otherAdmin = await one<{ app_user_id: string }>(
      db,
      "select app_user_id from group_members where group_id = $1 and role = 'ADMIN' and app_user_id <> $2",
      [id, caller.appUserId]
    );
    if (!otherAdmin) {
      throw new HTTPException(409, {
        message: "Promote another admin before you leave — a group needs at least one",
      });
    }
  }

  await db.query("delete from group_members where group_id = $1 and app_user_id = $2", [
    id,
    caller.appUserId,
  ]);
  await audit(db, caller, {
    action: "group.leave",
    entityType: "group",
    entityId: id,
    changes: { personId: caller.personId },
  });
  return c.body(null, 204);
});

/** Removing somebody else. Use POST /:id/leave to remove yourself. */
routes.delete("/:id/members/:personId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const personId = uuidSchema.parse(c.req.param("personId"));

  if (personId === caller.personId) {
    throw new HTTPException(400, { message: "Use the leave action to remove yourself" });
  }

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  const member = await one<{ app_user_id: string }>(
    db,
    "select app_user_id from group_members where group_id = $1 and person_id = $2",
    [id, personId]
  );
  if (!member) throw new HTTPException(404, { message: "That person is not in this group" });

  await db.query("delete from group_members where group_id = $1 and app_user_id = $2", [
    id,
    member.app_user_id,
  ]);
  await audit(db, caller, {
    action: "group.removeMember",
    entityType: "group",
    entityId: id,
    changes: { personId },
  });
  return c.body(null, 204);
});

routes.post("/:id/members/:personId/role", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const personId = uuidSchema.parse(c.req.param("personId"));
  const role = (await c.req.json().then((b) => b.role)) as GroupMemberRole;
  if (role !== "ADMIN" && role !== "MEMBER") {
    throw new HTTPException(400, { message: "role must be ADMIN or MEMBER" });
  }

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  const member = await one<{ app_user_id: string; role: GroupMemberRole }>(
    db,
    "select app_user_id, role from group_members where group_id = $1 and person_id = $2",
    [id, personId]
  );
  if (!member) throw new HTTPException(404, { message: "That person is not in this group" });

  if (role === "MEMBER" && member.role === "ADMIN") {
    const otherAdmin = await one<{ app_user_id: string }>(
      db,
      "select app_user_id from group_members where group_id = $1 and role = 'ADMIN' and app_user_id <> $2",
      [id, member.app_user_id]
    );
    if (!otherAdmin) {
      throw new HTTPException(409, { message: "A group needs at least one admin" });
    }
  }

  await db.query("update group_members set role = $3 where group_id = $1 and app_user_id = $2", [
    id,
    member.app_user_id,
    role,
  ]);
  const promoting = role === "ADMIN";
  await audit(db, caller, {
    action: promoting ? "group.promoteAdmin" : "group.demoteAdmin",
    entityType: "group",
    entityId: id,
    changes: { personId },
  });
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Join requests (Private groups)
// ---------------------------------------------------------------------------

routes.post("/:id/join-requests", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  if (!access.canRequestToJoin) {
    throw new HTTPException(400, { message: "You cannot request to join this group" });
  }

  const created = await one<{ id: string }>(
    db,
    `insert into group_join_requests (organization_id, group_id, person_id)
     values ($1, $2, $3)
     on conflict do nothing
     returning id`,
    [organizationId, id, caller.personId]
  );
  if (!created)
    throw new HTTPException(409, { message: "You have already asked to join this group" });

  const notified = await fanOutGroupJoinRequest(db, { groupId: id, organizationId });
  await pushGroupActivity(db, notified, group.title, id, "join-request");

  return c.json({ status: "PENDING" as const, id: created.id }, 201);
});

routes.post("/:id/join-requests/:requestId/:decision{approve|deny}", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const requestId = uuidSchema.parse(c.req.param("requestId"));
  const approve = c.req.param("decision") === "approve";

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  const request = await one<{ id: string; person_id: string; status: string }>(
    db,
    "select id, person_id, status from group_join_requests where id = $1 and group_id = $2",
    [requestId, id]
  );
  if (!request) throw new HTTPException(404, { message: "Request not found" });
  if (request.status !== "PENDING")
    throw new HTTPException(409, { message: "That request has already been decided" });

  await db.transaction(async (tx) => {
    await tx.query(
      `update group_join_requests set status = $2, decided_at = now(), decided_by_person_id = $3 where id = $1`,
      [requestId, approve ? "APPROVED" : "DENIED", caller.personId]
    );
    if (approve) {
      const person = await one<{ app_user_id: string | null }>(
        tx,
        "select app_user_id from persons where id = $1",
        [request.person_id]
      );
      if (person?.app_user_id) {
        await tx.query(
          "insert into group_members (group_id, app_user_id, person_id) values ($1, $2, $3) on conflict do nothing",
          [id, person.app_user_id, request.person_id]
        );
      }
    }
  });

  await audit(db, caller, {
    action: approve ? "group.approveJoinRequest" : "group.denyJoinRequest",
    entityType: "group",
    entityId: id,
    changes: { personId: request.person_id },
  });
  return c.json({ status: approve ? "APPROVED" : "DENIED" });
});

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

const DEFAULT_POST_LIMIT = 30;
const MAX_POST_LIMIT = 100;

routes.get("/:id/posts", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const limit = parseLimit(c.req.query("limit"), DEFAULT_POST_LIMIT, MAX_POST_LIMIT);

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const params: unknown[] = [caller.appUserId, id];
  let cursorClause = "";
  const cursorCreatedAt = c.req.query("cursorCreatedAt");
  const cursorId = c.req.query("cursorId");
  if (cursorCreatedAt && cursorId) {
    params.push(cursorCreatedAt, cursorId);
    cursorClause = `and (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await db.query<GroupPostRow>(
    `${GROUP_POST_SELECT}
      where p.group_id = $2 and p.parent_post_id is null
      ${cursorClause}
      order by p.created_at desc, p.id desc
      limit $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return c.json({
    posts: page.map((row) => toGroupPostDto(row, access, caller.personId)),
    nextCursor:
      hasMore && last ? { createdAt: new Date(last.created_at).toISOString(), id: last.id } : null,
  });
});

routes.get("/:id/posts/:postId/replies", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const postId = uuidSchema.parse(c.req.param("postId"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const { rows } = await db.query<GroupPostRow>(
    `${GROUP_POST_SELECT}
      where p.group_id = $2 and p.parent_post_id = $3
      order by p.created_at asc
      limit 500`,
    [caller.appUserId, id, postId]
  );

  const replies: GroupPostDto[] = rows.map((row) => toGroupPostDto(row, access, caller.personId));
  return c.json({ replies });
});

routes.get("/:id/files", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const limit = parseLimit(c.req.query("limit"), DEFAULT_POST_LIMIT, MAX_POST_LIMIT);

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const { rows } = await db.query<{
    post_id: string;
    post_created_at: Date | string;
    author_first_name: string;
    author_last_name: string | null;
    id: string;
    kind: "IMAGE" | "FILE";
    filename: string;
    content_type: string;
    byte_size: number;
    photo_key: string;
    width: number | null;
    height: number | null;
  }>(
    `select p.id as post_id, p.created_at as post_created_at,
            a.first_name as author_first_name, a.last_name as author_last_name,
            att.id, att.kind, att.filename, att.content_type, att.byte_size, att.photo_key, att.width, att.height
       from group_post_attachments att
       join group_posts p on p.id = att.post_id
       join persons_resolved a on a.id = p.author_person_id
      where p.group_id = $1 and p.deleted_at is null
      order by p.created_at desc, att.position
      limit $2`,
    [id, limit]
  );

  const files: GroupFileDto[] = rows.map((row) => {
    const isImage = row.kind === "IMAGE";
    const { thumbUrl, fullUrl } = isImage
      ? photoUrls(row.photo_key)
      : { thumbUrl: null, fullUrl: null };
    return {
      postId: row.post_id,
      postCreatedAt: new Date(row.post_created_at).toISOString(),
      authorName: fullName({ firstName: row.author_first_name, lastName: row.author_last_name }),
      attachment: {
        id: row.id,
        kind: row.kind,
        filename: row.filename,
        contentType: row.content_type,
        byteSize: row.byte_size,
        thumbUrl,
        fullUrl,
        width: row.width,
        height: row.height,
        downloadUrl: isImage ? null : groupAttachmentFileUrl(row.photo_key),
      },
    };
  });
  return c.json({ files });
});

routes.get("/:id/events", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const { rows } = await db.query<GroupPostRow>(
    `${GROUP_POST_SELECT}
      where p.group_id = $2 and p.kind = 'EVENT' and p.deleted_at is null
      order by (select ge2.event_date from group_events ge2 where ge2.post_id = p.id) desc
      limit 200`,
    [caller.appUserId, id]
  );

  const events = rows.map((row) => toGroupPostDto(row, access, caller.personId));
  return c.json({ events });
});

/** Every attached key must be one this caller uploaded via POST /uploads/group-attachment. */
function assertAttachmentsBelongToCaller(
  organizationId: string,
  personId: string,
  photoKey: string
): void {
  const prefix = groupAttachmentPrefix(organizationId, personId);
  if (!photoKey.startsWith(prefix)) {
    throw new HTTPException(400, { message: "That attachment does not belong to this post" });
  }
}

routes.post("/:id/posts", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = groupPostCreateSchema.parse(await c.req.json());

  if (!caller.personId)
    throw new HTTPException(400, { message: "Your own directory record is missing" });

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);

  if (payload.parentPostId) {
    assertCanReply(access);
    await assertValidReplyParent(db, id, payload.parentPostId);
  } else {
    assertCanPost(access);
  }

  for (const attachment of payload.attachments) {
    assertAttachmentsBelongToCaller(organizationId, caller.personId, attachment.photoKey);
  }
  await assertMentionsAreMembers(db, id, payload.mentionedAppUserIds);

  let notifiedPost: string[] = [];
  let notifiedMention: string[] = [];

  const postId = await db.transaction(async (tx) => {
    const created = await one<{ id: string }>(
      tx,
      `insert into group_posts (group_id, author_person_id, parent_post_id, kind, body)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [id, caller.personId, payload.parentPostId ?? null, payload.kind, payload.body ?? null]
    );
    if (!created) throw new HTTPException(500, { message: "Could not create that post" });

    if (payload.kind === "EVENT" && payload.event) {
      await tx.query(
        `insert into group_events (post_id, title, description, event_date, start_time, end_time, location)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          created.id,
          payload.event.eventTitle,
          payload.event.eventDescription,
          payload.event.eventDate,
          payload.event.startTime ?? null,
          payload.event.endTime ?? null,
          payload.event.location,
        ]
      );
    }

    if (payload.attachments.length > 0) {
      await tx.query(
        `insert into group_post_attachments
           (post_id, photo_key, kind, filename, content_type, byte_size, width, height, position)
         select $1, key, kind, filename, content_type, byte_size, width, height, position - 1
           from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[])
                with ordinality as t(key, kind, filename, content_type, byte_size, width, height, position)`,
        [
          created.id,
          payload.attachments.map((a) => a.photoKey),
          payload.attachments.map((a) => a.kind),
          payload.attachments.map((a) => a.filename),
          payload.attachments.map((a) => a.contentType),
          payload.attachments.map((a) => a.byteSize),
          payload.attachments.map((a) => a.width ?? null),
          payload.attachments.map((a) => a.height ?? null),
        ]
      );
    }

    if (payload.mentionedAppUserIds.length > 0) {
      await tx.query(
        `insert into group_post_mentions (post_id, app_user_id)
         select $1, u from unnest($2::uuid[]) as u`,
        [created.id, payload.mentionedAppUserIds]
      );
    }

    notifiedPost = await fanOutGroupPost(tx, {
      groupId: id,
      groupPostId: created.id,
      organizationId,
      actingAppUserId: caller.appUserId,
      mentionedAppUserIds: payload.mentionedAppUserIds,
    });
    notifiedMention = await fanOutGroupMention(tx, {
      groupId: id,
      groupPostId: created.id,
      organizationId,
      actingAppUserId: caller.appUserId,
      mentionedAppUserIds: payload.mentionedAppUserIds,
    });

    return created.id;
  });

  await pushGroupActivity(db, [...notifiedPost, ...notifiedMention], group.title, id, "post");

  const row = await loadGroupPostRow(db, caller.appUserId, postId, id);
  return c.json(toGroupPostDto(row!, access, caller.personId), 201);
});

routes.patch("/:id/posts/:postId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const postId = uuidSchema.parse(c.req.param("postId"));
  const payload = groupPostUpdateSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  const row = await loadGroupPostRow(db, caller.appUserId, postId, id);
  if (!row) throw new HTTPException(404, { message: "Post not found" });
  if (row.deleted_at) throw new HTTPException(409, { message: "That post has been deleted" });
  if (row.author_person_id !== caller.personId) {
    throw new HTTPException(403, { message: "You can only edit your own posts" });
  }

  await db.transaction(async (tx) => {
    if (payload.body !== undefined) {
      await tx.query("update group_posts set body = $2, edited_at = now() where id = $1", [
        postId,
        payload.body,
      ]);
    }
    if (payload.event && row.kind === "EVENT") {
      await tx.query(
        `update group_events
            set title = $2, description = $3, event_date = $4, start_time = $5, end_time = $6, location = $7
          where post_id = $1`,
        [
          postId,
          payload.event.eventTitle,
          payload.event.eventDescription,
          payload.event.eventDate,
          payload.event.startTime ?? null,
          payload.event.endTime ?? null,
          payload.event.location,
        ]
      );
      await tx.query("update group_posts set edited_at = now() where id = $1", [postId]);
    }
  });

  if (payload.event && row.kind === "EVENT") {
    const notified = await fanOutGroupEventChange(db, {
      groupId: id,
      groupPostId: postId,
      organizationId,
      actingAppUserId: caller.appUserId,
    });
    await pushGroupActivity(db, notified, group.title, id, "event-change");
  }

  const updated = await loadGroupPostRow(db, caller.appUserId, postId, id);
  return c.json(toGroupPostDto(updated!, access, caller.personId));
});

routes.delete("/:id/posts/:postId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const postId = uuidSchema.parse(c.req.param("postId"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  const row = await loadGroupPostRow(db, caller.appUserId, postId, id);
  if (!row) throw new HTTPException(404, { message: "Post not found" });
  if (row.deleted_at) return c.body(null, 204);

  const isMine = row.author_person_id === caller.personId;
  if (!isMine && !access.canModerate) {
    throw new HTTPException(403, { message: "That post is not yours to remove" });
  }

  await db.query(
    "update group_posts set deleted_at = now(), deleted_by_person_id = $2 where id = $1",
    [postId, caller.personId]
  );

  if (!isMine) {
    await audit(db, caller, {
      action: "group.post.adminDelete",
      entityType: "groupPost",
      entityId: postId,
      changes: { groupId: id, authorPersonId: row.author_person_id },
    });
  }

  return c.body(null, 204);
});

routes.put("/:id/posts/:postId/rsvp", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const postId = uuidSchema.parse(c.req.param("postId"));
  const payload = groupRsvpSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const row = await loadGroupPostRow(db, caller.appUserId, postId, id);
  if (row?.kind !== "EVENT") throw new HTTPException(404, { message: "Event not found" });

  await db.query(
    `insert into group_event_rsvps (post_id, app_user_id, response, guest_count)
     values ($1, $2, $3, $4)
     on conflict (post_id, app_user_id) do update
       set response = excluded.response, guest_count = excluded.guest_count, updated_at = now()`,
    [postId, caller.appUserId, payload.response, payload.guestCount]
  );

  const updated = await loadGroupPostRow(db, caller.appUserId, postId, id);
  return c.json(toGroupPostDto(updated!, access, caller.personId));
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

routes.post("/:id/posts/:postId/report", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const postId = uuidSchema.parse(c.req.param("postId"));
  const payload = groupPostReportSchema.parse(await c.req.json());

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanReadGroupContent(access);

  const row = await loadGroupPostRow(db, caller.appUserId, postId, id);
  if (!row || row.deleted_at) throw new HTTPException(404, { message: "Post not found" });
  if (row.author_person_id === caller.personId) {
    throw new HTTPException(400, { message: "You cannot report your own post" });
  }

  const excerpt =
    row.kind === "EVENT" ? `[Event] ${row.event_title ?? ""}` : (row.body ?? "").slice(0, 280);

  const created = await one<{ id: string }>(
    db,
    `insert into group_post_reports
       (group_id, post_id, post_excerpt, reporter_app_user_id, reporter_person_id, reason)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing
     returning id`,
    [id, postId, excerpt, caller.appUserId, caller.personId, payload.reason]
  );
  if (!created) throw new HTTPException(409, { message: "You have already reported this post" });

  await audit(db, caller, {
    action: "group.post.report",
    entityType: "groupPost",
    entityId: postId,
    changes: { groupId: id },
  });

  const notified = await fanOutGroupPostReport(db, {
    groupId: id,
    groupPostId: postId,
    organizationId,
    reporterAppUserId: caller.appUserId,
  });
  await pushGroupActivity(db, notified, group.title, id, "report");

  return c.body(null, 204);
});

interface ReportRow {
  id: string;
  group_id: string;
  group_title: string;
  post_id: string | null;
  post_excerpt: string;
  reporter_first_name: string | null;
  reporter_last_name: string | null;
  reason: string | null;
  status: GroupPostReportDto["status"];
  created_at: Date | string;
}

const REPORT_SELECT = `
  select r.id, r.group_id, g.title as group_title, r.post_id, r.post_excerpt,
         p.first_name as reporter_first_name, p.last_name as reporter_last_name,
         r.reason, r.status, r.created_at
    from group_post_reports r
    join groups g on g.id = r.group_id
    left join persons_resolved p on p.id = r.reporter_person_id
`;

function toReportDto(row: ReportRow): GroupPostReportDto {
  return {
    id: row.id,
    groupId: row.group_id,
    groupTitle: row.group_title,
    postId: row.post_id,
    postExcerpt: row.post_excerpt,
    reporterName:
      row.reporter_first_name !== null
        ? fullName({ firstName: row.reporter_first_name, lastName: row.reporter_last_name })
        : null,
    reason: row.reason,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

routes.get("/:id/reports", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  const { rows } = await db.query<ReportRow>(
    `${REPORT_SELECT} where r.group_id = $1 and r.status = 'PENDING' order by r.created_at`,
    [id]
  );
  return c.json({ reports: rows.map(toReportDto) });
});

/** Every open report parish-wide, for the admin-only moderation queue. */
routes.get("/reports", requireRole("ADMIN"), async (c) => {
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = await db.query<ReportRow>(
    `${REPORT_SELECT} where g.organization_id = $1 and r.status = 'PENDING' order by r.created_at`,
    [organizationId]
  );
  return c.json({ reports: rows.map(toReportDto) });
});

routes.post("/:id/reports/:reportId/:decision{dismiss|delete}", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const reportId = uuidSchema.parse(c.req.param("reportId"));
  const deletePost = c.req.param("decision") === "delete";

  const group = await loadGroupRow(db, id, organizationId);
  const access = await loadAccess(db, caller, group);
  assertCanModerate(access);

  const report = await one<{ id: string; post_id: string | null; status: string }>(
    db,
    "select id, post_id, status from group_post_reports where id = $1 and group_id = $2",
    [reportId, id]
  );
  if (!report) throw new HTTPException(404, { message: "Report not found" });
  if (report.status !== "PENDING")
    throw new HTTPException(409, { message: "That report was already resolved" });

  await db.transaction(async (tx) => {
    if (deletePost && report.post_id) {
      await tx.query(
        "update group_posts set deleted_at = now(), deleted_by_person_id = $2 where id = $1 and deleted_at is null",
        [report.post_id, caller.personId]
      );
    }
    await tx.query(
      `update group_post_reports
          set status = $2, decided_at = now(), decided_by_person_id = $3
        where id = $1`,
      [reportId, deletePost ? "RESOLVED" : "DISMISSED", caller.personId]
    );
  });

  await audit(db, caller, {
    action: deletePost ? "group.post.resolveReport" : "group.post.dismissReport",
    entityType: "groupPost",
    entityId: report.post_id,
    changes: { groupId: id, reportId },
  });

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * One tag per group ("group-{id}") so a group's own notification replaces its
 * own previous one without displacing Prayer Requests' or another group's --
 * the same reasoning PUSH_KINDS gives in routes/prayer-requests.ts. The body
 * is a count and the group's title, never the message -- a Secret group's text
 * must not reach a lock screen.
 */
async function pushGroupActivity(
  db: Queryable,
  notified: string[],
  groupTitle: string,
  groupId: string,
  kind: "post" | "join-request" | "report" | "event-change"
): Promise<void> {
  if (notified.length === 0) return;
  const type =
    kind === "post"
      ? "GROUP_POST"
      : kind === "join-request"
        ? "GROUP_JOIN_REQUEST"
        : kind === "report"
          ? "GROUP_POST_REPORT"
          : "GROUP_EVENT";
  const counts = await unreadNotificationCounts(db, notified, type);
  const BODY: Record<typeof kind, (count: number) => string> = {
    post: (count) => `${count} new message${count === 1 ? "" : "s"} in ${groupTitle}`,
    "join-request": () => `Someone wants to join ${groupTitle}`,
    report: () => `A post in ${groupTitle} was reported`,
    "event-change": () => `An event in ${groupTitle} changed`,
  };
  const payloads = new Map<string, PushPayload>(
    notified.map((appUserId) => {
      const count = counts.get(appUserId) ?? 1;
      return [
        appUserId,
        {
          title: "Groups",
          body: BODY[kind](count),
          url: `/groups/${groupId}`,
          tag: `group-${groupId}`,
        },
      ];
    })
  );
  await sendToUsers(db, payloads);
}

export default routes;
