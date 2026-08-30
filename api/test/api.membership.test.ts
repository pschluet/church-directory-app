import { afterAll, beforeEach, describe, expect, it, inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createNonUserPerson,
  createOrganization,
  createUser,
  setInheritance,
  type CreatedUser,
} from "./helpers/fixtures";

/**
 * Moving an account between parishes, and giving a parish-less super admin a
 * directory record.
 *
 * A `persons` row is tied to a lot of parish-scoped data that no database
 * constraint protects -- family membership, inheritance in both directions, the
 * denormalized organization on special dates, join requests. These tests are
 * mostly about that data being dealt with rather than left dangling in the
 * parish the person just left.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("parish membership", () => {
  const db = () => testDb();
  let allSaints: string;
  let stGeorge: string;
  let superAdmin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    allSaints = await createOrganization(db(), "All Saints", "all-saints");
    stGeorge = await createOrganization(db(), "St. George", "st-george");
    superAdmin = await createUser(db(), {
      organizationId: null,
      role: "SUPER_ADMIN",
      email: "super@test.example",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  const personRow = async (personId: string) =>
    (
      await db().query<{
        organization_id: string;
        family_id: string | null;
        inherit_address_from_person_id: string | null;
        photo_key: string | null;
      }>(
        `select organization_id, family_id, inherit_address_from_person_id, photo_key
           from persons where id = $1`,
        [personId]
      )
    ).rows[0]!;

  describe("a super admin adopting a parish", () => {
    it("starts with no directory record at all", async () => {
      const { body } = await as(superAdmin).call("GET", "/api/me");
      expect(body.appUser.personId).toBeNull();
      expect(body.appUser.organizationId).toBeNull();
      expect(body.person).toBeNull();
    });

    it("creates their record in the parish they choose", async () => {
      const { status, body } = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
        lastName: "Schlueter",
      });

      expect(status).toBe(200);
      expect(body.move.created).toBe(true);
      expect(body.move.movedFrom).toBeNull();
      expect(body.appUser.organizationId).toBe(allSaints);
      expect(body.appUser.organizationName).toBe("All Saints");
      expect(body.person.firstName).toBe("Paul");
      expect(body.person.lastName).toBe("Schlueter");
      // Their own record, so of course they can edit it.
      expect(body.person.canEdit).toBe(true);
    });

    it("puts them in that parish's directory, visible to its members", async () => {
      await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
        lastName: "Schlueter",
      });

      const member = await createUser(db(), {
        organizationId: allSaints,
        email: "member@test.example",
        firstName: "Maria",
      });
      const { body } = await as(member).call("GET", "/api/directory");
      expect(body.people.map((p: any) => p.firstName)).toContain("Paul");
    });

    it("refuses a name-less request", async () => {
      const { status } = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
      });
      expect(status).toBe(400);
    });

    it("refuses a parish that does not exist", async () => {
      const { status } = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: "6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e",
        firstName: "Paul",
      });
      expect(status).toBe(404);
    });

    it("is a no-op when they are already in that parish", async () => {
      const first = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
      });
      const again = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
      });

      expect(again.status).toBe(200);
      expect(again.body.move.created).toBe(false);
      expect(again.body.move.movedFrom).toBeNull();
      expect(again.body.appUser.personId).toBe(first.body.appUser.personId);
    });

    it("is refused to anyone who is not a super admin", async () => {
      const admin = await createUser(db(), {
        organizationId: allSaints,
        role: "ADMIN",
        email: "admin@test.example",
      });
      const member = await createUser(db(), {
        organizationId: allSaints,
        email: "member2@test.example",
      });

      for (const user of [admin, member]) {
        const { status } = await as(user).call("PUT", "/api/me/organization", {
          organizationId: stGeorge,
          firstName: "Nope",
        });
        expect(status).toBe(403);
      }
    });
  });

  describe("GET /api/me while viewing another parish", () => {
    it("still returns the caller's own record", async () => {
      const created = await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
      });
      const personId = created.body.appUser.personId;

      // Switch the viewing lens to the other parish.
      const { body } = await as(superAdmin).call("GET", `/api/me?orgId=${stGeorge}`);

      expect(body.organization.name).toBe("St. George");
      // The account still belongs to All Saints...
      expect(body.appUser.organizationName).toBe("All Saints");
      // ...and their own record is still reachable, which is the regression.
      expect(body.person).not.toBeNull();
      expect(body.person.id).toBe(personId);
      expect(body.person.canEdit).toBe(true);
    });
  });

  describe("moving an account to another parish", () => {
    let mover: CreatedUser;
    let spouse: CreatedUser;
    let child: string;
    let familyId: string;
    let personId: string;

    beforeEach(async () => {
      familyId = await createFamily(db(), allSaints, "Schlueter");
      mover = await createUser(db(), {
        organizationId: allSaints,
        familyId,
        email: "mover@test.example",
        firstName: "Paul",
        lastName: "Schlueter",
      });
      spouse = await createUser(db(), {
        organizationId: allSaints,
        familyId,
        email: "spouse@test.example",
        firstName: "Maria",
        lastName: "Schlueter",
      });
      personId = mover.personId!;

      // A child who inherits from the mover -- the inbound direction.
      child = await createNonUserPerson(db(), {
        organizationId: allSaints,
        familyId,
        firstName: "Anna",
      });
      await setInheritance(db(), child, { address: personId, lastName: personId });
      // ...and the mover inheriting from the spouse -- the outbound direction.
      await setInheritance(db(), personId, { altPhone: spouse.personId! });

      await db().query("update persons set photo_key = $2 where id = $1", [
        personId,
        `photos/${allSaints}/person/${personId}/01ABCDEF.png`,
      ]);
      await db().query("update families set created_by_person_id = $2 where id = $1", [
        familyId,
        personId,
      ]);

      // A birthday and a feast day, which should follow; and an anniversary
      // with the spouse, which cannot.
      await db().query(
        `insert into special_dates (organization_id, person_id, type, month, day, year, show_year_count)
         values ($1, $2, 'BIRTHDAY', 5, 4, 1985, true)`,
        [allSaints, personId]
      );
      await db().query(
        `insert into special_dates (organization_id, person_id, type, month, day)
         values ($1, $2, 'FEAST_DAY', 6, 29)`,
        [allSaints, personId]
      );
      await db().query(
        `insert into special_dates (organization_id, person_id, related_person_id, type, month, day, year)
         values ($1, $2, $3, 'ANNIVERSARY', 6, 12, 2010)`,
        [allSaints, personId, spouse.personId]
      );
    });

    const move = () =>
      as(superAdmin).call("PATCH", `/api/admin/users/${mover.appUserId}`, {
        organizationId: stGeorge,
      });

    it("carries the directory record across, not just the account", async () => {
      const { status, body } = await move();
      expect(status).toBe(200);
      expect(body.organizationName).toBe("St. George");
      expect(body.move.movedFrom).toBe(allSaints);
      // This is the bug: the record used to stay behind.
      expect((await personRow(personId)).organization_id).toBe(stGeorge);
    });

    it("drops family membership, which cannot span parishes", async () => {
      await move();
      expect((await personRow(personId)).family_id).toBeNull();
    });

    it("clears inheritance in both directions", async () => {
      await move();
      // Outbound: what the mover was inheriting.
      expect((await personRow(personId)).inherit_address_from_person_id).toBeNull();
      // Inbound: the child who inherited from them. Leaving this would serve
      // one parish's address to another parish's member.
      const childRow = await personRow(child);
      expect(childRow.inherit_address_from_person_id).toBeNull();
      const { rows } = await db().query<{ inherit_last_name_from_person_id: string | null }>(
        "select inherit_last_name_from_person_id from persons where id = $1",
        [child]
      );
      expect(rows[0]!.inherit_last_name_from_person_id).toBeNull();
    });

    it("moves the dates that can move and reports the anniversary it removed", async () => {
      const { body } = await move();
      expect(body.move.removedAnniversaries).toBe(1);

      const { rows } = await db().query<{ type: string; organization_id: string }>(
        "select type, organization_id from special_dates where person_id = $1 order by type",
        [personId]
      );
      expect(rows.map((r) => r.type)).toEqual(["BIRTHDAY", "FEAST_DAY"]);
      // The denormalized column has to follow, or the dates vanish from the new
      // parish's calendar and linger in the old one's.
      for (const row of rows) expect(row.organization_id).toBe(stGeorge);
    });

    it("stops the old parish's family pointing at them as its creator", async () => {
      await move();
      const { rows } = await db().query<{ created_by_person_id: string | null }>(
        "select created_by_person_id from families where id = $1",
        [familyId]
      );
      expect(rows[0]!.created_by_person_id).toBeNull();
    });

    it("cancels any request they had pending to join a family", async () => {
      const otherFamily = await createFamily(db(), allSaints, "Popov");
      await db().query(
        `insert into family_join_requests (organization_id, family_id, person_id)
         values ($1, $2, $3)`,
        [allSaints, otherFamily, personId]
      );

      await move();
      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [personId]
      );
      expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);
    });

    it("takes them out of the old parish's directory and into the new one", async () => {
      await move();

      const oldMember = await createUser(db(), {
        organizationId: allSaints,
        email: "old@test.example",
        firstName: "Boris",
      });
      const newMember = await createUser(db(), {
        organizationId: stGeorge,
        email: "new@test.example",
        firstName: "Dimitar",
      });

      const oldList = await as(oldMember).call("GET", "/api/directory");
      expect(oldList.body.people.map((p: any) => p.firstName)).not.toContain("Paul");

      const newList = await as(newMember).call("GET", "/api/directory");
      expect(newList.body.people.map((p: any) => p.firstName)).toContain("Paul");
    });

    it("lets them edit their own details again afterwards", async () => {
      await move();
      // Before the fix their record stayed in the old parish while their account
      // moved, so canEditPerson's organization comparison locked them out.
      const { body } = await as(mover).call("GET", "/api/me");
      expect(body.person.canEdit).toBe(true);

      const { status } = await as(mover).call("PATCH", `/api/persons/${personId}`, {
        city: "Chicago",
      });
      expect(status).toBe(200);
    });

    it("creates a record when the account never had one", async () => {
      const orgless = await createUser(db(), {
        organizationId: null,
        role: "SUPER_ADMIN",
        email: "orgless@test.example",
      });

      const withoutName = await as(superAdmin).call(
        "PATCH",
        `/api/admin/users/${orgless.appUserId}`,
        { organizationId: stGeorge }
      );
      expect(withoutName.status).toBe(400);

      const withName = await as(superAdmin).call("PATCH", `/api/admin/users/${orgless.appUserId}`, {
        organizationId: stGeorge,
        firstName: "New",
        lastName: "Admin",
      });
      expect(withName.status).toBe(200);
      expect(withName.body.move.created).toBe(true);
      expect(withName.body.personName).toBe("New Admin");
    });

    it("refuses to strip a parish off an account entirely", async () => {
      const { status } = await as(superAdmin).call("PATCH", `/api/admin/users/${mover.appUserId}`, {
        organizationId: null,
      });
      expect(status).toBe(400);
    });
  });

  describe("cross-parish family join", () => {
    it("refuses to put a person into another parish's family", async () => {
      await as(superAdmin).call("PUT", "/api/me/organization", {
        organizationId: allSaints,
        firstName: "Paul",
      });
      const foreignFamily = await createFamily(db(), stGeorge, "Georgiev");

      // A super admin bypasses the approval flow, so this is the path that
      // would otherwise have moved their All Saints record into a St. George
      // family.
      const { status, body } = await as(superAdmin).call(
        "POST",
        `/api/families/${foreignFamily}/join-requests?orgId=${stGeorge}`
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/different church/i);
    });
  });
});
