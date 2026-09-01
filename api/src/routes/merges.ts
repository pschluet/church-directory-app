import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv, type Caller } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { canEditPerson } from "../services/access";
import { mergePersons } from "../services/merge";
import {
  fullName,
  mergeRequestCreateSchema,
  uuidSchema,
  type MergeRequestDto,
  type PersonMergeResultDto,
} from "../types";

/**
 * Merging two records for the same person, and the approval that gates it.
 *
 * The same human can end up with two `persons` rows -- one the family created
 * with no account, one the invite flow created with an account. Either half of
 * a merge is a claim about somebody else, so it takes two people, and the
 * approver is always whichever side did not ask:
 *
 *   A  a family member of the account-less duplicate names an account holder
 *      -> that account holder approves
 *   B  the account holder names an account-less person
 *      -> any *other* account holder in that person's family approves
 *
 * `requested_by_person_id` is what tells the two apart, so one row and one pair
 * of routes serve both. An admin may already edit everyone in their parish, so
 * asking them to wait for permission would add nothing: their request merges
 * immediately and writes no row. That is also the way out of a merge nobody is
 * left to approve.
 *
 * The actual merging is `services/merge.ts`. This file is only about who may
 * ask, who may decide, and what they can see.
 */
const routes = new Hono<AppEnv>();

interface MergeRequestRow {
  id: string;
  organization_id: string;
  account_person_id: string;
  account_first_name: string;
  account_last_name: string | null;
  duplicate_person_id: string;
  duplicate_first_name: string;
  duplicate_last_name: string | null;
  duplicate_family_id: string | null;
  duplicate_family_name: string | null;
  requested_by_person_id: string;
  requested_by_first_name: string;
  requested_by_last_name: string | null;
  status: MergeRequestDto["status"];
  requested_at: Date | string;
  decided_at: Date | string | null;
}

/**
 * Joins `persons_resolved` rather than `persons` for all three people, so a
 * member who inherits the family surname is not shown with a blank last name.
 */
const MERGE_REQUEST_SELECT = `
  select mr.id,
         mr.organization_id,
         mr.account_person_id,
         a.first_name as account_first_name,
         a.last_name  as account_last_name,
         mr.duplicate_person_id,
         d.first_name as duplicate_first_name,
         d.last_name  as duplicate_last_name,
         d.family_id  as duplicate_family_id,
         d.family_name as duplicate_family_name,
         mr.requested_by_person_id,
         r.first_name as requested_by_first_name,
         r.last_name  as requested_by_last_name,
         mr.status,
         mr.requested_at,
         mr.decided_at
    from person_merge_requests mr
    join persons_resolved a on a.id = mr.account_person_id
    join persons_resolved d on d.id = mr.duplicate_person_id
    join persons_resolved r on r.id = mr.requested_by_person_id
`;

/**
 * Route B is "the account holder asked", so the family decides. Route A is
 * anyone else asking, so the account holder decides. Either way the requester
 * is excluded -- otherwise route B would let an account holder in the
 * duplicate's own family approve their own claim.
 *
 * Admins are allowed through both, which is what makes a stalled request
 * fixable.
 */
function canDecide(caller: Caller, row: MergeRequestRow): boolean {
  if (row.organization_id !== caller.organizationId) return false;
  if (row.status !== "PENDING") return false;
  if (caller.isAdmin) return true;
  if (!caller.personId || caller.personId === row.requested_by_person_id) return false;

  const askedByAccountHolder = row.requested_by_person_id === row.account_person_id;
  return askedByAccountHolder
    ? caller.familyId !== null && caller.familyId === row.duplicate_family_id
    : caller.personId === row.account_person_id;
}

