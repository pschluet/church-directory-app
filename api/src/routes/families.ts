import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv, type Caller } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { assertCanEditFamily, canEditFamily } from "../services/access";
import { clearInheritanceFor } from "../services/inheritance";
import { cancelPendingJoinRequests } from "../services/membership";
import { PERSON_COLUMNS, PERSON_ORDER, toSummaries, type PersonRow } from "../services/persons";
import { deletePhoto, presignDownload } from "../photos";
import {
  familyCreateSchema,
  familyMemberSchema,
  familyWriteSchema,
  fullName,
  uuidSchema,
  type FamilyDto,
  type FamilySummaryDto,
  type JoinRequestDto,
} from "../types";

/**
 * Families, and the gated join flow.
 *
 * "Any user can create a family, and other users can associate themselves with
 * any family" -- but joining is a request that an existing member (or an admin)
 * approves, rather than something anyone can do unilaterally. Without that,
 * any parishioner could add themselves to your family and immediately start
 * editing your children's records.
 */
const routes = new Hono<AppEnv>();

interface FamilyRow {
  id: string;
  organization_id: string;
  name: string;
  photo_key: string | null;
}

async function loadFamilyRow(
  q: Queryable,
  familyId: string,
  organizationId: string
): Promise<FamilyRow> {
  const row = await one<FamilyRow>(
    q,
    "select id, organization_id, name, photo_key from families where id = $1 and organization_id = $2",
    [familyId, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Family not found" });
  return row;
}

interface JoinRequestRow {
  id: string;
  family_id: string;
  family_name: string;
  person_id: string;
  first_name: string;
  last_name: string | null;
  status: JoinRequestDto["status"];
  requested_at: Date | string;
  decided_at: Date | string | null;
}

const JOIN_REQUEST_SELECT = `
  select jr.id,
         jr.family_id,
         f.name as family_name,
         jr.person_id,
         p.first_name,
         p.last_name,
         jr.status,
         jr.requested_at,
         jr.decided_at
    from family_join_requests jr
    join families f on f.id = jr.family_id
    join persons_resolved p on p.id = jr.person_id
`;

function toJoinRequest(row: JoinRequestRow): JoinRequestDto {
  return {
    id: row.id,
    familyId: row.family_id,
    familyName: row.family_name,
    personId: row.person_id,
    personName: fullName({ firstName: row.first_name, lastName: row.last_name }),
    status: row.status,
    requestedAt: new Date(row.requested_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

/** All families in the organization, for the families page and the join picker. */
routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  // The caller's own pending request comes from a scalar subquery rather than a
  // join: joining family_join_requests alongside the persons join would fan the
  // rows out and make member_count look wrong, even where it isn't.
  const { rows } = await db.query<{
    id: string;
    name: string;
    member_count: string;
    member_names: string[] | null;
    pending_join_request_id: string | null;
  }>(
    `select f.id,
            f.name,
            count(p.id) filter (where p.deleted_at is null) as member_count,
            array_remove(
              array_agg(p.first_name order by p.last_name nulls last, p.first_name)
                filter (where p.deleted_at is null),
              null
            ) as member_names,
            (select jr.id
               from family_join_requests jr
              where jr.family_id = f.id
                and jr.person_id = $2
                and jr.status = 'PENDING') as pending_join_request_id
       from families f
       left join persons p on p.family_id = f.id
      where f.organization_id = $1
      group by f.id, f.name
      order by f.name`,
    [organizationId, caller.personId]
  );

  const families: FamilySummaryDto[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: Number(r.member_count),
    memberNames: (r.member_names ?? []).slice(0, 3),
    pendingJoinRequestId: r.pending_join_request_id,
  }));
  return c.json({ families });
});

routes.get("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const family = await loadFamilyRow(db, id, organizationId);
  const canEdit = canEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  const { rows: memberRows } = await db.query<PersonRow>(
    `select ${PERSON_COLUMNS}
       from persons_resolved r
      where r.family_id = $1 and r.deleted_at is null
      ${PERSON_ORDER}`,
    [id]
  );

  // Pending requests are only anyone's business if they can act on them.
  const pending = canEdit
    ? (
        await db.query<JoinRequestRow>(
          `${JOIN_REQUEST_SELECT} where jr.family_id = $1 and jr.status = 'PENDING'
            order by jr.requested_at`,
          [id]
        )
      ).rows.map(toJoinRequest)
    : [];

  const body: FamilyDto = {
    id: family.id,
    organizationId: family.organization_id,
    name: family.name,
    photoUrl: await presignDownload(family.photo_key),
    members: await toSummaries(caller, memberRows),
    pendingJoinRequests: pending,
    canEdit,
    isMember: caller.familyId === family.id,
  };
  return c.json(body);
});

