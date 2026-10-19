import { HTTPException } from "hono/http-exception";
import type { Caller } from "../auth";
import { audit } from "../audit";
import { createInvitedUser } from "../cognito";
import { one, type Queryable } from "../db";
import { sendInvitationEmail } from "../email";
import type { Role } from "../types";
import { assertCanGrantRole } from "./access";

/**
 * Bringing an account into existence: the Cognito user (which can then sign
 * in), the app_users row, the directory record, and the invitation email.
 *
 * Shared by "Invite someone" and by approving a directory request, so the two
 * cannot drift -- an approved request is an ordinary invitation that an
 * administrator did not have to type out.
 *
 * `organizationId` is already resolved by the caller: this checks that it
 * exists and that the caller may grant `role` in it, but does not choose it.
 */
export async function inviteAccount(
  db: Queryable,
  caller: Caller,
  invite: {
    email: string;
    firstName: string;
    lastName: string | null;
    role: Role;
    organizationId: string | null;
    familyId: string | null;
  }
): Promise<{ userId: string; personId: string | null }> {
  const { email, firstName, lastName, role, organizationId, familyId } = invite;

  assertCanGrantRole(caller, role, organizationId);

  if (role !== "SUPER_ADMIN" && !organizationId) {
    throw new HTTPException(400, { message: "Choose an organization for this person" });
  }
  let organizationName: string | null = null;
  if (organizationId) {
    const org = await one<{ name: string }>(db, "select name from organizations where id = $1", [
      organizationId,
    ]);
    if (!org) throw new HTTPException(404, { message: "Organization not found" });
    organizationName = org.name;
  }

  const existing = await one<{ id: string }>(db, "select id from app_users where email = $1", [
    email,
  ]);
  if (existing) {
    throw new HTTPException(409, {
      message: "Someone with that email address already has an account",
    });
  }

  if (familyId) {
    const family = await one<{ id: string }>(
      db,
      "select id from families where id = $1 and organization_id = $2",
      [familyId, organizationId]
    );
    if (!family) throw new HTTPException(404, { message: "Family not found" });
  }

  // Cognito first: if it fails we have written nothing, whereas the reverse
  // order can leave an app_users row with no way to sign in.
  const { sub } = await createInvitedUser({ email, firstName, lastName });

  const created = await db.transaction(async (tx) => {
    const user = await one<{ id: string }>(
      tx,
      `insert into app_users (cognito_sub, email, role, organization_id, status)
       values ($1, $2, $3, $4, 'INVITED')
       returning id`,
      [sub, email, role, organizationId]
    );
    if (!user) throw new HTTPException(500, { message: "Could not create that account" });

    // Super admins are cross-organization and need no directory record until
    // they are given an organization.
    let personId: string | null = null;
    if (organizationId) {
      const person = await one<{ id: string }>(
        tx,
        `insert into persons (organization_id, family_id, app_user_id, first_name, last_name, email)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [organizationId, familyId, user.id, firstName, lastName, email]
      );
      personId = person?.id ?? null;
    }
    return { userId: user.id, personId };
  });

  await audit(db, caller, {
    action: "user.invite",
    entityType: "appUser",
    entityId: created.userId,
    changes: { email, role, organizationId },
  });

  // After the account exists, not before: a failed send leaves someone who can
  // still be told to sign in, whereas failing the request would leave a
  // Cognito user with no directory row.
  try {
    await sendInvitationEmail({
      to: email,
      firstName,
      organizationName: organizationName ?? "the parish",
      invitedBy: caller.email,
    });
  } catch (err) {
    console.error("Invitation email failed for", email, err);
  }

  return created;
}
