import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
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

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("directory browse and search", () => {
  const db = () => testDb();
  let orgId: string;
  let familyId: string;
  let me: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    familyId = await createFamily(db(), orgId);
    me = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "me@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  describe("browse", () => {
    it("sorts by last name, then first name", async () => {
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Zoe",
        lastName: "Antonov",
      });
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
        lastName: "Antonov",
      });
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Boris",
        lastName: "Popov",
      });

      const { body } = await as(me).call("GET", "/api/directory");
      expect(body.people.map((p: any) => `${p.lastName} ${p.firstName}`)).toEqual([
        "Antonov Anna",
        "Antonov Zoe",
        "Popov Boris",
        "Schlueter Paul",
      ]);
    });

    it("puts people with no last name at the end rather than the start", async () => {
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Nameless",
        lastName: null,
      });
      const { body } = await as(me).call("GET", "/api/directory");
      expect(body.people[body.people.length - 1].firstName).toBe("Nameless");
    });

    it("pages without skipping or repeating anyone", async () => {
      for (const [first, last] of [
        ["Aaron", "Adams"],
        ["Bella", "Baker"],
        ["Cyril", "Carter"],
        ["Dora", "Davis"],
      ]) {
        await createNonUserPerson(db(), {
          organizationId: orgId,
          familyId,
          firstName: first,
          lastName: last,
        });
      }

      const seen: string[] = [];
      let query = "/api/directory?limit=2";
      for (let page = 0; page < 5; page += 1) {
        const { body } = await as(me).call("GET", query);
        seen.push(...body.people.map((p: any) => p.id));
        if (!body.nextCursor) break;
        const { lastName, firstName, id } = body.nextCursor;
        query = `/api/directory?limit=2&cursorLastName=${encodeURIComponent(
          lastName ?? ""
        )}&cursorFirstName=${encodeURIComponent(firstName)}&cursorId=${id}`;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("leaves out soft-deleted people", async () => {
      const gone = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Gone",
      });
      await db().query("update persons set deleted_at = now() where id = $1", [gone]);
      const { body } = await as(me).call("GET", "/api/directory");
      expect(body.people.map((p: any) => p.firstName)).not.toContain("Gone");
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await db().query(
        `update persons
            set phone = '+13125551234', city = 'Chicago', state = 'IL',
                address_line1 = '4129 W Newport Ave', postal_code = '60641',
                patron_saint = 'St. Paul the Apostle'
          where id = $1`,
        [me.personId]
      );
    });

    it("matches a name fragment", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=chlue");
      expect(body.people.map((p: any) => p.firstName)).toEqual(["Paul"]);
    });

    it("matches a phone fragment", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=5551234");
      expect(body.people).toHaveLength(1);
    });

    it("matches an address fragment", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=Newport");
      expect(body.people).toHaveLength(1);
    });

    it("matches a patron saint", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=Apostle");
      expect(body.people).toHaveLength(1);
    });

    it("matches a family name", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=Schlueter");
      expect(body.people).toHaveLength(1);
    });

    it("finds inherited values, not just a person's own", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
        lastName: null,
      });
      await setInheritance(db(), child, { lastName: me.personId!, address: me.personId! });

      const byName = await as(me).call("GET", "/api/directory/search?q=Schlueter");
      expect(byName.body.people.map((p: any) => p.firstName).sort()).toEqual(["Anna", "Paul"]);

      const byAddress = await as(me).call("GET", "/api/directory/search?q=60641");
      expect(byAddress.body.people).toHaveLength(2);
    });

    it("narrows with every term rather than widening", async () => {
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Boris",
        lastName: "Popov",
        city: "Chicago",
      });
      const both = await as(me).call("GET", "/api/directory/search?q=Chicago%20Popov");
      expect(both.body.people.map((p: any) => p.firstName)).toEqual(["Boris"]);
    });

    it("treats a typed wildcard as a literal", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=%25");
      expect(body.people).toHaveLength(0);
    });

    it("returns nothing for an empty query rather than everyone", async () => {
      const { body } = await as(me).call("GET", "/api/directory/search?q=%20%20");
      expect(body.people).toEqual([]);
    });
  });
});
