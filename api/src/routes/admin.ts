import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, requireRole, type AppEnv } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { assertCanGrantRole } from "../services/access";
import { deleteUser, setUserEnabled, updateUserEmail } from "../cognito";
import { clearInheritanceFor } from "../services/inheritance";
import { inviteAccount } from "../services/invitations";
import { setAccountOrganization } from "../services/membership";
import { deletePhoto } from "../photos";
import {
  fullName,
  inviteUserSchema,
  updateUserSchema,
  uuidSchema,
  type AppUserDto,
  type DirectoryRequestDto,
} from "../types";

/**
 * Account management. Sign-up is disabled on the user pool, so this is the only
 * way an account comes into existence: an admin invites someone, we create the
 * Cognito user (which emails the invitation through SES) and the matching
 * Person record in one transaction.
 */
const routes = new Hono<AppEnv>();

routes.use("/users/*", requireRole("ADMIN"));
routes.use("/users", requireRole("ADMIN"));
routes.use("/directory-requests", requireRole("ADMIN"));
routes.use("/directory-requests/*", requireRole("ADMIN"));

interface AppUserRow {
  id: string;
  email: string;
  role: AppUserDto["role"];
  status: AppUserDto["status"];
  organization_id: string | null;
  organization_name: string | null;
  person_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

const APP_USER_SELECT = `
  select u.id,
         u.email::text as email,
         u.role,
         u.status,
         u.organization_id,
         o.name as organization_name,
         p.id as person_id,
         p.first_name,
         p.last_name
    from app_users u
    left join organizations o on o.id = u.organization_id
    -- Resolved, so someone sharing a relative's last name is listed with it.
    left join persons_resolved p on p.app_user_id = u.id and p.deleted_at is null
`;

function toAppUser(row: AppUserRow): AppUserDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    personId: row.person_id,
    personName: row.first_name
      ? fullName({ firstName: row.first_name, lastName: row.last_name })
      : null,
  };
}

/**
 * The accounts in the organization being viewed -- for an admin their own, for
 * a super admin whichever parish they have switched to. A super admin used to
 * get every account in every parish here, which made one parish's page a place
 * to manage all of them. A super admin with no parish of their own is in no
 * parish's list.
 */
routes.get("/users", async (c) => {
  const organizationId = requireOrganizationId(c);
  const { rows } = await c
    .get("db")
    .query<AppUserRow>(`${APP_USER_SELECT} where u.organization_id = $1 order by u.email`, [
      organizationId,
    ]);

  return c.json({ users: rows.map(toAppUser) });
});

routes.post("/users", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = inviteUserSchema.parse(await c.req.json());

  /*
   * Into the organization being viewed, so the new account appears on the list
   * it was invited from. A super admin invite may instead belong to no parish
   * at all; nothing may name some third one.
   */
  const activeOrganizationId = requireOrganizationId(c);
  if (payload.organizationId && payload.organizationId !== activeOrganizationId) {
    // An admin cannot switch parish at all, so for them this is a refusal
    // rather than a misstep.
    throw caller.isSuperAdmin
      ? new HTTPException(400, { message: "Switch to that church to invite someone into it" })
      : new HTTPException(403, { message: "You can only invite people into your own church" });
  }
  const organizationId =
    payload.role === "SUPER_ADMIN" && !payload.organizationId ? null : activeOrganizationId;

  const created = await inviteAccount(db, caller, {
    email: payload.email,
    firstName: payload.firstName,
    lastName: payload.lastName ?? null,
    role: payload.role,
    organizationId,
    familyId: payload.familyId ?? null,
  });

  const row = await one<AppUserRow>(db, `${APP_USER_SELECT} where u.id = $1`, [created.userId]);
  return c.json(row ? toAppUser(row) : { id: created.userId }, 201);
});

