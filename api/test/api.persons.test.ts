import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createNonUserPerson,
  createOrganization,
  createUser,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("people and attribute inheritance", () => {
  const db = () => testDb();
  let orgId: string;
  let familyId: string;
  let otherFamilyId: string;
  let parent: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    familyId = await createFamily(db(), orgId, "Schlueter");
    otherFamilyId = await createFamily(db(), orgId, "Popov");
    parent = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "parent@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    await db().query(
      `update persons
          set email = 'paul@example.com', phone = '+13125551234',
              alt_phone = '+13125559999', address_line1 = '4129 W Newport Ave',
              city = 'Chicago', state = 'IL', postal_code = '60641'
        where id = $1`,
      [parent.personId]
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  it("creates a family member with no account", async () => {
    const { status, body } = await as(parent).call("POST", "/api/persons", {
      firstName: "Anna",
      familyId,
    });
    expect(status).toBe(201);
    expect(body.appUserId).toBeNull();
    expect(body.familyName).toBe("Schlueter");
    expect(body.canEdit).toBe(true);
  });

  it("refuses to create someone in a family the caller is not in", async () => {
    const { status } = await as(parent).call("POST", "/api/persons", {
      firstName: "Ivan",
      familyId: otherFamilyId,
    });
    expect(status).toBe(403);
  });

  describe("inheritance", () => {
    let child: string;

    beforeEach(async () => {
      const created = await as(parent).call("POST", "/api/persons", {
        firstName: "Anna",
        familyId,
      });
      child = created.body.id;
    });

    it("serves the parent's values once inheritance is set", async () => {
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritLastNameFromPersonId: parent.personId,
        inheritEmailFromPersonId: parent.personId,
        inheritPhoneFromPersonId: parent.personId,
        inheritAddressFromPersonId: parent.personId,
      });

      expect(status).toBe(200);
      expect(body.lastName).toBe("Schlueter");
      expect(body.email).toBe("paul@example.com");
      expect(body.phone).toBe("+13125551234");
      expect(body.city).toBe("Chicago");
      expect(body.inheritedFrom.address.name).toBe("Paul Schlueter");
    });

    it("follows the parent when the parent's value changes", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritAddressFromPersonId: parent.personId,
      });
      await as(parent).call("PATCH", `/api/persons/${parent.personId}`, { city: "Evanston" });

      const { body } = await as(parent).call("GET", `/api/persons/${child}`);
      expect(body.city).toBe("Evanston");
    });

    it("restores the child's own value when inheritance is switched off", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        email: "anna@example.com",
        inheritEmailFromPersonId: parent.personId,
      });
      const inherited = await as(parent).call("GET", `/api/persons/${child}`);
      expect(inherited.body.email).toBe("paul@example.com");

      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: null,
      });
      const own = await as(parent).call("GET", `/api/persons/${child}`);
      expect(own.body.email).toBe("anna@example.com");
    });

    it("refuses a source outside the family", async () => {
      const outsider = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: otherFamilyId,
        firstName: "Ivan",
      });
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: outsider,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/same family/i);
    });

    it("refuses to inherit from yourself", async () => {
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: child,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/from yourself/i);
    });

    it("refuses a chain, so no cycle can form", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: parent.personId,
      });
      const second = await as(parent).call("POST", "/api/persons", {
        firstName: "Nikolai",
        familyId,
      });

      const { status, body } = await as(parent).call("PATCH", `/api/persons/${second.body.id}`, {
        inheritEmailFromPersonId: child,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/already inherits/i);
    });

    it("drops inheritance when the child leaves the family", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritAddressFromPersonId: parent.personId,
        inheritLastNameFromPersonId: parent.personId,
      });

      const { status } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      // Moving into a family the caller is not in is not allowed...
      expect(status).toBe(403);

      // ...but an admin can, and then the inheritance must be gone.
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        email: "admin@test.example",
      });
      const moved = await as(admin).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.inheritedFrom).toEqual({});
      expect(moved.body.city).toBeNull();
    });

    it("cancels stale join requests when an admin moves someone", async () => {
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        email: "mover@test.example",
      });
      await db().query(
        `insert into family_join_requests (organization_id, family_id, person_id)
         values ($1, $2, $3)`,
        [orgId, familyId, child]
      );

      const moved = await as(admin).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      expect(moved.status).toBe(200);

      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [child]
      );
      expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);
    });

    it("clears inheritance pointing at someone who is deleted", async () => {
      const sibling = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Nikolai",
      });
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: sibling,
      });

      const deleted = await as(parent).call("DELETE", `/api/persons/${sibling}`);
      expect(deleted.status).toBe(204);

      const { body } = await as(parent).call("GET", `/api/persons/${child}`);
      expect(body.inheritedFrom).toEqual({});
    });
  });

  describe("updates", () => {
    it("only writes the fields the request mentions", async () => {
      await as(parent).call("PATCH", `/api/persons/${parent.personId}`, { city: "Evanston" });
      const { body } = await as(parent).call("GET", `/api/persons/${parent.personId}`);
      expect(body.city).toBe("Evanston");
      // Untouched by the PATCH.
      expect(body.phone).toBe("+13125551234");
      expect(body.addressLine1).toBe("4129 W Newport Ave");
    });

    it("rejects a phone number that is not E.164", async () => {
      const { status } = await as(parent).call("PATCH", `/api/persons/${parent.personId}`, {
        phone: "312-555-1234",
      });
      expect(status).toBe(400);
    });
  });

  describe("deletion", () => {
    it("soft-deletes a family member with no account", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      expect((await as(parent).call("DELETE", `/api/persons/${child}`)).status).toBe(204);
      expect((await as(parent).call("GET", `/api/persons/${child}`)).status).toBe(404);

      // Kept, not removed -- data is retained forever.
      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from persons where id = $1",
        [child]
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("refuses to delete someone who has an account", async () => {
      const { status, body } = await as(parent).call("DELETE", `/api/persons/${parent.personId}`);
      expect(status).toBe(400);
      expect(body.error).toMatch(/disable the account/i);
    });

    it("refuses someone outside the family", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      const stranger = await createUser(db(), {
        organizationId: orgId,
        familyId: otherFamilyId,
        email: "stranger@test.example",
      });

      expect((await as(stranger).call("DELETE", `/api/persons/${child}`)).status).toBe(403);
      expect((await as(parent).call("GET", `/api/persons/${child}`)).status).toBe(200);
    });

    it("lets an admin delete someone in a family they are not in", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        familyId: otherFamilyId,
        email: "admin@test.example",
      });

      expect((await as(admin).call("DELETE", `/api/persons/${child}`)).status).toBe(204);
    });
  });
});