function toMergeRequest(row: MergeRequestRow, caller: Caller): MergeRequestDto {
  return {
    id: row.id,
    accountPersonId: row.account_person_id,
    accountPersonName: fullName({
      firstName: row.account_first_name,
      lastName: row.account_last_name,
    }),
    duplicatePersonId: row.duplicate_person_id,
    duplicatePersonName: fullName({
      firstName: row.duplicate_first_name,
      lastName: row.duplicate_last_name,
    }),
    duplicateFamilyId: row.duplicate_family_id,
    duplicateFamilyName: row.duplicate_family_name,
    requestedByPersonId: row.requested_by_person_id,
    requestedByPersonName: fullName({
      firstName: row.requested_by_first_name,
      lastName: row.requested_by_last_name,
    }),
    status: row.status,
    requestedAt: new Date(row.requested_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    canDecide: canDecide(caller, row),
  };
}

interface CandidateRow {
  id: string;
  organization_id: string;
  family_id: string | null;
  app_user_id: string | null;
}

/** Scoped by organization, so another parish's person 404s rather than 403s. */
async function loadCandidate(
  q: Queryable,
  id: string,
  organizationId: string
): Promise<CandidateRow> {
  const row = await one<CandidateRow>(
    q,
    `select id, organization_id, family_id, app_user_id
       from persons
      where id = $1 and organization_id = $2 and deleted_at is null`,
    [id, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Person not found" });
  return row;
}

/** Ask to merge two records, or -- as an admin -- just merge them. */
routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = mergeRequestCreateSchema.parse(await c.req.json());

  if (payload.accountPersonId === payload.duplicatePersonId) {
    throw new HTTPException(400, { message: "Those are the same person" });
  }

  const account = await loadCandidate(db, payload.accountPersonId, organizationId);
  const duplicate = await loadCandidate(db, payload.duplicatePersonId, organizationId);

  if (account.app_user_id === null) {
    throw new HTTPException(400, {
      message: "The surviving record must be the one with an account",
    });
  }
  if (duplicate.app_user_id !== null) {
    throw new HTTPException(400, {
      message: "Both of those people have an account, so they cannot be merged",
    });
  }

  // Route B is "this is my own record"; route A is "this is my account-less
  // relative". `canEditPerson` already means exactly the latter -- an account
  // holder acting on an account-less member of their own family, or an admin.
  const isOwnRecord = caller.personId !== null && caller.personId === account.id;
  if (!isOwnRecord && !canEditPerson(caller, factsOf(duplicate))) {
    throw new HTTPException(403, {
      message: "Only that person, or someone in the family of the duplicate, can ask to merge",
    });
  }
  if (!caller.personId) {
    throw new HTTPException(400, { message: "Your own directory record is missing" });
  }

  if (caller.isAdmin) {
    const result = await mergePersons(db, {
      accountPersonId: account.id,
      duplicatePersonId: duplicate.id,
      organizationId,
    });
    await auditMerge(db, caller, "person.merge", result);
    return c.json({ status: "APPROVED" as const, result }, 201);
  }

  const created = await one<{ id: string }>(
    db,
    `insert into person_merge_requests
       (organization_id, account_person_id, duplicate_person_id, requested_by_person_id)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning id`,
    [organizationId, account.id, duplicate.id, caller.personId]
  );
  if (!created) {
    throw new HTTPException(409, {
      message: "There is already a pending merge request for one of these people",
    });
  }

  await audit(db, caller, {
    action: "person.mergeRequest",
    entityType: "person",
    entityId: account.id,
    changes: { duplicatePersonId: duplicate.id },
  });

  return c.json({ status: "PENDING" as const, id: created.id }, 201);
});

/** Merge requests the caller can see: waiting on them, about them, or -- for an admin -- any. */
routes.get("/pending", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  // An ordinary caller sees the requests they are party to: either record is
  // theirs, they raised it, or it names a duplicate in their family. That is
  // wider than "can decide" on purpose -- the SPA also needs to know a merge is
  // already pending so it can stop offering another one.
  const { rows } = caller.isAdmin
    ? await db.query<MergeRequestRow>(
        `${MERGE_REQUEST_SELECT}
          where mr.organization_id = $1 and mr.status = 'PENDING'
          order by mr.requested_at`,
        [organizationId]
      )
    : await db.query<MergeRequestRow>(
        `${MERGE_REQUEST_SELECT}
          where mr.organization_id = $1
            and mr.status = 'PENDING'
            and (
              $2::uuid in (mr.account_person_id, mr.duplicate_person_id, mr.requested_by_person_id)
              or d.family_id = $3::uuid
            )
          order by mr.requested_at`,
        [organizationId, caller.personId, caller.familyId]
      );

  return c.json({ mergeRequests: rows.map((row) => toMergeRequest(row, caller)) });
});

routes.post("/:id/:decision{approve|deny}", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const approve = c.req.param("decision") === "approve";

  const request = await one<MergeRequestRow>(
    db,
    `${MERGE_REQUEST_SELECT} where mr.id = $1 and mr.organization_id = $2`,
    [id, organizationId]
  );
  if (!request) throw new HTTPException(404, { message: "Request not found" });
  if (request.status !== "PENDING") {
    throw new HTTPException(409, { message: "That request has already been decided" });
  }
  if (!canDecide(caller, request)) {
    throw new HTTPException(403, { message: "That merge is not yours to decide" });
  }

  let result: PersonMergeResultDto | null = null;
  await db.transaction(async (tx) => {
    // Before the merge, not after: mergePersons cancels every other *pending*
    // merge naming either person, and this row must already be out of that set.
    await tx.query(
      `update person_merge_requests
          set status = $2, decided_at = now(), decided_by_person_id = $3
        where id = $1`,
      [id, approve ? "APPROVED" : "DENIED", caller.personId]
    );
    if (approve) {
      result = await mergePersons(tx, {
        accountPersonId: request.account_person_id,
        duplicatePersonId: request.duplicate_person_id,
        organizationId,
      });
    }
  });

  if (result) {
    await auditMerge(db, caller, "person.mergeRequest.approve", result);
  } else {
    await audit(db, caller, {
      action: "person.mergeRequest.deny",
      entityType: "person",
      entityId: request.account_person_id,
      changes: { duplicatePersonId: request.duplicate_person_id },
    });
  }

  return c.json({ status: approve ? "APPROVED" : "DENIED", ...(result ? { result } : {}) });
});

function factsOf(row: CandidateRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    familyId: row.family_id,
    appUserId: row.app_user_id,
  };
}

/** Both merge paths record the same thing, including what the merge discarded. */
async function auditMerge(
  db: Queryable,
  caller: Caller,
  action: string,
  result: PersonMergeResultDto
): Promise<void> {
  await audit(db, caller, {
    action,
    entityType: "person",
    entityId: result.personId,
    changes: result,
  });
}

export default routes;