/**
 * Creating a family normally puts the creator in it, so it is never left
 * without someone who can administer it. An admin can opt out of that with
 * `join: false` to set a family up for someone else -- the invite form needs
 * something to point at before that household has any members.
 */
routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = familyCreateSchema.parse(await c.req.json());

  if (!payload.join && !caller.isAdmin) {
    throw new HTTPException(403, {
      message: "Only an administrator can create a family without joining it",
    });
  }
  if (payload.join && !caller.personId) {
    throw new HTTPException(400, {
      message: "Your own directory record is missing, so a family cannot be created",
    });
  }

  const family = await db.transaction(async (tx) => {
    const created = await one<{ id: string }>(
      tx,
      `insert into families (organization_id, name, created_by_person_id)
       values ($1, $2, $3)
       returning id`,
      [organizationId, payload.name, caller.personId]
    );
    if (!created) throw new HTTPException(500, { message: "Could not create that family" });

    if (payload.join) {
      // Leaving one family for another drops inheritance from the old one.
      await clearInheritanceFor(tx, caller.personId!);
      await tx.query("update persons set family_id = $2 where id = $1", [
        caller.personId,
        created.id,
      ]);
      // They are in a family now, so anywhere else they asked to join is moot.
      await cancelPendingJoinRequests(tx, caller.personId!, created.id);
    }
    return created;
  });

  await audit(db, caller, {
    action: "family.create",
    entityType: "family",
    entityId: family.id,
    changes: payload,
  });

  return c.json({ id: family.id, name: payload.name }, 201);
});

routes.patch("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = familyWriteSchema.parse(await c.req.json());

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  await db.query("update families set name = $2 where id = $1", [id, payload.name]);
  await audit(db, caller, {
    action: "family.update",
    entityType: "family",
    entityId: id,
    changes: payload,
  });
  return c.json({ id, name: payload.name });
});

routes.put("/:id/photo", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { photoKey } = (await c.req.json()) as { photoKey: string | null };

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  if (photoKey && !photoKey.startsWith(`photos/${organizationId}/family/${id}/`)) {
    throw new HTTPException(400, { message: "That photo does not belong to this family" });
  }

  await db.query("update families set photo_key = $2 where id = $1", [id, photoKey]);
  if (family.photo_key && family.photo_key !== photoKey) await deletePhoto(family.photo_key);

  return c.json({ id, photoUrl: await presignDownload(photoKey) });
});

// ---------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------

/** Ask to be added to a family. */
routes.post("/:id/join-requests", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  if (!caller.personId) {
    throw new HTTPException(400, { message: "Your own directory record is missing" });
  }
  await loadFamilyRow(db, id, organizationId);

  if (caller.familyId === id) {
    throw new HTTPException(409, { message: "You are already in this family" });
  }

  // An admin does not need to ask; and someone in the family can add
  // themselves back without ceremony.
  if (caller.isAdmin) {
    await joinFamily(db, caller, caller.personId, id);
    await audit(db, caller, {
      action: "family.join",
      entityType: "family",
      entityId: id,
      changes: { personId: caller.personId, viaApproval: false },
    });
    return c.json({ status: "APPROVED" as const }, 201);
  }

  const created = await one<{ id: string }>(
    db,
    `insert into family_join_requests (organization_id, family_id, person_id)
     values ($1, $2, $3)
     on conflict do nothing
     returning id`,
    [organizationId, id, caller.personId]
  );
  if (!created) {
    throw new HTTPException(409, { message: "You have already asked to join this family" });
  }

  return c.json({ status: "PENDING" as const, id: created.id }, 201);
});

