import { HTTPException } from "hono/http-exception";
import { one, type Queryable } from "../db";
import { clearInheritanceFor, INHERIT_COLUMN } from "./inheritance";
import { cancelPendingJoinRequests } from "./membership";
import { INHERITABLE_ATTRIBUTES, type PersonMergeResultDto } from "../types";

/**
 * Folding two `persons` rows for the same human into one.
 *
 * This happens because a family can create a record for a member with no login,
 * and the invite flow later creates a second one carrying `app_user_id`. See
 * V5__person_merge_requests.sql for who is allowed to ask and who approves;
 * this module is only concerned with doing it correctly once someone has.
 *
 * The account holder's row survives. The alternative -- keeping the family's
 * row and moving the account onto it -- would be the first thing in the
 * codebase ever to reassign `persons.app_user_id`, which is a bare unique
 * column that `auth.ts` joins on. Keeping the account row means that column is
 * never touched at all.
 *
 * Like `setAccountOrganization`, which this is modelled on, the interesting part
 * is that a `persons` row is tied to a lot of data the database does not protect
 * for us, and the *order* of the statements below is what keeps every constraint
 * satisfied at each step. Each one says which constraint puts it where it is.
 */

interface MergeCandidate {
  id: string;
  organization_id: string;
  family_id: string | null;
  app_user_id: string | null;
}

const ADDRESS_COLUMNS = [
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "country",
] as const;

/**
 * Address moves as a block, never column by column.
 *
 * It is inherited as a unit -- one pointer in `INHERIT_COLUMN.address` covers
 * all six columns -- so coalescing each column on its own could splice one
 * person's street onto another's city and postcode. The survivor's address wins
 * whole if they have any part of one at all.
 */
const SURVIVOR_HAS_ADDRESS = ADDRESS_COLUMNS.map((c) => `a.${c} is not null`).join(" or ");

export interface MergePersonsParams {
  /** The surviving record. Must be the one with the account. */
  accountPersonId: string;
  /** The account-less duplicate. Soft-deleted by the time this returns. */
  duplicatePersonId: string;
  organizationId: string;
}

/**
 * Note for callers deciding a request: flip the request row to APPROVED
 * *before* calling this. Step 7 cancels every other pending merge naming
 * either person, and it identifies them by `status = 'PENDING'` -- so a request
 * still marked pending would cancel itself.
 */
