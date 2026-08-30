import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
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
 * The role x route x organization matrix. This is the file to look at first
 * when changing anything about permissions: it asserts not just that the right
 * people can act, but that the wrong people get 403/404 -- including across
 * organizations, which is the whole point of the multi-tenant design.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("authorization", () => {
  const db = () => testDb();

  let orgA: string;
  let orgB: string;
  let familyA: string;
  let otherFamilyA: string;
  let user: CreatedUser;
  let familyMate: CreatedUser;
  let admin: CreatedUser;
  let superAdmin: CreatedUser;
  let outsider: CreatedUser;
  let childA: string;
  let personInB: string;

  beforeAll(async () => {
    await resetTables();
    orgA = await createOrganization(db(), "All Saints", "all-saints");
    orgB = await createOrganization(db(), "St. George", "st-george");
    familyA = await createFamily(db(), orgA, "Schlueter");
    otherFamilyA = await createFamily(db(), orgA, "Popov");

    user = await createUser(db(), {
      organizationId: orgA,
      familyId: familyA,
      email: "user@a.test",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    familyMate = await createUser(db(), {
      organizationId: orgA,
      familyId: familyA,
      email: "spouse@a.test",
      firstName: "Maria",
      lastName: "Schlueter",
    });
    admin = await createUser(db(), {
      organizationId: orgA,
      role: "ADMIN",
      email: "admin@a.test",
    });
    superAdmin = await createUser(db(), {
      organizationId: null,
      role: "SUPER_ADMIN",
      email: "super@a.test",
    });
    outsider = await createUser(db(), {
      organizationId: orgB,
      familyId: null,
      email: "user@b.test",
    });

    childA = await createNonUserPerson(db(), {
      organizationId: orgA,
      familyId: familyA,
      firstName: "Anna",
    });
    personInB = await createNonUserPerson(db(), {
      organizationId: orgB,
      familyId: null,
      firstName: "Georgi",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  describe("authentication", () => {
    it("rejects a request with no token", async () => {
      const { status } = await client(db(), null).call("GET", "/api/me");
      expect(status).toBe(401);
    });

    it("rejects a valid token with no directory account", async () => {
      const { status, body } = await client(db(), {
        sub: "sub-nobody",
        email: "nobody@a.test",
      }).call("GET", "/api/me");
      expect(status).toBe(403);
      expect(body.error).toMatch(/no directory account/i);
    });

    it("leaves the health check open", async () => {
      const { status, body } = await client(db(), null).call("GET", "/api/health");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("rejects a disabled account", async () => {
      const disabled = await createUser(db(), {
        organizationId: orgA,
        email: "disabled@a.test",
      });
      await db().query("update app_users set status = 'DISABLED' where id = $1", [
        disabled.appUserId,
      ]);
      const { status } = await as(disabled).call("GET", "/api/me");
      expect(status).toBe(403);
    });
  });

  describe("reading the directory", () => {
    it("shows a user everyone in their own organization", async () => {
      const { status, body } = await as(user).call("GET", "/api/directory");
      expect(status).toBe(200);
      const names = body.people.map((p: { firstName: string }) => p.firstName);
      expect(names).toContain("Anna");
      // ...and nobody from the other parish.
      expect(names).not.toContain("Georgi");
    });

    it("hides a person in another organization behind a 404", async () => {
      const { status } = await as(user).call("GET", `/api/persons/${personInB}`);
      expect(status).toBe(404);
    });

    it("lets a super admin switch organizations", async () => {
      const inB = await as(superAdmin).call("GET", `/api/directory?orgId=${orgB}`);
      expect(inB.status).toBe(200);
      expect(inB.body.people.map((p: { firstName: string }) => p.firstName)).toContain("Georgi");
    });

    it("asks a super admin to pick an organization first", async () => {
      const { status, body } = await as(superAdmin).call("GET", "/api/directory");
      expect(status).toBe(400);
      expect(body.error).toMatch(/select an organization/i);
    });

    it("refuses a super admin an organization that does not exist", async () => {
      const { status } = await as(superAdmin).call(
        "GET",
        "/api/directory?orgId=6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e"
      );
      expect(status).toBe(404);
    });

    it("ignores orgId from someone who is not a super admin", async () => {
      const { status, body } = await as(user).call("GET", `/api/directory?orgId=${orgB}`);
      expect(status).toBe(200);
      expect(body.people.map((p: { firstName: string }) => p.firstName)).not.toContain("Georgi");
    });
  });

  describe("editing people", () => {
    it("lets a user edit their own record", async () => {
      const { status } = await as(user).call("PATCH", `/api/persons/${user.personId}`, {
        city: "Chicago",
      });
      expect(status).toBe(200);
    });

    it("lets a user edit a family member who has no account", async () => {
      const { status } = await as(user).call("PATCH", `/api/persons/${childA}`, {
        city: "Chicago",
      });
      expect(status).toBe(200);
    });

    it("stops a user editing another adult in their own family", async () => {
      const { status, body } = await as(user).call("PATCH", `/api/persons/${familyMate.personId}`, {
        city: "Evanston",
      });
      expect(status).toBe(403);
      expect(body.error).toMatch(/your own details/i);
    });

    it("stops a user editing someone in another family", async () => {
      const stranger = await createNonUserPerson(db(), {
        organizationId: orgA,
        familyId: otherFamilyA,
        firstName: "Ivan",
      });
      const { status } = await as(user).call("PATCH", `/api/persons/${stranger}`, {
        city: "Evanston",
      });
      expect(status).toBe(403);
    });

    it("lets an admin edit anyone in their organization", async () => {
      const { status } = await as(admin).call("PATCH", `/api/persons/${familyMate.personId}`, {
        city: "Evanston",
      });
      expect(status).toBe(200);
    });

    it("stops an admin reaching into another organization", async () => {
      const { status } = await as(admin).call("PATCH", `/api/persons/${personInB}`, {
        city: "Sofia",
      });
      expect(status).toBe(404);
    });

    it("stops an outsider editing anyone here", async () => {
      const { status } = await as(outsider).call("PATCH", `/api/persons/${childA}`, {
        city: "Sofia",
      });
      expect(status).toBe(404);
    });
  });

  describe("inviting accounts", () => {
    it("refuses a plain user", async () => {
      const { status } = await as(user).call("POST", "/api/admin/users", {
        email: "new1@a.test",
        firstName: "New",
        role: "USER",
      });
      expect(status).toBe(403);
    });

    it("lets an admin invite into their own organization", async () => {
      const { status, body } = await as(admin).call("POST", "/api/admin/users", {
        email: "new2@a.test",
        firstName: "New",
        role: "USER",
      });
      expect(status).toBe(201);
      expect(body.organizationId).toBe(orgA);
    });

    it("pins an admin's invite to their own organization even if they ask otherwise", async () => {
      const { status } = await as(admin).call("POST", "/api/admin/users", {
        email: "new3@a.test",
        firstName: "New",
        role: "USER",
        organizationId: orgB,
      });
      expect(status).toBe(403);
    });

    it("stops an admin minting a super admin", async () => {
      const { status, body } = await as(admin).call("POST", "/api/admin/users", {
        email: "new4@a.test",
        firstName: "New",
        role: "SUPER_ADMIN",
      });
      expect(status).toBe(403);
      expect(body.error).toMatch(/super admin/i);
    });

    it("lets a super admin invite anywhere, in any role", async () => {
      const { status, body } = await as(superAdmin).call("POST", "/api/admin/users", {
        email: "new5@b.test",
        firstName: "New",
        role: "ADMIN",
        organizationId: orgB,
      });
      expect(status).toBe(201);
      expect(body.organizationId).toBe(orgB);
    });

    it("only shows an admin the accounts in their own organization", async () => {
      const { body } = await as(admin).call("GET", "/api/admin/users");
      const emails = body.users.map((u: { email: string }) => u.email);
      expect(emails).toContain("admin@a.test");
      expect(emails).not.toContain("user@b.test");
    });

    it("stops anyone disabling their own account", async () => {
      const { status } = await as(admin).call("PATCH", `/api/admin/users/${admin.appUserId}`, {
        status: "DISABLED",
      });
      expect(status).toBe(400);
    });
  });

  describe("organizations", () => {
    it("are invisible to an admin", async () => {
      expect((await as(admin).call("GET", "/api/organizations")).status).toBe(403);
      expect(
        (await as(admin).call("POST", "/api/organizations", { name: "New", slug: "new" })).status
      ).toBe(403);
    });

    it("are managed by a super admin", async () => {
      const { status, body } = await as(superAdmin).call("POST", "/api/organizations", {
        name: "Holy Trinity",
        slug: "holy-trinity",
      });
      expect(status).toBe(201);
      expect(body.slug).toBe("holy-trinity");
    });

    it("reject a duplicate slug", async () => {
      const { status } = await as(superAdmin).call("POST", "/api/organizations", {
        name: "Another",
        slug: "holy-trinity",
      });
      expect(status).toBe(409);
    });
  });

  /**
   * Removing a member authorises the family, so the person id has to be checked
   * separately -- clearInheritanceFor runs before the family-scoped update and
   * is keyed on the person alone. Without the membership check, a member of any
   * family could name a stranger and wipe their inheritance.
   */
  describe("removing a family member", () => {
    const INHERIT_COLUMNS = [
      "inherit_email_from_person_id",
      "inherit_phone_from_person_id",
      "inherit_alt_phone_from_person_id",
      "inherit_last_name_from_person_id",
      "inherit_address_from_person_id",
    ].join(", ");

    async function pointers(personId: string): Promise<Record<string, string | null>> {
      const { rows } = await db().query(`select ${INHERIT_COLUMNS} from persons where id = $1`, [
        personId,
      ]);
      return rows[0] as Record<string, string | null>;
    }

    it("will not let a member wipe the inheritance of someone in another parish", async () => {
      const familyB = await createFamily(db(), orgB, "Georgiev");
      const parent = await createNonUserPerson(db(), {
        organizationId: orgB,
        familyId: familyB,
        firstName: "Boris",
      });
      const victim = await createNonUserPerson(db(), {
        organizationId: orgB,
        familyId: familyB,
        firstName: "Elena",
      });
      const dependant = await createNonUserPerson(db(), {
        organizationId: orgB,
        familyId: familyB,
        firstName: "Ivan",
      });
      await setInheritance(db(), victim, { lastName: parent, address: parent });
      await setInheritance(db(), dependant, { lastName: victim });

      const { status } = await as(user).call(
        "DELETE",
        `/api/families/${familyA}/members/${victim}`
      );
      expect(status).toBe(404);

      // Both directions must survive: the victim's own pointers, and the
      // pointer aimed at them from someone else in their family.
      expect(await pointers(victim)).toMatchObject({
        inherit_last_name_from_person_id: parent,
        inherit_address_from_person_id: parent,
      });
      expect(await pointers(dependant)).toMatchObject({
        inherit_last_name_from_person_id: victim,
      });
    });

    it("will not let a member wipe the inheritance of another family in their own parish", async () => {
      const head = await createNonUserPerson(db(), {
        organizationId: orgA,
        familyId: otherFamilyA,
        firstName: "Dimitri",
      });
      const victim = await createNonUserPerson(db(), {
        organizationId: orgA,
        familyId: otherFamilyA,
        firstName: "Sofia",
      });
      await setInheritance(db(), victim, { lastName: head });

      const { status } = await as(user).call(
        "DELETE",
        `/api/families/${familyA}/members/${victim}`
      );
      expect(status).toBe(404);
      expect(await pointers(victim)).toMatchObject({
        inherit_last_name_from_person_id: head,
      });
    });

    it("404s on a person who does not exist rather than reporting success", async () => {
      const { status } = await as(user).call(
        "DELETE",
        `/api/families/${familyA}/members/00000000-0000-0000-0000-000000000000`
      );
      expect(status).toBe(404);
    });
  });
});
