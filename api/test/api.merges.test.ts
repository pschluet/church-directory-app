import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createMergeRequest,
  createNonUserPerson,
  createOrganization,
  createUser,
  setInheritance,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

/**
 * Merging two records for the same person.
 *
 * The cast, and why each one is here:
 *
 *   holder    an account holder in no family -- the record that survives
 *   relative  an account holder in the Schlueter family -- raises route A,
 *             approves route B
 *   duplicate the account-less Schlueter member that is really `holder`
 *   outsider  an account holder in another family, so "not your merge" has
 *             somebody to be refused
 */
describe.skipIf(!hasDb)("merging duplicate people", () => {
  const db = () => testDb();
  let orgId: string;
  let otherOrgId: string;
  let schlueters: string;
  let holder: CreatedUser;
  let relative: CreatedUser;
  let outsider: CreatedUser;
  let admin: CreatedUser;
  let duplicate: string;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");
    schlueters = await createFamily(db(), orgId, "Schlueter");

    holder = await createUser(db(), {
      organizationId: orgId,
      familyId: null,
      email: "holder@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    relative = await createUser(db(), {
      organizationId: orgId,
      familyId: schlueters,
      email: "relative@test.example",
      firstName: "Maria",
      lastName: "Schlueter",
    });
    outsider = await createUser(db(), {
      organizationId: orgId,
      familyId: await createFamily(db(), orgId, "Popov"),
      email: "outsider@test.example",
      firstName: "Boris",
    });
    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
    });
    duplicate = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: schlueters,
      firstName: "Paul",
      lastName: "Schlueter",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  const request = (body: { accountPersonId: string | null; duplicatePersonId: string }) => body;

  const personRow = async (id: string) => {
    const { rows } = await db().query<{
      family_id: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      alt_phone: string | null;
      city: string | null;
      address_line1: string | null;
      patron_saint: string | null;
      photo_key: string | null;
      deleted_at: Date | null;
      inherit_last_name_from_person_id: string | null;
      inherit_address_from_person_id: string | null;
    }>("select * from persons where id = $1", [id]);
    return rows[0]!;
  };

  const statusOf = async (requestId: string): Promise<string> => {
    const { rows } = await db().query<{ status: string }>(
      "select status from person_merge_requests where id = $1",
      [requestId]
    );
    return rows[0]!.status;
  };

  const addDate = async (
    personId: string,
    type: "BIRTHDAY" | "FEAST_DAY" | "ANNIVERSARY",
    extra: { month?: number; day?: number; year?: number; relatedPersonId?: string } = {}
  ): Promise<string> => {
    const { rows } = await db().query<{ id: string }>(
      `insert into special_dates (organization_id, person_id, related_person_id, type, month, day, year)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        orgId,
        personId,
        extra.relatedPersonId ?? null,
        type,
        extra.month ?? 4,
        extra.day ?? 12,
        type === "FEAST_DAY" ? null : (extra.year ?? 1980),
      ]
    );
    return rows[0]!.id;
  };

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------
  describe("asking", () => {
    it("lets a family member of the duplicate raise a request", async () => {
      const { status, body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      expect(status).toBe(201);
      expect(body.status).toBe("PENDING");
      // Nothing has happened to either record yet.
      expect((await personRow(duplicate)).deleted_at).toBeNull();
      expect((await personRow(holder.personId!)).family_id).toBeNull();
    });

    it("lets the account holder raise a request about their own record", async () => {
      const { status, body } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect(status).toBe(201);
      expect(body.status).toBe("PENDING");
    });

    it("refuses someone with no claim on either record", async () => {
      const { status } = await as(outsider).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect(status).toBe(403);
    });

    it("refuses to merge two accounts", async () => {
      const { status, body } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: relative.personId! })
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/both of those people have an account/i);
    });

    it("refuses the two records the wrong way round", async () => {
      const { status, body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: duplicate, duplicatePersonId: holder.personId! })
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/must be the one with an account/i);
    });

    it("refuses to merge someone with themselves", async () => {
      const { status } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: holder.personId! })
      );
      expect(status).toBe(400);
    });

    it("never reaches into another parish", async () => {
      const elsewhere = await createNonUserPerson(db(), {
        organizationId: otherOrgId,
        familyId: null,
        firstName: "Stranger",
      });
      const { status } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: elsewhere })
      );
      expect(status).toBe(404);
    });

    it("allows only one pending request per person", async () => {
      await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      const second = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Pavel",
      });
      const { status, body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: second })
      );
      expect(status).toBe(409);
      expect(body.error).toMatch(/already a pending merge/i);
    });
  });

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------
  describe("deciding", () => {
    it("merges once the account holder approves a request from the family", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      const decided = await as(holder).call("POST", `/api/merges/${body.id}/approve`);
      expect(decided.status).toBe(200);
      expect(decided.body.status).toBe("APPROVED");
      expect(decided.body.result.personId).toBe(holder.personId);
      expect(decided.body.result.movedFamily).toBe(true);

      expect((await personRow(duplicate)).deleted_at).not.toBeNull();
      expect((await personRow(holder.personId!)).family_id).toBe(schlueters);
    });

    it("merges once another family member approves the account holder's request", async () => {
      const { body } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      const decided = await as(relative).call("POST", `/api/merges/${body.id}/approve`);
      expect(decided.status).toBe(200);
      expect((await personRow(duplicate)).deleted_at).not.toBeNull();
    });

    it("will not let the family member who asked approve their own request", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      const { status } = await as(relative).call("POST", `/api/merges/${body.id}/approve`);
      expect(status).toBe(403);
      expect((await personRow(duplicate)).deleted_at).toBeNull();
    });

    it("merges on the spot when the account holder is in the duplicate's family", async () => {
      // Route B, and the account holder is *also* in the duplicate's family, so
      // they are on both sides and there is nobody else the claim is about.
      // Nothing to approve, and -- where they are the family's only account
      // holder -- nobody who could have.
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        schlueters,
      ]);

      const { status, body } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      expect(status).toBe(201);
      expect(body.status).toBe("APPROVED");
      expect((await personRow(duplicate)).deleted_at).not.toBeNull();

      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from person_merge_requests"
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("records the both-sides merge as a merge, not as a request", async () => {
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        schlueters,
      ]);
      await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      const { rows } = await db().query<{ action: string }>(
        "select action from audit_log where entity_type = 'person' order by id"
      );
      // `person.merge` is "merged with nobody to ask", which is exactly what
      // happened -- writing `person.mergeRequest` would claim an approval step
      // that never existed.
      expect(rows.map((r) => r.action)).toEqual(["person.merge"]);
    });

    it("lets the requester decide a request that stranded them on both sides", async () => {
      // The row a stalled request left behind: written while the account holder
      // was outside the family, so it needed an approver, and still pending now
      // that they are inside it and need none. The SPA hides the offer to ask
      // again while one is pending, so this is the only way out that is not an
      // admin.
      const stranded = await createMergeRequest(db(), {
        organizationId: orgId,
        accountPersonId: holder.personId!,
        duplicatePersonId: duplicate,
        requestedByPersonId: holder.personId!,
      });
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        schlueters,
      ]);

      const { status } = await as(holder).call("POST", `/api/merges/${stranded}/approve`);
      expect(status).toBe(200);
      expect(await statusOf(stranded)).toBe("APPROVED");
      expect((await personRow(duplicate)).deleted_at).not.toBeNull();
    });

    it("still needs an approver when the duplicate is in another family", async () => {
      // The account holder is in a family, just not the duplicate's, so they
      // may not edit that record and only hold one side of the claim.
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        await createFamily(db(), orgId, "Novak"),
      ]);
      const { body } = await as(holder).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

      expect(body.status).toBe("PENDING");
      expect((await as(holder).call("POST", `/api/merges/${body.id}/approve`)).status).toBe(403);
      expect((await personRow(duplicate)).deleted_at).toBeNull();
    });

    it("refuses an outsider", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect((await as(outsider).call("POST", `/api/merges/${body.id}/approve`)).status).toBe(403);
    });

    it("lets an admin decide someone else's request", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect((await as(admin).call("POST", `/api/merges/${body.id}/approve`)).status).toBe(200);
    });

    it("records a denial and leaves both records alone", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      const decided = await as(holder).call("POST", `/api/merges/${body.id}/deny`);
      expect(decided.body.status).toBe("DENIED");
      expect(await statusOf(body.id)).toBe("DENIED");
      expect((await personRow(duplicate)).deleted_at).toBeNull();
    });

    it("refuses to decide the same request twice", async () => {
      const { body } = await as(relative).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      await as(holder).call("POST", `/api/merges/${body.id}/deny`);
      const again = await as(holder).call("POST", `/api/merges/${body.id}/approve`);
      expect(again.status).toBe(409);
    });

    it("merges immediately for an admin, with no request to approve", async () => {
      const { status, body } = await as(admin).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect(status).toBe(201);
      expect(body.status).toBe("APPROVED");
      expect((await personRow(duplicate)).deleted_at).not.toBeNull();

      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from person_merge_requests"
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("cancels a competing request when one of them goes through", async () => {
      const other = await createUser(db(), {
        organizationId: orgId,
        familyId: schlueters,
        email: "other@test.example",
        firstName: "Nikolai",
      });
      const competing = await createMergeRequest(db(), {
        organizationId: orgId,
        accountPersonId: other.personId!,
        duplicatePersonId: duplicate,
        requestedByPersonId: relative.personId!,
      });

      await as(admin).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );
      expect(await statusOf(competing)).toBe("CANCELLED");
    });
  });

  // -------------------------------------------------------------------------
  // What the merge actually does
  // -------------------------------------------------------------------------
  describe("the merge itself", () => {
    const mergeAsAdmin = () =>
      as(admin).call(
        "POST",
        "/api/merges",
        request({ accountPersonId: holder.personId, duplicatePersonId: duplicate })
      );

    it("keeps the account holder's values and fills only their blanks", async () => {
      await db().query("update persons set phone = $2, patron_saint = $3 where id = $1", [
        holder.personId,
        "+13125551234",
        "Paul the Apostle",
      ]);
      // Note the account holder's `email` is never blank -- the invite flow
      // seeds it from the sign-in address -- so `alt_phone` is the field that
      // actually exercises "fill the blanks".
      await db().query("update persons set phone = $2, alt_phone = $3 where id = $1", [
        duplicate,
        "+13125559999",
        "+13125550000",
      ]);

      await mergeAsAdmin();
      const merged = await personRow(holder.personId!);
      // Theirs wins where they had one...
      expect(merged.phone).toBe("+13125551234");
      expect(merged.patron_saint).toBe("Paul the Apostle");
      expect(merged.email).toBe("holder@test.example");
      // ...and the duplicate fills what they left blank.
      expect(merged.alt_phone).toBe("+13125550000");
    });

    it("moves the address as a block rather than splicing two together", async () => {
      await db().query("update persons set city = $2 where id = $1", [holder.personId, "Evanston"]);
      await db().query("update persons set address_line1 = $2, city = $3 where id = $1", [
        duplicate,
        "4129 W Newport Ave",
        "Chicago",
      ]);

      await mergeAsAdmin();
      const merged = await personRow(holder.personId!);
      // The survivor had *part* of an address, so theirs stands whole -- the
      // duplicate's street must not be grafted onto their city.
      expect(merged.city).toBe("Evanston");
      expect(merged.address_line1).toBeNull();
    });

    it("takes the whole address when the survivor has none at all", async () => {
      await db().query("update persons set address_line1 = $2, city = $3 where id = $1", [
        duplicate,
        "4129 W Newport Ave",
        "Chicago",
      ]);
      await mergeAsAdmin();
      const merged = await personRow(holder.personId!);
      expect(merged.address_line1).toBe("4129 W Newport Ave");
      expect(merged.city).toBe("Chicago");
    });

    it("leaves the survivor's family alone when the duplicate has none", async () => {
      const popovs = await createFamily(db(), orgId, "Popov II");
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        popovs,
      ]);
      await db().query("update persons set family_id = null where id = $1", [duplicate]);

      const { body } = await mergeAsAdmin();
      expect(body.result.movedFamily).toBe(false);
      expect((await personRow(holder.personId!)).family_id).toBe(popovs);
    });

    it("re-points a relative who was inheriting from the duplicate", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      await setInheritance(db(), child, { lastName: duplicate });

      await mergeAsAdmin();
      expect((await personRow(child)).inherit_last_name_from_person_id).toBe(holder.personId);
    });

    it("clears the survivor's own pointers when they change family", async () => {
      const popovs = await createFamily(db(), orgId, "Popov II");
      const cousin = await createUser(db(), {
        organizationId: orgId,
        familyId: popovs,
        email: "cousin@test.example",
        firstName: "Ivan",
      });
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        popovs,
      ]);
      await setInheritance(db(), holder.personId!, { address: cousin.personId! });

      await mergeAsAdmin();
      const merged = await personRow(holder.personId!);
      expect(merged.family_id).toBe(schlueters);
      // Ivan is not a relative any more, so the pointer cannot survive.
      expect(merged.inherit_address_from_person_id).toBeNull();
    });

    it("moves the duplicate's birthday when the survivor has none", async () => {
      await addDate(duplicate, "BIRTHDAY", { month: 7, day: 3, year: 1979 });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedBirthdays).toBe(0);
      const { rows } = await db().query<{ month: number }>(
        "select month from special_dates where person_id = $1 and type = 'BIRTHDAY'",
        [holder.personId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.month).toBe(7);
    });

    it("keeps the survivor's birthday and reports the one it discarded", async () => {
      await addDate(holder.personId!, "BIRTHDAY", { month: 1, day: 1, year: 1980 });
      await addDate(duplicate, "BIRTHDAY", { month: 7, day: 3, year: 1979 });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedBirthdays).toBe(1);
      const { rows } = await db().query<{ month: number }>(
        "select month from special_dates where person_id = $1 and type = 'BIRTHDAY'",
        [holder.personId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.month).toBe(1);
    });

    it("keeps the survivor's feast day and reports the one it discarded", async () => {
      await addDate(holder.personId!, "FEAST_DAY", { month: 6, day: 29 });
      await addDate(duplicate, "FEAST_DAY", { month: 8, day: 15 });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedFeastDays).toBe(1);
      const { rows } = await db().query<{ month: number }>(
        "select month from special_dates where person_id = $1 and type = 'FEAST_DAY'",
        [holder.personId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.month).toBe(6);
    });

    it("carries the duplicate's anniversary over to the survivor", async () => {
      await addDate(duplicate, "ANNIVERSARY", {
        month: 6,
        day: 21,
        year: 2005,
        relatedPersonId: relative.personId!,
      });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedAnniversaries).toBe(0);
      const { rows } = await db().query<{ person_id: string; related_person_id: string }>(
        "select person_id, related_person_id from special_dates where type = 'ANNIVERSARY'"
      );
      expect(rows).toHaveLength(1);
      expect([rows[0]!.person_id, rows[0]!.related_person_id]).toContain(holder.personId);
      expect([rows[0]!.person_id, rows[0]!.related_person_id]).toContain(relative.personId);
    });

    it("deletes an anniversary recorded between the two records", async () => {
      // A data error: somebody married to their own duplicate. It cannot be
      // re-pointed, because special_dates_related_person_differs forbids it.
      await addDate(holder.personId!, "ANNIVERSARY", {
        month: 6,
        day: 21,
        year: 2005,
        relatedPersonId: duplicate,
      });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedAnniversaries).toBe(1);
      const { rows } = await db().query("select id from special_dates where type = 'ANNIVERSARY'");
      expect(rows).toHaveLength(0);
    });

    it("drops one of two anniversaries with the same partner", async () => {
      await addDate(holder.personId!, "ANNIVERSARY", {
        month: 6,
        day: 21,
        year: 2005,
        relatedPersonId: relative.personId!,
      });
      await addDate(duplicate, "ANNIVERSARY", {
        month: 6,
        day: 22,
        year: 2006,
        relatedPersonId: relative.personId!,
      });

      const { body } = await mergeAsAdmin();
      expect(body.result.discardedAnniversaries).toBe(1);
      const { rows } = await db().query<{ day: number }>(
        "select day from special_dates where type = 'ANNIVERSARY'"
      );
      expect(rows).toHaveLength(1);
      // The survivor's own is the one that stands.
      expect(rows[0]!.day).toBe(21);
    });

    it("adopts the duplicate's photo only when the survivor has none", async () => {
      await db().query("update persons set photo_key = $2 where id = $1", [
        duplicate,
        `photos/${orgId}/person/${duplicate}/01H/`,
      ]);
      await mergeAsAdmin();
      expect((await personRow(holder.personId!)).photo_key).toContain(duplicate);
    });

    it("keeps the survivor's photo when they have one", async () => {
      const own = `photos/${orgId}/person/${holder.personId}/01G/`;
      await db().query("update persons set photo_key = $2 where id = $1", [holder.personId, own]);
      await db().query("update persons set photo_key = $2 where id = $1", [
        duplicate,
        `photos/${orgId}/person/${duplicate}/01H/`,
      ]);
      await mergeAsAdmin();
      expect((await personRow(holder.personId!)).photo_key).toBe(own);
    });

    it("does not leave a family pointing at the deleted record as its creator", async () => {
      await db().query("update families set created_by_person_id = $2 where id = $1", [
        schlueters,
        duplicate,
      ]);
      await mergeAsAdmin();
      const { rows } = await db().query<{ created_by_person_id: string }>(
        "select created_by_person_id from families where id = $1",
        [schlueters]
      );
      expect(rows[0]!.created_by_person_id).toBe(holder.personId);
    });

    it("cancels a join request the duplicate had outstanding", async () => {
      const popovs = await createFamily(db(), orgId, "Popov II");
      await db().query(
        `insert into family_join_requests (organization_id, family_id, person_id)
         values ($1, $2, $3)`,
        [orgId, popovs, duplicate]
      );

      await mergeAsAdmin();
      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [duplicate]
      );
      expect(rows[0]!.status).toBe("CANCELLED");
    });

    it("takes the duplicate out of the directory but keeps the row", async () => {
      await mergeAsAdmin();

      expect((await as(relative).call("GET", `/api/persons/${duplicate}`)).status).toBe(404);

      const search = await as(relative).call("GET", "/api/directory/search?q=Paul");
      expect(search.body.people.map((p: { id: string }) => p.id)).not.toContain(duplicate);

      const lookup = await as(relative).call("GET", "/api/directory/lookup?q=Paul");
      expect(lookup.body.people.map((p: { id: string }) => p.id)).not.toContain(duplicate);

      // Kept, not removed -- data is retained forever.
      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from persons where id = $1",
        [duplicate]
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Finding requests
  // -------------------------------------------------------------------------
  describe("GET /api/merges/pending", () => {
    let requestId: string;

    beforeEach(async () => {
      // Route A: the family asked, so the account holder decides.
      requestId = await createMergeRequest(db(), {
        organizationId: orgId,
        accountPersonId: holder.personId!,
        duplicatePersonId: duplicate,
        requestedByPersonId: relative.personId!,
      });
    });

    const pendingFor = async (u: CreatedUser) => {
      const { body } = await as(u).call("GET", "/api/merges/pending");
      return body.mergeRequests as Array<{ id: string; canDecide: boolean }>;
    };

    it("tells the account holder it is theirs to decide", async () => {
      const rows = await pendingFor(holder);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(requestId);
      expect(rows[0]!.canDecide).toBe(true);
    });

    it("shows the requester their own request without letting them decide it", async () => {
      const rows = await pendingFor(relative);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.canDecide).toBe(false);
    });

    it("hides it from everyone else", async () => {
      expect(await pendingFor(outsider)).toEqual([]);
    });

    it("shows an admin every request in the parish", async () => {
      const rows = await pendingFor(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.canDecide).toBe(true);
    });

    it("names both people and the family, so a banner needs no second call", async () => {
      const { body } = await as(holder).call("GET", "/api/merges/pending");
      expect(body.mergeRequests[0]).toMatchObject({
        accountPersonName: "Paul Schlueter",
        duplicatePersonName: "Paul Schlueter",
        duplicateFamilyName: "Schlueter",
        requestedByPersonName: "Maria Schlueter",
        status: "PENDING",
      });
    });

    it("lets the duplicate's family decide when the account holder asked", async () => {
      await db().query("delete from person_merge_requests where id = $1", [requestId]);
      const routeB = await createMergeRequest(db(), {
        organizationId: orgId,
        accountPersonId: holder.personId!,
        duplicatePersonId: duplicate,
        requestedByPersonId: holder.personId!,
      });

      const forRelative = await pendingFor(relative);
      expect(forRelative).toHaveLength(1);
      expect(forRelative[0]!.id).toBe(routeB);
      expect(forRelative[0]!.canDecide).toBe(true);

      // And the account holder who asked cannot wave it through.
      expect((await pendingFor(holder))[0]!.canDecide).toBe(false);
    });

    it("tells a requester on both sides of it that it is theirs to decide", async () => {
      await db().query("delete from person_merge_requests where id = $1", [requestId]);
      const routeB = await createMergeRequest(db(), {
        organizationId: orgId,
        accountPersonId: holder.personId!,
        duplicatePersonId: duplicate,
        requestedByPersonId: holder.personId!,
      });
      // Now in the duplicate's family, so both halves of the claim are theirs
      // and the banner has to offer the button rather than "waiting to be
      // approved" with nothing behind it.
      await db().query("update persons set family_id = $2 where id = $1", [
        holder.personId,
        schlueters,
      ]);

      const rows = await pendingFor(holder);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(routeB);
      expect(rows[0]!.canDecide).toBe(true);
    });
  });
});