routes.patch("/users/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = updateUserSchema.parse(await c.req.json());

  const target = await one<{
    id: string;
    email: string;
    role: AppUserDto["role"];
    organization_id: string | null;
    status: AppUserDto["status"];
  }>(
    db,
    "select id, email::text as email, role, organization_id, status from app_users where id = $1",
    [id]
  );
  if (!target) throw new HTTPException(404, { message: "Account not found" });

  // Only accounts inside the organization being viewed, a super admin's
  // included; and an admin may not touch a super admin at all.
  if (target.organization_id !== requireOrganizationId(c)) {
    throw new HTTPException(404, { message: "Account not found" });
  }
  if (!caller.isSuperAdmin && target.role === "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Only a super admin can change a super admin" });
  }
  if (payload.role) {
    assertCanGrantRole(caller, payload.role, payload.organizationId ?? target.organization_id);
  }
  if (payload.organizationId !== undefined && !caller.isSuperAdmin) {
    throw new HTTPException(403, {
      message: "Only a super admin can move someone between organizations",
    });
  }
  if (target.id === caller.appUserId && payload.status === "DISABLED") {
    throw new HTTPException(400, { message: "You cannot disable your own account" });
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  if (payload.role !== undefined) {
    sets.push(`role = $${values.length + 1}`);
    values.push(payload.role);
  }
  if (payload.status !== undefined) {
    sets.push(`status = $${values.length + 1}`);
    values.push(payload.status);
  }
  if (payload.organizationId === null) {
    // Only a super admin may be parish-less, and their record would then be
    // orphaned in a parish they no longer belong to.
    throw new HTTPException(400, {
      message: "An account cannot be removed from its church; move it to another one instead",
    });
  }

  let move: Awaited<ReturnType<typeof setAccountOrganization>> | null = null;

  // One transaction, so a move and a role change land together or not at all.
  //
  // organization_id is deliberately absent from the SET list above: moving an
  // account between parishes has to carry its directory record, its special
  // dates and its family membership with it, which is setAccountOrganization's
  // job.
  await db.transaction(async (tx) => {
    if (payload.organizationId != null && payload.organizationId !== target.organization_id) {
      move = await setAccountOrganization(tx, {
        appUserId: id,
        organizationId: payload.organizationId,
        names: payload.firstName
          ? { firstName: payload.firstName, lastName: payload.lastName ?? null }
          : undefined,
      });
    }
    if (sets.length > 0) {
      await tx.query(`update app_users set ${sets.join(", ")} where id = $1`, values);
    }
  });

  // Keep Cognito in step: a disabled account must not be able to sign in even
  // before our own 403 would kick in.
  if (payload.status !== undefined && payload.status !== target.status) {
    await setUserEnabled(target.email, payload.status !== "DISABLED");
  }

  await audit(db, caller, {
    action: "user.update",
    entityType: "appUser",
    entityId: id,
    changes: payload,
  });

  const row = await one<AppUserRow>(db, `${APP_USER_SELECT} where u.id = $1`, [id]);
  // `move` is reported so the caller can tell the user what the move discarded
  // -- an anniversary that cannot span parishes, in particular.
  return c.json({ ...(row ? toAppUser(row) : { id }), ...(move ? { move } : {}) });
});

/**
 * Removes an account and the directory record behind it, permanently.
 *
 * The gentler operation is still here -- PATCH with `{status:"DISABLED"}` locks
 * someone out and keeps every row -- and remains the right answer for a
 * parishioner who has simply stopped attending. This is for the rows that
 * should never have existed: a mistake, a duplicate, someone who has left.
 *
 * It is the one hard delete of a Person in the app. `DELETE /persons/:id` is a
 * soft delete and refuses anyone with an account precisely because the account
 * would be left pointing at nothing; here both halves go together, which is
 * what makes it safe to do at all.
 *
 * Two orderings are possible and only one is recoverable, so this is deliberate:
 * the transaction commits first and Cognito is deleted after. If Cognito then
 * fails, a user lingers there that cannot sign in to anything -- findOrBindAppUser
 * returns null with no app_users row, and bindByEmail only claims a row whose
 * cognito_sub is null -- and the admin finds out because re-inviting the address
 * 409s. The reverse leaves an account row whose cognito_sub names a user that no
 * longer exists: it looks intact on this screen, can never sign in, and cannot
 * be re-bound or re-invited. A visible orphan beats a silent one.
 */
routes.delete("/users/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const id = uuidSchema.parse(c.req.param("id"));

  const target = await one<{
    id: string;
    email: string;
    role: string;
    organization_id: string | null;
    cognito_sub: string | null;
    person_id: string | null;
    photo_key: string | null;
  }>(
    db,
    `select u.id,
            u.email::text as email,
            u.role,
            u.organization_id,
            u.cognito_sub,
            p.id as person_id,
            p.photo_key
       from app_users u
       left join persons p on p.app_user_id = u.id
      where u.id = $1`,
    [id]
  );
  if (!target) throw new HTTPException(404, { message: "Account not found" });
  // 404 and not 403, so another parish's account is indistinguishable from one
  // that does not exist -- the same shape as every other handler here. Scoped
  // to the parish being viewed, for a super admin too.
  if (target.organization_id !== requireOrganizationId(c)) {
    throw new HTTPException(404, { message: "Account not found" });
  }
  if (!caller.isSuperAdmin && target.role === "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Only a super admin can delete a super admin" });
  }
  if (target.id === caller.appUserId) {
    throw new HTTPException(400, { message: "You cannot delete your own account" });
  }
  /*
   * No "last super admin" guard, and none is needed: the two checks above make
   * it unreachable. Only a super admin can delete a super admin, and nobody can
   * delete themselves, so any such delete leaves at least the caller behind.
   */

  // Before the rows are gone, while the caller can still be told what happened.
  await audit(db, caller, {
    action: "user.delete",
    entityType: "appUser",
    entityId: id,
    changes: { email: target.email, personId: target.person_id },
  });

  await db.transaction(async (tx) => {
    if (target.person_id) {
      /*
       * Explicitly, rather than leaning on the inherit_* columns' ON DELETE SET
       * NULL: this is what makes a family member who took a surname or an
       * address from them fall back to their own value instead of silently
       * losing it. Every other delete path does the same.
       */
      await clearInheritanceFor(tx, target.person_id);
      // Cascades special_dates on both person_id and related_person_id, so a
      // wedding anniversary shared with a spouse goes too. The confirmation on
      // the admin screen says so.
      await tx.query("delete from persons where id = $1", [target.person_id]);
    }
    // Last: persons.app_user_id references this row, and deleting it first
    // would null that pointer and lose the person we just looked up.
    await tx.query("delete from app_users where id = $1", [id]);
  });

  /*
   * By cognito_sub and not by email. updateUserEmail changes the email
   * attribute but never the username, which stays whatever the address was at
   * AdminCreateUser time -- so for anyone whose sign-in address was changed,
   * deleting by email would miss. Null only for the bootstrap super admin,
   * inserted by V3 before any Cognito user existed.
   */
  if (target.cognito_sub) await deleteUser(target.cognito_sub);

  // After the commit, and last of all: S3 is not transactional, and an orphaned
  // rendition is a wasted object rather than a broken record.
  await deletePhoto(target.photo_key);

  return c.body(null, 204);
});

