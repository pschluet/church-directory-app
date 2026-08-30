import { HTTPException } from "hono/http-exception";
import { one, type Queryable } from "../db";
import { clearInheritanceFor } from "./inheritance";
import type { OrganizationMoveDto } from "../types";

/**
 * Which parish an account belongs to, and keeping its directory record in step.
 *
 * This exists because an account's parish and its `persons` row have to move
 * together. `persons.app_user_id` is a plain unique column -- not
 * `(app_user_id, organization_id)`, and not filtered on `deleted_at` -- so one
 * account has at most one directory record, ever. There is no "a record in each
 * parish"; the only available operation is moving the one record.
 *
 * Moving it is not a one-line update, because a `persons` row is tied to a lot
 * of parish-scoped data that the database does not protect. Every invariant
 * below is enforced here rather than by a constraint, which is exactly why this
 * belongs in one place instead of being spread across the routes that need it.
 */

interface AccountRow {
  id: string;
  role: string;
  organization_id: string | null;
  person_id: string | null;
  person_organization_id: string | null;
  email: string;
}

export interface SetAccountOrganizationParams {
  appUserId: string;
  /** The parish the account is moving to. */
  organizationId: string;
  /**
   * Only consulted when a record has to be created. Required in that case: an
   * `app_users` row carries no name, so there is nothing honest to derive one
   * from.
   */
  names?: { firstName: string; lastName: string | null };
}

export async function setAccountOrganization(
  db: Queryable,
  params: SetAccountOrganizationParams
): Promise<OrganizationMoveDto> {
  const { appUserId, organizationId, names } = params;

  const organization = await one<{ id: string }>(db, "select id from organizations where id = $1", [
    organizationId,
  ]);
  if (!organization) throw new HTTPException(404, { message: "Organization not found" });

  return db.transaction(async (tx) => {
    const account = await one<AccountRow>(
      tx,
      `select u.id,
              u.role,
              u.organization_id,
              u.email::text as email,
              p.id as person_id,
              p.organization_id as person_organization_id
         from app_users u
         left join persons p on p.app_user_id = u.id and p.deleted_at is null
        where u.id = $1`,
      [appUserId]
    );
    if (!account) throw new HTTPException(404, { message: "Account not found" });

    // --- No record yet: create one. -------------------------------------
    if (!account.person_id) {
      if (!names) {
        throw new HTTPException(400, {
          message:
            "This account has no directory record yet — a first name is needed to create one",
        });
      }
      const created = await one<{ id: string }>(
        tx,
        `insert into persons (organization_id, app_user_id, first_name, last_name, email)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [organizationId, appUserId, names.firstName, names.lastName, account.email]
      );
      if (!created) {
        throw new HTTPException(500, { message: "Could not create that directory record" });
      }
      await tx.query("update app_users set organization_id = $2 where id = $1", [
        appUserId,
        organizationId,
      ]);
      return {
        personId: created.id,
        created: true,
        movedFrom: null,
        removedAnniversaries: 0,
      };
    }

    // --- Already there: nothing to do. ----------------------------------
    if (
      account.person_organization_id === organizationId &&
      account.organization_id === organizationId
    ) {
      return {
        personId: account.person_id,
        created: false,
        movedFrom: null,
        removedAnniversaries: 0,
      };
    }

    // --- Move the record. -----------------------------------------------
    const personId = account.person_id;
    const movedFrom = account.person_organization_id;

    // Both directions: their own inheritance, and anyone inheriting from them.
    // Skipping the inbound half would leave persons_resolved serving one
    // parish's address to another parish's member -- a cross-tenant leak, not
    // just a stale value.
    await clearInheritanceFor(tx, personId);

    // Family membership is parish-scoped, so it cannot survive the move.
    await tx.query("update persons set family_id = null where id = $1", [personId]);
    await tx.query(
      `update family_join_requests
          set status = 'CANCELLED', decided_at = now()
        where person_id = $1 and status = 'PENDING'`,
      [personId]
    );

    // Don't leave a family in the old parish pointing at them as its creator.
    await tx.query(
      `update families
          set created_by_person_id = null
        where created_by_person_id = $1 and organization_id <> $2`,
      [personId, organizationId]
    );

    // An anniversary links two Persons and the schema requires the second one,
    // so it cannot span parishes. Delete the ones whose other half is staying,
    // and report how many so the caller can say what was lost.
    const { rows: removed } = await tx.query<{ id: string }>(
      `delete from special_dates
        where type = 'ANNIVERSARY'
          and (person_id = $1 or related_person_id = $1)
        returning id`,
      [personId]
    );

    // The remaining dates follow the person. This column is denormalized and
    // the upcoming-dates query filters on it, so leaving it behind would make
    // the dates vanish from the new parish and linger in the old one.
    await tx.query("update special_dates set organization_id = $2 where person_id = $1", [
      personId,
      organizationId,
    ]);

    await tx.query("update persons set organization_id = $2 where id = $1", [
      personId,
      organizationId,
    ]);
    await tx.query("update app_users set organization_id = $2 where id = $1", [
      appUserId,
      organizationId,
    ]);

    return {
      personId,
      created: false,
      movedFrom,
      removedAnniversaries: removed.length,
    };
  });
}