export async function mergePersons(
  db: Queryable,
  params: MergePersonsParams
): Promise<PersonMergeResultDto> {
  const { accountPersonId, duplicatePersonId, organizationId } = params;

  if (accountPersonId === duplicatePersonId) {
    throw new HTTPException(400, { message: "Those are the same person" });
  }

  return db.transaction(async (tx) => {
    // Locked in id order rather than argument order, so two merges naming the
    // same pair from opposite directions queue up instead of deadlocking.
    const locked = new Map<string, MergeCandidate>();
    for (const id of [accountPersonId, duplicatePersonId].sort()) {
      locked.set(id, await loadCandidate(tx, id, organizationId));
    }
    const survivor = locked.get(accountPersonId)!;
    const duplicate = locked.get(duplicatePersonId)!;

    // One check for two mistakes: two accounts cannot be merged (that would
    // mean choosing which sign-in survives, a different problem), and the
    // arguments cannot be the wrong way round.
    if (survivor.app_user_id === null) {
      throw new HTTPException(400, {
        message: "The surviving record must be the one with an account",
      });
    }
    if (duplicate.app_user_id !== null) {
      throw new HTTPException(400, {
        message: "Both of those people have an account, so they cannot be merged",
      });
    }

    // The duplicate's family wins, because it is the family that built the
    // record. But a duplicate with no family must not strip the survivor of
    // theirs, hence the fallback rather than a plain assignment.
    const familyId = duplicate.family_id ?? survivor.family_id;
    const movedFamily = familyId !== survivor.family_id;

    // --- 1. An anniversary between the two. -----------------------------
    // `special_dates_related_person_differs` forbids related_person_id =
    // person_id, so this row cannot be re-pointed at step 3 -- it has to go,
    // and it has to go before anything else touches the table. It only exists
    // if someone was recorded as married to their own duplicate, which is a
    // data error rather than a real anniversary.
    const { rows: selfMarried } = await tx.query<{ id: string }>(
      `delete from special_dates
        where type = 'ANNIVERSARY'
          and ((person_id = $1 and related_person_id = $2)
            or (person_id = $2 and related_person_id = $1))
      returning id`,
      [accountPersonId, duplicatePersonId]
    );

    // --- 2. The duplicate's dates that would collide. -------------------
    // Three partial unique indexes stand in the way of step 3:
    // special_dates_one_birthday_idx, special_dates_one_feast_day_idx, and
    // special_dates_anniversary_pair_idx. Where both records carry one, the
    // survivor's wins and the duplicate's is dropped -- and counted, so the
    // caller can say what was lost instead of losing it quietly.
    const { rows: droppedSingles } = await tx.query<{ type: string }>(
      `delete from special_dates
        where person_id = $1
          and type in ('BIRTHDAY', 'FEAST_DAY')
          and exists (
            select 1 from special_dates survivor
             where survivor.person_id = $2
               and survivor.type = special_dates.type
          )
      returning type`,
      [duplicatePersonId, accountPersonId]
    );

    const collided = await dropCollidingAnniversaries(tx, accountPersonId, duplicatePersonId);
    const discardedAnniversaries = selfMarried.length + collided;

    // --- 3. Everything else follows the person. -------------------------
    // Safe unconditionally now. `special_dates.organization_id` needs no
    // change: both people are in the same parish, which loadCandidate checked.
    await tx.query("update special_dates set person_id = $2 where person_id = $1", [
      duplicatePersonId,
      accountPersonId,
    ]);
    await tx.query("update special_dates set related_person_id = $2 where related_person_id = $1", [
      duplicatePersonId,
      accountPersonId,
    ]);

    // --- 4. Anyone inheriting *from* the duplicate. ---------------------
    // Re-pointed rather than cleared: a child who took the duplicate's surname
    // should follow the surviving record, not be silently blanked. The survivor
    // is excluded because pointing a row at itself violates
    // `persons_no_self_inheritance`; step 5 handles the survivor's own
    // pointers.
    for (const column of Object.values(INHERIT_COLUMN)) {
      await tx.query(
        `update persons
            set ${column} = $2
          where ${column} = $1
            and id <> $2
            and organization_id = $3`,
        [duplicatePersonId, accountPersonId, organizationId]
      );
    }

    // --- 5. The record itself. ------------------------------------------
    await tx.query(
      `update persons a
          set last_name    = coalesce(a.last_name, d.last_name),
              email        = coalesce(a.email, d.email),
              phone        = coalesce(a.phone, d.phone),
              alt_phone    = coalesce(a.alt_phone, d.alt_phone),
              patron_saint = coalesce(a.patron_saint, d.patron_saint),
              photo_key    = coalesce(a.photo_key, d.photo_key),
              family_id    = $3,
              -- The survivor takes over the duplicate's seat in the family's
              -- custom order, because to that family they are the same person.
              -- Moving into the duplicate's family with the survivor's own
              -- position would drop them somewhere arbitrary in a list the
              -- family had arranged by hand.
              family_order = case when $4 then d.family_order else a.family_order end,
              ${ADDRESS_COLUMNS.map(
                (c) => `${c} = case when ${SURVIVOR_HAS_ADDRESS} then a.${c} else d.${c} end`
              ).join(",\n              ")},
              ${inheritanceAssignments(familyId, movedFamily)}
         from persons d
        where a.id = $1 and d.id = $2`,
      [accountPersonId, duplicatePersonId, familyId, movedFamily]
    );

    // `first_name` is not-null on both rows, so the survivor's always stands
    // and there is nothing to coalesce.

    // Nothing is deleted from S3. If the survivor had no photo it has just
    // adopted the duplicate's `photo_key`, and if it had one the duplicate's
    // row still references its own -- soft-deleted rows keep their photos, the
    // same as the person-delete route. The adopted key still spells out the
    // duplicate's id (photos/{org}/person/{personId}/{ulid}/), which is
    // cosmetic: CloudFront signs per organization, and the next upload through
    // PUT /persons/:id/photo mints a fresh key under the survivor. That route's
    // prefix check would reject this key, which is why it is set here directly.

    // --- 6. Don't leave a family pointing at a deleted creator. ---------
    await tx.query(
      "update families set created_by_person_id = $2 where created_by_person_id = $1",
      [duplicatePersonId, accountPersonId]
    );

    // --- 7. Requests that are now moot. ---------------------------------
    await cancelPendingJoinRequests(tx, duplicatePersonId);
    // Only if they actually moved. A survivor who stayed put has not had any
    // outstanding request answered, so those are still live.
    if (movedFamily) await cancelPendingJoinRequests(tx, accountPersonId, familyId);
    await tx.query(
      `update person_merge_requests
          set status = 'CANCELLED', decided_at = now()
        where status = 'PENDING'
          and (account_person_id = any($1::uuid[]) or duplicate_person_id = any($1::uuid[]))`,
      [[accountPersonId, duplicatePersonId]]
    );

    // --- 8. Retire the duplicate. ---------------------------------------
    // After step 5, so the big UPDATE could still read the duplicate's
    // inheritance pointers; this sweeps whatever is left aimed at it, which
    // after step 4 is only the survivor's own retained pointers.
    await clearInheritanceFor(tx, duplicatePersonId);
    await tx.query("update persons set deleted_at = now() where id = $1", [duplicatePersonId]);

    return {
      personId: accountPersonId,
      mergedPersonId: duplicatePersonId,
      familyId,
      movedFamily,
      discardedBirthdays: droppedSingles.filter((r) => r.type === "BIRTHDAY").length,
      discardedFeastDays: droppedSingles.filter((r) => r.type === "FEAST_DAY").length,
      discardedAnniversaries,
    };
  });
}

