import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv, type Caller } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { assertCanEditFamily, canEditFamily } from "../services/access";
import { clearInheritanceFor } from "../services/inheritance";
import { PERSON_COLUMNS, PERSON_ORDER, toSummaries, type PersonRow } from "../services/persons";
import { deletePhoto, presignDownload } from "../photos";
import {
  familyWriteSchema,
  fullName,
  uuidSchema,
  type FamilyDto,
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

/** All families in the organization, for the "join a family" picker. */
routes.get("/", async (c) => {
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = await db.query<{ id: string; name: string; member_count: string }>(
    `select f.id,
            f.name,
            count(p.id) filter (where p.deleted_at is null) as member_count
       from families f
       left join persons p on p.family_id = f.id
      where f.organization_id = $1
      group by f.id, f.name
      order by f.name`,
    [organizationId]
  );

  return c.json({
    families: rows.map((r) => ({
      id: r.id,
      name: r.name,
      memberCount: Number(r.member_count),
    })),
  });
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
 * Creating a family puts the creator in it. Anything else would leave an empty
 * family nobody can administer.
 */
routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = familyWriteSchema.parse(await c.req.json());

  if (!caller.personId) {
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

    // Leaving one family for another drops inheritance from the old one.
    await clearInheritanceFor(tx, caller.personId!);
    await tx.query("update persons set family_id = $2 where id = $1", [
      caller.personId,
      created.id,
    ]);
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

/** Remove someone from a family. */
routes.delete("/:id/members/:personId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const personId = uuidSchema.parse(c.req.param("personId"));

  const family = await loadFamilyRow(db, id, organizationId);
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });

  await db.transaction(async (tx) => {
    await clearInheritanceFor(tx, personId);
    await tx.query("update persons set family_id = null where id = $1 and family_id = $2", [
      personId,
      id,
    ]);
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
  await q.query(
    `update family_join_requests
        set status = 'CANCELLED', decided_at = now()
      where person_id = $1 and status = 'PENDING' and family_id <> $2`,
    [personId, familyId]
  );
}

export default routes;