/** Changing the address an account signs in with. */
routes.put("/users/:id/email", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const id = uuidSchema.parse(c.req.param("id"));
  const { email } = inviteUserSchema.pick({ email: true }).parse(await c.req.json());

  const target = await one<{ id: string; email: string; organization_id: string | null }>(
    db,
    "select id, email::text as email, organization_id from app_users where id = $1",
    [id]
  );
  if (!target || target.organization_id !== requireOrganizationId(c)) {
    throw new HTTPException(404, { message: "Account not found" });
  }

  await updateUserEmail(target.email, email);
  await db.query("update app_users set email = $2 where id = $1", [id, email]);
  await audit(db, caller, {
    action: "user.changeEmail",
    entityType: "appUser",
    entityId: id,
    changes: { from: target.email, to: email },
  });
  return c.json({ id, email });
});

// ---------------------------------------------------------------------------
// Directory requests -- "Request to be added" from the sign-in page. The
// public half is routes/directory-requests.ts.
//
// Scoped to the active organization rather than the caller's home one, so a
// super admin looking at a parish sees that parish's requests.
// ---------------------------------------------------------------------------

interface DirectoryRequestRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  organization_id: string;
  requested_at: Date | string;
}

function toDirectoryRequest(row: DirectoryRequestRow): DirectoryRequestDto {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    organizationId: row.organization_id,
    requestedAt: new Date(row.requested_at).toISOString(),
  };
}

const DIRECTORY_REQUEST_SELECT = `
  select id, first_name, last_name, email::text as email, organization_id, requested_at
    from directory_requests
`;

routes.get("/directory-requests", async (c) => {
  const organizationId = requireOrganizationId(c);
  const { rows } = await c
    .get("db")
    .query<DirectoryRequestRow>(
      `${DIRECTORY_REQUEST_SELECT} where organization_id = $1 and status = 'PENDING' order by requested_at desc`,
      [organizationId]
    );
  return c.json({ directoryRequests: rows.map(toDirectoryRequest) });
});

async function loadPendingDirectoryRequest(
  db: Queryable,
  id: string,
  organizationId: string
): Promise<DirectoryRequestRow> {
  const row = await one<DirectoryRequestRow>(
    db,
    `${DIRECTORY_REQUEST_SELECT} where id = $1 and organization_id = $2 and status = 'PENDING'`,
    [id, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "That request has already been handled" });
  return row;
}

/**
 * One click: an ordinary member with no family, invited exactly as "Invite
 * someone" would. Anything else -- a role, a family -- is set afterwards from
 * the account's row, the same as for anyone invited by hand.
 *
 * The invitation goes first and the request is only marked approved once it
 * has: if the address already has an account, the 409 leaves the request
 * pending for the administrator to decline.
 */
routes.post("/directory-requests/:id/approve", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const request = await loadPendingDirectoryRequest(db, id, organizationId);

  const created = await inviteAccount(db, caller, {
    email: request.email,
    firstName: request.first_name,
    lastName: request.last_name,
    role: "USER",
    organizationId,
    familyId: null,
  });

  await db.query(
    `update directory_requests
        set status = 'APPROVED', decided_at = now(), decided_by_app_user_id = $2, app_user_id = $3
      where id = $1 and status = 'PENDING'`,
    [id, caller.appUserId, created.userId]
  );

  await audit(db, caller, {
    action: "directoryRequest.approve",
    entityType: "directoryRequest",
    entityId: id,
    changes: { email: request.email, appUserId: created.userId },
  });

  const row = await one<AppUserRow>(db, `${APP_USER_SELECT} where u.id = $1`, [created.userId]);
  return c.json(row ? toAppUser(row) : { id: created.userId }, 201);
});

routes.post("/directory-requests/:id/decline", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const request = await loadPendingDirectoryRequest(db, id, organizationId);

  await db.query(
    `update directory_requests
        set status = 'DECLINED', decided_at = now(), decided_by_app_user_id = $2
      where id = $1 and status = 'PENDING'`,
    [id, caller.appUserId]
  );

  await audit(db, caller, {
    action: "directoryRequest.decline",
    entityType: "directoryRequest",
    entityId: id,
    changes: { email: request.email },
  });

  return c.body(null, 204);
});

export default routes;