/** Requests waiting on the caller: for their own family, or org-wide for admins. */
routes.get("/join-requests/pending", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = caller.isAdmin
    ? await db.query<JoinRequestRow>(
        `${JOIN_REQUEST_SELECT} where jr.organization_id = $1 and jr.status = 'PENDING'
          order by jr.requested_at`,
        [organizationId]
      )
    : caller.familyId
      ? await db.query<JoinRequestRow>(
          `${JOIN_REQUEST_SELECT} where jr.family_id = $1 and jr.status = 'PENDING'
            order by jr.requested_at`,
          [caller.familyId]
        )
      : { rows: [] };

  return c.json({ joinRequests: rows.map(toJoinRequest) });
});

routes.post("/join-requests/:requestId/:decision{approve|deny}", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const requestId = uuidSchema.parse(c.req.param("requestId"));
  const approve = c.req.param("decision") === "approve";

  const request = await one<{
    id: string;
    family_id: string;
    person_id: string;
    organization_id: string;
    status: string;
  }>(
    db,
    `select id, family_id, person_id, organization_id, status
       from family_join_requests
      where id = $1 and organization_id = $2`,
    [requestId, organizationId]
  );
  if (!request) throw new HTTPException(404, { message: "Request not found" });
  if (request.status !== "PENDING") {
    throw new HTTPException(409, { message: "That request has already been decided" });
  }

  assertCanEditFamily(caller, {
    id: request.family_id,
    organizationId: request.organization_id,
  });

  await db.transaction(async (tx) => {
    await tx.query(
      `update family_join_requests
          set status = $2, decided_at = now(), decided_by_person_id = $3
        where id = $1`,
      [requestId, approve ? "APPROVED" : "DENIED", caller.personId]
    );
    if (approve) await joinFamily(tx, caller, request.person_id, request.family_id);
  });

  await audit(db, caller, {
    action: approve ? "family.joinRequest.approve" : "family.joinRequest.deny",
    entityType: "family",
    entityId: request.family_id,
    changes: { personId: request.person_id },
  });

  return c.json({ status: approve ? "APPROVED" : "DENIED" });
});

/**
 * People who could be added to a family: no account, no family, same parish.
 * Anyone with an account joins through a request instead, so this is only ever
 * the accountless records -- children, and anyone a member removed by mistake.
 */
routes.get("/:id/candidates", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  const { rows } = await db.query<{ id: string; first_name: string; last_name: string | null }>(
    `select id, first_name, last_name
       from persons
      where organization_id = $1
        and family_id is null
        and app_user_id is null
        and deleted_at is null
      order by last_name nulls last, first_name`,
    [organizationId]
  );

  return c.json({
    candidates: rows.map((r) => ({
      id: r.id,
      name: fullName({ firstName: r.first_name, lastName: r.last_name }),
    })),
  });
});

/**
 * Add someone who is already in the directory to a family -- the counterpart to
 * removing a member, so that is not a one-way door.
 *
 * Restricted to people without an account. An adult with their own account
 * consents by asking to join; being pulled into a household by someone else is
 * exactly what the request flow exists to prevent.
 */
routes.post("/:id/members", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { personId } = familyMemberSchema.parse(await c.req.json());

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  const person = await one<{ app_user_id: string | null; family_id: string | null }>(
    db,
    `select app_user_id, family_id from persons
      where id = $1 and organization_id = $2 and deleted_at is null`,
    [personId, organizationId]
  );
  if (!person) throw new HTTPException(404, { message: "That person was not found" });
  if (person.app_user_id) {
    throw new HTTPException(400, {
      message: "They have an account — ask them to request to join instead",
    });
  }
  if (person.family_id) {
    throw new HTTPException(409, { message: "They are already in a family" });
  }

  await db.transaction(async (tx) => {
    await joinFamily(tx, caller, personId, id);
  });

  await audit(db, caller, {
    action: "family.addMember",
    entityType: "family",
    entityId: id,
    changes: { personId },
  });
  return c.body(null, 204);
});

