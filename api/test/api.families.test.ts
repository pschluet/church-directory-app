import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createNonUserPerson,
  createOrganization,
  createSpecialDate,
  createUser,
  setInheritance,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("families and the gated join flow", () => {
  const db = () => testDb();
  let orgId: string;
  let schlueters: string;
  let member: CreatedUser;
  let joiner: CreatedUser;
  let admin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    schlueters = await createFamily(db(), orgId, "Schlueter");
    member = await createUser(db(), {
      organizationId: orgId,
      familyId: schlueters,
      email: "member@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    joiner = await createUser(db(), {
      organizationId: orgId,
      familyId: null,
      email: "joiner@test.example",
      firstName: "Maria",
      lastName: "Ivanova",
    });
    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  it("puts the creator into the family they create", async () => {
    const created = await as(joiner).call("POST", "/api/families", { name: "Ivanov" });
    expect(created.status).toBe(201);

    const { body } = await as(joiner).call("GET", `/api/families/${created.body.id}`);
    expect(body.isMember).toBe(true);
    expect(body.canEdit).toBe(true);
    expect(body.members.map((m: any) => m.firstName)).toEqual(["Maria"]);
  });

  it("lists every family in the organization so someone can pick one", async () => {
    const { body } = await as(joiner).call("GET", "/api/families");
    expect(body.families.map((f: any) => f.name)).toContain("Schlueter");
    expect(body.families.find((f: any) => f.name === "Schlueter").memberCount).toBe(1);
  });

  describe("joining", () => {
    it("creates a pending request rather than joining outright", async () => {
      const { status, body } = await as(joiner).call(
        "POST",
        `/api/families/${schlueters}/join-requests`
      );
      expect(status).toBe(201);
      expect(body.status).toBe("PENDING");

      // Not in the family yet.
      const family = await as(member).call("GET", `/api/families/${schlueters}`);
      expect(family.body.members.map((m: any) => m.firstName)).toEqual(["Paul"]);
      expect(family.body.pendingJoinRequests).toHaveLength(1);
    });

    it("refuses a second request for the same family", async () => {
      await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const { status, body } = await as(joiner).call(
        "POST",
        `/api/families/${schlueters}/join-requests`
      );
      expect(status).toBe(409);
      expect(body.error).toMatch(/already asked/i);
    });

    it("refuses a request to join the family you are already in", async () => {
      const { status } = await as(member).call("POST", `/api/families/${schlueters}/join-requests`);
      expect(status).toBe(409);
    });

    it("hides pending requests from people who cannot act on them", async () => {
      await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const outsider = await createUser(db(), {
        organizationId: orgId,
        email: "outsider@test.example",
      });
      const { body } = await as(outsider).call("GET", `/api/families/${schlueters}`);
      expect(body.canEdit).toBe(false);
      expect(body.pendingJoinRequests).toEqual([]);
    });

    it("adds the person once a family member approves", async () => {
      const request = await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);

      const decision = await as(member).call(
        "POST",
        `/api/families/join-requests/${request.body.id}/approve`
      );
      expect(decision.status).toBe(200);
      expect(decision.body.status).toBe("APPROVED");

      const family = await as(member).call("GET", `/api/families/${schlueters}`);
      expect(family.body.members.map((m: any) => m.firstName).sort()).toEqual(["Maria", "Paul"]);
    });

    it("stops someone outside the family approving their own request", async () => {
      const request = await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const { status } = await as(joiner).call(
        "POST",
        `/api/families/join-requests/${request.body.id}/approve`
      );
      expect(status).toBe(403);
    });

    it("lets an admin approve too", async () => {
      const request = await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const { status } = await as(admin).call(
        "POST",
        `/api/families/join-requests/${request.body.id}/approve`
      );
      expect(status).toBe(200);
    });

    it("records a denial without adding the person", async () => {
      const request = await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const { body } = await as(member).call(
        "POST",
        `/api/families/join-requests/${request.body.id}/deny`
      );
      expect(body.status).toBe("DENIED");

      const family = await as(member).call("GET", `/api/families/${schlueters}`);
      expect(family.body.members).toHaveLength(1);
    });

    it("refuses to decide the same request twice", async () => {
      const request = await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      await as(member).call("POST", `/api/families/join-requests/${request.body.id}/deny`);
      const { status } = await as(member).call(
        "POST",
        `/api/families/join-requests/${request.body.id}/approve`
      );
      expect(status).toBe(409);
    });

    it("lets an admin add themselves without asking", async () => {
      const { status, body } = await as(admin).call(
        "POST",
        `/api/families/${schlueters}/join-requests`
      );
      expect(status).toBe(201);
      expect(body.status).toBe("APPROVED");
    });

    it("shows a member the requests waiting on them", async () => {
      await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const { body } = await as(member).call("GET", "/api/families/join-requests/pending");
      expect(body.joinRequests.map((r: any) => r.personName)).toEqual(["Maria Ivanova"]);
    });
  });

  describe("membership changes", () => {
    it("drops inheritance when someone is removed from a family", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      await setInheritance(db(), child, { lastName: member.personId! });

      const { status } = await as(member).call(
        "DELETE",
        `/api/families/${schlueters}/members/${child}`
      );
      expect(status).toBe(204);

      const { rows } = await db().query<{
        family_id: string | null;
        inherit_last_name_from_person_id: string | null;
      }>("select family_id, inherit_last_name_from_person_id from persons where id = $1", [child]);
      expect(rows[0]!.family_id).toBeNull();
      expect(rows[0]!.inherit_last_name_from_person_id).toBeNull();
    });

    it("drops inheritance when someone moves to a new family they create", async () => {
      const otherMember = await createUser(db(), {
        organizationId: orgId,
        familyId: schlueters,
        email: "other@test.example",
        firstName: "Nikolai",
      });
      await setInheritance(db(), otherMember.personId!, { address: member.personId! });

      await as(otherMember).call("POST", "/api/families", { name: "Petrov" });

      const { rows } = await db().query<{ inherit_address_from_person_id: string | null }>(
        "select inherit_address_from_person_id from persons where id = $1",
        [otherMember.personId]
      );
      expect(rows[0]!.inherit_address_from_person_id).toBeNull();
    });

    it("cancels other pending requests once someone joins a family", async () => {
      const popovs = await createFamily(db(), orgId, "Popov");
      const toSchlueter = await as(joiner).call(
        "POST",
        `/api/families/${schlueters}/join-requests`
      );
      await as(joiner).call("POST", `/api/families/${popovs}/join-requests`);

      await as(member).call("POST", `/api/families/join-requests/${toSchlueter.body.id}/approve`);

      const { rows } = await db().query<{ status: string; family_id: string }>(
        "select status, family_id from family_join_requests where person_id = $1",
        [joiner.personId]
      );
      const popovRequest = rows.find((r) => r.family_id === popovs);
      expect(popovRequest?.status).toBe("CANCELLED");
    });
  });

  it("renames a family only for its members", async () => {
    expect(
      (await as(member).call("PATCH", `/api/families/${schlueters}`, { name: "Schlueter Family" }))
        .status
    ).toBe(200);
    expect(
      (await as(joiner).call("PATCH", `/api/families/${schlueters}`, { name: "Hijacked" })).status
    ).toBe(403);
  });

  describe("creating a family for someone else", () => {
    it("lets an admin create one without joining it", async () => {
      const created = await as(admin).call("POST", "/api/families", {
        name: "Popov",
        join: false,
      });
      expect(created.status).toBe(201);

      const { body } = await as(admin).call("GET", `/api/families/${created.body.id}`);
      expect(body.members).toEqual([]);

      const { rows } = await db().query("select family_id from persons where id = $1", [
        admin.personId,
      ]);
      expect(rows[0]!.family_id).toBeNull();
    });

    it("refuses join:false from an ordinary member, before inserting anything", async () => {
      const { status } = await as(member).call("POST", "/api/families", {
        name: "Sneaky",
        join: false,
      });
      expect(status).toBe(403);

      const { rows } = await db().query("select count(*) as count from families where name = $1", [
        "Sneaky",
      ]);
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("still joins by default", async () => {
      const created = await as(joiner).call("POST", "/api/families", { name: "Ivanov" });
      expect(created.status).toBe(201);
      const { rows } = await db().query("select family_id from persons where id = $1", [
        joiner.personId,
      ]);
      expect(rows[0]!.family_id).toBe(created.body.id);
    });

    it("cancels the creator's outstanding requests when they join", async () => {
      await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
      const created = await as(joiner).call("POST", "/api/families", { name: "Ivanov" });
      expect(created.status).toBe(201);

      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [joiner.personId]
      );
      expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);
    });
  });

  describe("the families list", () => {
    it("shows the caller their own pending request, and nobody else's", async () => {
      await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);

      const mine = await as(joiner).call("GET", "/api/families");
      const row = mine.body.families.find((f: any) => f.id === schlueters);
      expect(row.pendingJoinRequestId).toEqual(expect.any(String));

      const theirs = await as(member).call("GET", "/api/families");
      expect(theirs.body.families.find((f: any) => f.id === schlueters).pendingJoinRequestId).toBe(
        null
      );
    });

    it("carries a few member names so same-named families can be told apart", async () => {
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      const { body } = await as(joiner).call("GET", "/api/families");
      const row = body.families.find((f: any) => f.id === schlueters);
      expect(row.memberCount).toBe(2);
      expect(row.memberNames).toEqual(expect.arrayContaining(["Paul", "Anna"]));
    });
  });

  describe("adding someone already in the directory", () => {
    it("pulls an accountless person with no family into the family", async () => {
      const orphan = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName: "Anna",
      });

      const { status } = await as(member).call("POST", `/api/families/${schlueters}/members`, {
        personId: orphan,
      });
      expect(status).toBe(204);

      const { rows } = await db().query("select family_id from persons where id = $1", [orphan]);
      expect(rows[0]!.family_id).toBe(schlueters);
    });

    it("refuses someone who has an account", async () => {
      const { status, body } = await as(member).call(
        "POST",
        `/api/families/${schlueters}/members`,
        { personId: joiner.personId }
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/account/i);
    });

    it("refuses someone already in a family", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      const popovs = await createFamily(db(), orgId, "Popov");
      await as(admin).call("POST", `/api/families/${popovs}/members`, { personId: child });

      const { status } = await as(admin).call("POST", `/api/families/${popovs}/members`, {
        personId: child,
      });
      expect(status).toBe(409);
    });

    it("is closed to non-members", async () => {
      const orphan = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName: "Anna",
      });
      const { status } = await as(joiner).call("POST", `/api/families/${schlueters}/members`, {
        personId: orphan,
      });
      expect(status).toBe(403);
    });

    it("offers only accountless, family-less people as candidates", async () => {
      const orphan = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName: "Anna",
      });
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Taken",
      });

      const { body } = await as(member).call("GET", `/api/families/${schlueters}/candidates`);
      expect(body.candidates.map((p: any) => p.id)).toEqual([orphan]);
    });
  });

  describe("emptying and deleting a family", () => {
    it("stops a member removing the last person", async () => {
      const { status, body } = await as(member).call(
        "DELETE",
        `/api/families/${schlueters}/members/${member.personId}`
      );
      expect(status).toBe(409);
      expect(body.error).toMatch(/at least one member/i);

      const { rows } = await db().query("select family_id from persons where id = $1", [
        member.personId,
      ]);
      expect(rows[0]!.family_id).toBe(schlueters);
    });

    it("lets an admin empty a family so it can be deleted", async () => {
      expect(
        (await as(admin).call("DELETE", `/api/families/${schlueters}/members/${member.personId}`))
          .status
      ).toBe(204);
      expect((await as(admin).call("DELETE", `/api/families/${schlueters}`)).status).toBe(204);

      const { rows } = await db().query("select count(*) as count from families where id = $1", [
        schlueters,
      ]);
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("refuses to delete a family that still has members", async () => {
      const { status, body } = await as(admin).call("DELETE", `/api/families/${schlueters}`);
      expect(status).toBe(409);
      expect(body.error).toMatch(/members first/i);
    });

    it("is not something an ordinary member can do", async () => {
      const { status } = await as(member).call("DELETE", `/api/families/${schlueters}`);
      expect(status).toBe(403);
    });

    it("cancels the removed person's outstanding requests", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      const popovs = await createFamily(db(), orgId, "Popov");
      await db().query(
        `insert into family_join_requests (organization_id, family_id, person_id)
         values ($1, $2, $3)`,
        [orgId, popovs, child]
      );

      expect(
        (await as(member).call("DELETE", `/api/families/${schlueters}/members/${child}`)).status
      ).toBe(204);

      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [child]
      );
      expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);
    });
  });

  // -------------------------------------------------------------------------
  // What the family page shows: ages, couples, and the order members sit in.
  // -------------------------------------------------------------------------
  describe("the family page payload", () => {
    /** `today` is always passed explicitly so these never drift with the clock. */
    const detail = (u: CreatedUser, today = "2026-09-01") =>
      as(u).call("GET", `/api/families/${schlueters}?today=${today}`);

    const memberNamed = (body: any, firstName: string) =>
      body.members.find((m: any) => m.firstName === firstName);

    it("shows an age when the person opted in to showing it", async () => {
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
        showYearCount: true,
      });

      const { body } = await detail(member);
      expect(memberNamed(body, "Paul").age).toBe(41);
    });

    it("withholds the age when they did not opt in, even from someone who may edit them", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
      });
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: child,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 2014,
        showYearCount: false,
      });

      // `member` can edit an accountless family member, and still gets nothing:
      // the requirement is "if they have opted in to show age".
      const { body } = await detail(member);
      expect(memberNamed(body, "Anna").canEdit).toBe(true);
      expect(memberNamed(body, "Anna").age).toBeNull();
    });

    it("withholds the age when the birthday carries no year", async () => {
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: null,
      });

      const { body } = await detail(member);
      expect(memberNamed(body, "Paul").age).toBeNull();
    });

    it("has no age for someone with no birthday at all", async () => {
      const { body } = await detail(member);
      expect(memberNamed(body, "Paul").age).toBeNull();
    });

    it("counts the age against the caller's today, not the server's", async () => {
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
        showYearCount: true,
      });

      expect(memberNamed((await detail(member, "2026-05-03")).body, "Paul").age).toBe(40);
      expect(memberNamed((await detail(member, "2026-05-04")).body, "Paul").age).toBe(41);
    });

    it("rejects a today that is not a date", async () => {
      const { status } = await as(member).call(
        "GET",
        `/api/families/${schlueters}?today=not-a-date`
      );
      expect(status).toBe(400);
    });

    it("pairs a couple who are both in the family", async () => {
      const spouse = await createUser(db(), {
        organizationId: orgId,
        familyId: schlueters,
        email: "spouse@test.example",
        firstName: "Sarah",
      });
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        relatedPersonId: spouse.personId!,
        type: "ANNIVERSARY",
        month: 6,
        day: 14,
        year: 2010,
        showYearCount: true,
      });

      const { body } = await detail(member);
      expect(body.anniversaries).toHaveLength(1);
      expect(body.anniversaries[0].personIds.sort()).toEqual(
        [member.personId, spouse.personId].sort()
      );
      expect(body.anniversaries[0].month).toBe(6);
      expect(body.anniversaries[0].day).toBe(14);
      expect(body.anniversaries[0].yearCount).toBe(16);
    });

    it("withholds the years married when the couple did not opt in", async () => {
      const spouse = await createUser(db(), {
        organizationId: orgId,
        familyId: schlueters,
        email: "spouse2@test.example",
        firstName: "Sarah",
      });
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        relatedPersonId: spouse.personId!,
        type: "ANNIVERSARY",
        month: 6,
        day: 14,
        year: 2010,
        showYearCount: false,
      });

      const { body } = await detail(member);
      // Still paired -- who is married to whom is not the private part.
      expect(body.anniversaries).toHaveLength(1);
      expect(body.anniversaries[0].yearCount).toBeNull();
    });

    it("does not pair a couple whose other half is outside the family", async () => {
      const outsider = await createUser(db(), {
        organizationId: orgId,
        familyId: null,
        email: "outsider@test.example",
        firstName: "Elena",
      });
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: member.personId!,
        relatedPersonId: outsider.personId!,
        type: "ANNIVERSARY",
        month: 6,
        day: 14,
        year: 2010,
        showYearCount: true,
      });

      const { body } = await detail(member);
      expect(body.anniversaries).toEqual([]);
    });

    it("orders members by name until someone arranges them", async () => {
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
        lastName: "Schlueter",
      });
      await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Zoe",
        lastName: "Schlueter",
      });

      const { body } = await detail(member);
      expect(body.members.map((m: any) => m.firstName)).toEqual(["Anna", "Paul", "Zoe"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("custom member order", () => {
    let anna: string;
    let zoe: string;

    beforeEach(async () => {
      anna = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Anna",
        lastName: "Schlueter",
      });
      zoe = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: schlueters,
        firstName: "Zoe",
        lastName: "Schlueter",
      });
    });

    const order = (u: CreatedUser, personIds: string[]) =>
      as(u).call("PUT", `/api/families/${schlueters}/member-order`, { personIds });

    const names = async (u: CreatedUser) =>
      (await as(u).call("GET", `/api/families/${schlueters}`)).body.members.map(
        (m: any) => m.firstName
      );

    it("lets a member arrange the family, and the order sticks", async () => {
      const { status } = await order(member, [zoe, member.personId!, anna]);
      expect(status).toBe(204);
      expect(await names(member)).toEqual(["Zoe", "Paul", "Anna"]);
    });

    it("lets an admin arrange a family they do not belong to", async () => {
      expect((await order(admin, [zoe, anna, member.personId!])).status).toBe(204);
      expect(await names(admin)).toEqual(["Zoe", "Anna", "Paul"]);
    });

    it("refuses someone who is neither a member nor an admin", async () => {
      const { status } = await order(joiner, [zoe, anna, member.personId!]);
      expect(status).toBe(403);
      // And nothing moved.
      expect(await names(member)).toEqual(["Anna", "Paul", "Zoe"]);
    });

    it("rejects a list that leaves a member out", async () => {
      const { status } = await order(member, [zoe, anna]);
      expect(status).toBe(400);
      expect(await names(member)).toEqual(["Anna", "Paul", "Zoe"]);
    });

    it("rejects a list that names someone twice", async () => {
      const { status } = await order(member, [zoe, zoe, anna, member.personId!]);
      expect(status).toBe(400);
    });

    it("rejects a list carrying someone outside the family", async () => {
      const { status } = await order(member, [zoe, anna, member.personId!, joiner.personId!]);
      expect(status).toBe(400);
    });

    it("is idempotent, so a repeated write is harmless", async () => {
      await order(member, [zoe, member.personId!, anna]);
      await order(member, [zoe, member.personId!, anna]);
      expect(await names(member)).toEqual(["Zoe", "Paul", "Anna"]);
    });

    it("gives up a position when the member leaves the family", async () => {
      await order(member, [zoe, anna, member.personId!]);
      await as(member).call("DELETE", `/api/families/${schlueters}/members/${zoe}`);

      const { rows } = await db().query<{ family_order: number | null }>(
        "select family_order from persons where id = $1",
        [zoe]
      );
      expect(rows[0]!.family_order).toBeNull();
    });

    it("puts a newly added member at the end of an arranged family", async () => {
      await order(member, [zoe, anna, member.personId!]);
      const newcomer = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName: "Boris",
      });
      await as(member).call("POST", `/api/families/${schlueters}/members`, {
        personId: newcomer,
      });

      expect(await names(member)).toEqual(["Zoe", "Anna", "Paul", "Boris"]);
    });
  });

  it("shows an admin every pending request in the parish", async () => {
    const popovs = await createFamily(db(), orgId, "Popov");
    await as(joiner).call("POST", `/api/families/${schlueters}/join-requests`);
    const other = await createUser(db(), {
      organizationId: orgId,
      familyId: null,
      email: "other@test.example",
      firstName: "Sofia",
    });
    await as(other).call("POST", `/api/families/${popovs}/join-requests`);

    const { body } = await as(admin).call("GET", "/api/families/join-requests/pending");
    expect(body.joinRequests.map((r: any) => r.personName).sort()).toEqual([
      "Maria Ivanova",
      "Sofia User",
    ]);
  });
});