/**
 * Scoped by organization, like `loadFacts` in routes/persons.ts: a person in
 * another parish has to be indistinguishable from one that does not exist, or
 * this answers "does this id exist?" for every other tenant.
 */
async function loadCandidate(
  q: Queryable,
  id: string,
  organizationId: string
): Promise<MergeCandidate> {
  const row = await one<MergeCandidate>(
    q,
    `select id, organization_id, family_id, app_user_id
       from persons
      where id = $1 and organization_id = $2 and deleted_at is null
        for update`,
    [id, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Person not found" });
  return row;
}

/**
 * Drops the duplicate's anniversaries whose partner the survivor is already
 * married to in the record, and returns how many.
 *
 * Done here rather than in SQL because the predicate is "the pair this row
 * *would* normalise to after step 3 already exists", and
 * `special_dates_anniversary_pair_idx` normalises with least()/greatest() over
 * two nullable columns. Expressing that as one DELETE is possible and
 * unreadable; this is the same decision, legibly.
 */
async function dropCollidingAnniversaries(
  q: Queryable,
  accountPersonId: string,
  duplicatePersonId: string
): Promise<number> {
  const { rows } = await q.query<{
    id: string;
    person_id: string;
    related_person_id: string | null;
  }>(
    `select id, person_id, related_person_id
       from special_dates
      where type = 'ANNIVERSARY'
        and (person_id = any($1::uuid[]) or related_person_id = any($1::uuid[]))`,
    [[accountPersonId, duplicatePersonId]]
  );

  // Rows naming both people are already gone (step 1), so every row here names
  // exactly one of them and "the other end" is unambiguous.
  const partnerOf = (row: (typeof rows)[number], self: string): string | null =>
    row.person_id === self ? row.related_person_id : row.person_id;
  const involves = (row: (typeof rows)[number], who: string): boolean =>
    row.person_id === who || row.related_person_id === who;

  const survivorPartners = new Set(
    rows.filter((r) => involves(r, accountPersonId)).map((r) => partnerOf(r, accountPersonId))
  );
  const colliding = rows
    .filter((r) => involves(r, duplicatePersonId))
    .filter((r) => survivorPartners.has(partnerOf(r, duplicatePersonId)));

  if (colliding.length > 0) {
    await q.query("delete from special_dates where id = any($1::uuid[])", [
      colliding.map((r) => r.id),
    ]);
  }
  return colliding.length;
}

/**
 * What happens to the survivor's five inheritance pointers.
 *
 * Moving family invalidates their own pointers -- they name people who are no
 * longer relatives -- which is exactly what `joinFamily` uses
 * `clearInheritanceFor` for. So the survivor adopts the duplicate's pointers
 * instead, which stay valid because they name members of the family being
 * joined and already satisfied the one-hop rule. `nullif` guards the case where
 * the duplicate inherited from the survivor, which would otherwise trip
 * `persons_no_self_inheritance`.
 *
 * Not moving family means the duplicate had none, and
 * `persons_inheritance_requires_family` guarantees its pointers are all null,
 * so there is nothing to adopt and the survivor keeps their own.
 */
function inheritanceAssignments(familyId: string | null, movedFamily: boolean): string {
  return INHERITABLE_ATTRIBUTES.map((attribute) => {
    const column = INHERIT_COLUMN[attribute];
    // No family, no inheritance -- persons_inheritance_requires_family.
    if (familyId === null) return `${column} = null`;
    if (movedFamily) return `${column} = nullif(d.${column}, a.id)`;
    return `${column} = a.${column}`;
  }).join(",\n              ");
}