/**
 * Delete an empty family. Admin-only, because the people who can create a
 * family for someone else are the ones who need to undo a typo.
 */
routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const family = await loadFamilyRow(db, id, organizationId);
  if (!caller.isAdmin) {
    throw new HTTPException(403, { message: "Only an administrator can remove a family" });
  }

  const remaining = await one<{ count: string }>(
    db,
    "select count(*) as count from persons where family_id = $1 and deleted_at is null",
    [id]
  );
  if (Number(remaining?.count ?? 0) > 0) {
    throw new HTTPException(409, { message: "Remove its members first" });
  }

  // Join requests cascade with the family row; the photo does not.
  await db.query("delete from families where id = $1", [id]);
  await deletePhoto(family.photo_key);

  await audit(db, caller, {
    action: "family.delete",
    entityType: "family",
    entityId: id,
    changes: { name: family.name },
  });
  return c.body(null, 204);
});

/** Remove someone from a family. */
routes.delete("/:id/members/:personId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const personId = uuidSchema.parse(c.req.param("personId"));

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  // `assertCanEditFamily` authorises the *family*; nothing above authorises the
  // *person*. Without this check any member could pass a stranger's id -- even
  // one in another parish -- and clearInheritanceFor would happily wipe their
  // pointers, because the family-scoped update below is the only thing that
  // ever looked at membership. 404, not 403, so another parish's person stays
  // indistinguishable from one that does not exist.
  const member = await one<{ id: string }>(
    db,
    `select id from persons
      where id = $1 and organization_id = $2 and family_id = $3 and deleted_at is null`,
    [personId, organizationId, id]
  );
  if (!member) {
    throw new HTTPException(404, { message: "That person is not in this family" });
  }

  // A family with nobody in it is editable only by an admin and still shows up
  // in the families list, so let members step back from that cliff. An admin
  // emptying a family is the deliberate first step of deleting it.
  if (!caller.isAdmin) {
    const remaining = await one<{ count: string }>(
      db,
      `select count(*) as count from persons
        where family_id = $1 and deleted_at is null and id <> $2`,
      [id, personId]
    );
    if (Number(remaining?.count ?? 0) === 0) {
      throw new HTTPException(409, {
        message: "A family needs at least one member. Ask an administrator to remove it instead.",
      });
    }
  }

  await db.transaction(async (tx) => {
    await clearInheritanceFor(tx, personId);
    await tx.query("update persons set family_id = null where id = $1 and family_id = $2", [
      personId,
      id,
    ]);
    // They are not in any family now, so every outstanding request is moot.
    await cancelPendingJoinRequests(tx, personId);
  });

  await audit(db, caller, {
    action: "family.removeMember",
    entityType: "family",
    entityId: id,
    changes: { personId },
  });
  return c.body(null, 204);
});

/**
 * Moves a person into a family. Their previous family's inheritance is dropped
 * first -- otherwise the resolution view would keep serving an address from
 * people who are no longer relatives.
 */
async function joinFamily(
  q: Queryable,
  _caller: Caller,
  personId: string,
  familyId: string
): Promise<void> {
  // A family belongs to one parish, and so does a person. Nothing in the
  // schema ties the two together -- there is no composite foreign key -- so
  // this is the only thing stopping a person being put into another parish's
  // family. It matters most for a super admin, whose own record sits in their
  // home parish while they may be viewing a different one.
  const sameOrganization = await one<{ id: string }>(
    q,
    `select p.id
       from persons p
       join families f on f.id = $2
      where p.id = $1
        and p.organization_id = f.organization_id`,
    [personId, familyId]
  );
  if (!sameOrganization) {
    throw new HTTPException(400, {
      message: "That family belongs to a different church",
    });
  }

  await clearInheritanceFor(q, personId);
  await q.query("update persons set family_id = $2 where id = $1", [personId, familyId]);
  // Any other outstanding requests from this person are moot now.
  await cancelPendingJoinRequests(q, personId, familyId);
}

export default routes;
