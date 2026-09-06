import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createAuditEntry,
  createFamily,
  createOrganization,
  createUser,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("audit log", () => {
  const db = () => testDb();
  let orgId: string;
  let otherOrgId: string;
  let admin: CreatedUser;
  let member: CreatedUser;
  let reviewer: CreatedUser;
  let superAdmin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");

    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
      firstName: "Ada",
      lastName: "Admin",
    });
    member = await createUser(db(), {
      organizationId: orgId,
      role: "USER",
      email: "member@test.example",
    });
    reviewer = await createUser(db(), {
      organizationId: orgId,
      role: "PRAYER_REQUEST_ADMIN",
      email: "reviewer@test.example",
    });
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

  describe("who may read it", () => {
    it("lets an admin read their own parish", async () => {
      const { status } = await as(admin).call("GET", "/api/audit");
      expect(status).toBe(200);
    });

    it("refuses a member", async () => {
      expect((await as(member).call("GET", "/api/audit")).status).toBe(403);
      expect((await as(member).call("GET", "/api/audit/filters")).status).toBe(403);
      expect((await as(member).call("GET", "/api/audit/actors")).status).toBe(403);
    });

    /*
     * The line that matters. A prayer request admin is a member with one extra
     * privilege, and `requireRole` matches on a floor -- so the guard has to sit
     * at ADMIN and not at PRAYER_REQUEST_ADMIN.
     */
    it("refuses a prayer request admin", async () => {
      expect((await as(reviewer).call("GET", "/api/audit")).status).toBe(403);
      expect((await as(reviewer).call("GET", "/api/audit/filters")).status).toBe(403);
      expect((await as(reviewer).call("GET", "/api/audit/actors")).status).toBe(403);
    });

    it("refuses an unauthenticated caller", async () => {
      const { status } = await client(db(), null).call("GET", "/api/audit");
      expect(status).toBe(401);
    });

    /*
     * Both endpoints, because one `routes.use("/*")` is what guards them and
     * the bare mount path is the case where that could quietly not apply.
     */
    it("guards the bare path and the sub-paths alike", async () => {
      expect((await as(admin).call("GET", "/api/audit")).status).toBe(200);
      expect((await as(admin).call("GET", "/api/audit/filters")).status).toBe(200);
      expect((await as(admin).call("GET", "/api/audit/actors")).status).toBe(200);
    });

    it("asks a super admin with no parish selected to pick one", async () => {
      const { status } = await as(superAdmin).call("GET", "/api/audit");
      expect(status).toBe(400);
    });
  });

  describe("scope", () => {
    it("never shows an admin another parish's entries", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "person.update",
      });
      await createAuditEntry(db(), {
        organizationId: otherOrgId,
        actorAppUserId: superAdmin.appUserId,
        action: "family.delete",
      });

      const { body } = await as(admin).call("GET", "/api/audit");
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].action).toBe("person.update");
    });

    it("ignores an orgId from someone who is not a super admin", async () => {
      await createAuditEntry(db(), { organizationId: otherOrgId, action: "family.delete" });

      const { body } = await as(admin).call("GET", `/api/audit?orgId=${otherOrgId}`);
      expect(body.entries).toHaveLength(0);
    });

    it("follows a super admin between parishes", async () => {
      await createAuditEntry(db(), { organizationId: orgId, action: "person.update" });
      await createAuditEntry(db(), { organizationId: otherOrgId, action: "family.delete" });

      const here = await as(superAdmin).call("GET", `/api/audit?orgId=${orgId}`);
      expect(here.body.entries.map((e: { action: string }) => e.action)).toEqual(["person.update"]);

      const there = await as(superAdmin).call("GET", `/api/audit?orgId=${otherOrgId}`);
      expect(there.body.entries.map((e: { action: string }) => e.action)).toEqual([
        "family.delete",
      ]);
    });

    /*
     * Where `organization.create` lands: a super admin acting before there is a
     * parish to have selected. Hidden from an admin, because it is not their
     * parish's business; shown to a super admin, because otherwise it is
     * recorded and unreachable.
     */
    it("shows parish-less entries to a super admin only", async () => {
      await createAuditEntry(db(), {
        organizationId: null,
        actorAppUserId: superAdmin.appUserId,
        action: "organization.create",
        entityType: "organization",
      });

      const forAdmin = await as(admin).call("GET", "/api/audit");
      expect(forAdmin.body.entries).toHaveLength(0);

      const forSuper = await as(superAdmin).call("GET", `/api/audit?orgId=${orgId}`);
      expect(forSuper.body.entries).toHaveLength(1);
      expect(forSuper.body.entries[0].unassignedOrganization).toBe(true);
    });
  });

  describe("ordering and pagination", () => {
    it("returns the newest first", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        action: "person.create",
        createdAt: "2024-01-01T10:00:00Z",
      });
      await createAuditEntry(db(), {
        organizationId: orgId,
        action: "person.delete",
        createdAt: "2024-03-01T10:00:00Z",
      });
      await createAuditEntry(db(), {
        organizationId: orgId,
        action: "person.update",
        createdAt: "2024-02-01T10:00:00Z",
      });

      const { body } = await as(admin).call("GET", "/api/audit");
      expect(body.entries.map((e: { action: string }) => e.action)).toEqual([
        "person.delete",
        "person.update",
        "person.create",
      ]);
    });

    it("walks every page without skipping or repeating", async () => {
      for (let i = 0; i < 5; i += 1) {
        await createAuditEntry(db(), {
          organizationId: orgId,
          action: "person.update",
          createdAt: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
        });
      }

      const seen = await walk(as(admin), "/api/audit?limit=2");
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    /*
     * The reason the cursor carries `id` as well as `created_at`. Both merge
     * paths write two entries inside one transaction, so identical timestamps
     * are a real state -- and a cursor comparing only `created_at` either loses
     * the rest of the tied group or serves it again forever.
     */
    it("walks entries that share a timestamp exactly once each", async () => {
      const sameInstant = "2024-05-05T12:00:00.000Z";
      for (let i = 0; i < 4; i += 1) {
        await createAuditEntry(db(), {
          organizationId: orgId,
          action: "person.merge",
          createdAt: sameInstant,
        });
      }

      const seen = await walk(as(admin), "/api/audit?limit=1");
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });

    it("stops offering a cursor on the last page", async () => {
      await createAuditEntry(db(), { organizationId: orgId });
      const { body } = await as(admin).call("GET", "/api/audit?limit=50");
      expect(body.nextCursor).toBeNull();
    });
  });

  describe("filters", () => {
    beforeEach(async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "person.update",
        entityType: "person",
        createdAt: "2024-01-10T12:00:00Z",
      });
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: member.appUserId,
        action: "family.create",
        entityType: "family",
        createdAt: "2024-02-10T12:00:00Z",
      });
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "family.delete",
        entityType: "family",
        createdAt: "2024-03-10T12:00:00Z",
      });
    });

    const actionsOf = (body: { entries: { action: string }[] }) =>
      body.entries.map((entry) => entry.action);

    it("narrows to one action", async () => {
      const { body } = await as(admin).call("GET", "/api/audit?action=family.create");
      expect(actionsOf(body)).toEqual(["family.create"]);
    });

    it("takes several actions at once", async () => {
      const { body } = await as(admin).call(
        "GET",
        "/api/audit?action=family.create&action=family.delete"
      );
      expect(actionsOf(body)).toEqual(["family.delete", "family.create"]);
    });

    it("narrows by entity type", async () => {
      const { body } = await as(admin).call("GET", "/api/audit?entityType=family");
      expect(actionsOf(body)).toEqual(["family.delete", "family.create"]);
    });

    it("narrows by actor", async () => {
      const { body } = await as(admin).call("GET", `/api/audit?actorId=${member.appUserId}`);
      expect(actionsOf(body)).toEqual(["family.create"]);
    });

    it("includes a row exactly at `from` and excludes one exactly at `to`", async () => {
      const { body } = await as(admin).call(
        "GET",
        "/api/audit?from=2024-02-10T12:00:00Z&to=2024-03-10T12:00:00Z"
      );
      expect(actionsOf(body)).toEqual(["family.create"]);
    });

    it("ands the filters together", async () => {
      const { body } = await as(admin).call(
        "GET",
        `/api/audit?entityType=family&actorId=${admin.appUserId}`
      );
      expect(actionsOf(body)).toEqual(["family.delete"]);
    });

    it("keeps filtering across pages", async () => {
      const seen = await walk(as(admin), "/api/audit?entityType=family&limit=1");
      expect(seen).toHaveLength(2);
    });

    /*
     * An action that is not in `AUDIT_ACTIONS` is still an action. Validating
     * the filter against that constant would turn the first call site somebody
     * adds into a 400 on this page.
     */
    it("returns an empty page for an action nobody has recorded", async () => {
      const { status, body } = await as(admin).call("GET", "/api/audit?action=family.archive");
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(0);
    });

    /*
     * A filter must never fail open. Dropping an unparseable actor filter would
     * widen the page to everything instead of narrowing it to nothing.
     */
    it("matches nobody when every actor filter is nonsense", async () => {
      const { status, body } = await as(admin).call("GET", "/api/audit?actorId=not-a-uuid");
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(0);
    });

    it("ignores an unparseable date rather than failing", async () => {
      const { status, body } = await as(admin).call("GET", "/api/audit?from=yesterday");
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(3);
    });
  });

  describe("what each entry says", () => {
    it("names the actor and the target", async () => {
      const familyId = await createFamily(db(), orgId, "Popov");
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "family.update",
        entityType: "family",
        entityId: familyId,
        changes: { name: "Popov" },
      });

      const { body } = await as(admin).call("GET", "/api/audit");
      const entry = body.entries[0];
      expect(entry.actor.name).toBe("Ada Admin");
      expect(entry.actor.email).toBe("admin@test.example");
      expect(entry.target).toEqual({ label: "Popov", missing: false });
      expect(entry.changes).toEqual({ name: "Popov" });
    });

    /*
     * `actor_app_user_id` is `on delete set null` and no copy of the name is
     * kept on the row, so this is what the page has to render after an account
     * is deleted. The entry must survive it.
     */
    it("keeps an entry whose actor has been deleted", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: member.appUserId,
        action: "person.update",
      });
      await db().query("delete from app_users where id = $1", [member.appUserId]);

      const { body } = await as(admin).call("GET", "/api/audit");
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].actor).toEqual({ appUserId: null, email: null, name: null });
    });

    /*
     * `entity_id` is deliberately not a foreign key so the trail outlives what
     * it describes -- there is a test in api.admin.test.ts asserting that on the
     * write side. This is the read side of it.
     */
    it("marks a target that no longer exists", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "family.delete",
        entityType: "family",
        entityId: "00000000-0000-0000-0000-0000000000ff",
      });

      const { body } = await as(admin).call("GET", "/api/audit");
      expect(body.entries[0].target).toEqual({ label: null, missing: true });
    });

    it("labels a special date with whose it is", async () => {
      const { rows } = await db().query<{ id: string }>(
        `insert into special_dates (organization_id, person_id, type, month, day)
         values ($1, $2, 'FEAST_DAY', 7, 26) returning id`,
        [orgId, admin.personId]
      );
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "specialDate.update",
        entityType: "specialDate",
        entityId: rows[0]!.id,
      });

      const { body } = await as(admin).call("GET", "/api/audit");
      expect(body.entries[0].target).toEqual({ label: "Ada Admin", missing: false });
    });

    it("reports an id as a string, not a rounded number", async () => {
      await createAuditEntry(db(), { organizationId: orgId });
      const { body } = await as(admin).call("GET", "/api/audit");
      expect(typeof body.entries[0].id).toBe("string");
    });
  });

  describe("filter options", () => {
    it("offers only what this parish has actually recorded", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
        action: "person.update",
        entityType: "person",
      });
      await createAuditEntry(db(), {
        organizationId: otherOrgId,
        actorAppUserId: superAdmin.appUserId,
        action: "prayerRequest.delete",
        entityType: "prayerRequest",
      });

      const { body } = await as(admin).call("GET", "/api/audit/filters");
      expect(body.actions).toEqual(["person.update"]);
      expect(body.entityTypes).toEqual(["person"]);
    });

    /*
     * The no-hiding guarantee. An action written at a call site and not added to
     * `AUDIT_ACTIONS` has to be filterable, or the constant becomes a way to
     * lose rows silently.
     */
    it("offers an action the shared constant has never heard of", async () => {
      await createAuditEntry(db(), { organizationId: orgId, action: "family.archive" });

      const options = await as(admin).call("GET", "/api/audit/filters");
      expect(options.body.actions).toContain("family.archive");

      const filtered = await as(admin).call("GET", "/api/audit?action=family.archive");
      expect(filtered.body.entries).toHaveLength(1);
    });

    it("orders known actions by their grouping, not alphabetically", async () => {
      for (const action of ["person.delete", "family.create", "person.create"]) {
        await createAuditEntry(db(), { organizationId: orgId, action });
      }

      const { body } = await as(admin).call("GET", "/api/audit/filters");
      expect(body.actions).toEqual(["person.create", "person.delete", "family.create"]);
    });
  });

  describe("actor lookup", () => {
    beforeEach(async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: admin.appUserId,
      });
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: member.appUserId,
      });
    });

    const namesOf = (body: { actors: { name: string | null; email: string | null }[] }) =>
      body.actors.map((actor) => actor.name ?? actor.email);

    it("lists the people who have acted in this parish", async () => {
      const { body } = await as(admin).call("GET", "/api/audit/actors");
      expect(namesOf(body)).toEqual(["Ada Admin", "Test User"]);
    });

    /*
     * The whole reason this is not `GET /admin/users`: an account that has done
     * nothing here would be a filter guaranteed to come back empty.
     */
    it("leaves out an account that has never done anything", async () => {
      await createUser(db(), {
        organizationId: orgId,
        role: "USER",
        email: "bystander@test.example",
        firstName: "Never",
        lastName: "Acted",
      });

      const { body } = await as(admin).call("GET", "/api/audit/actors");
      expect(namesOf(body)).not.toContain("Never Acted");
    });

    it("matches on a name", async () => {
      const { body } = await as(admin).call("GET", "/api/audit/actors?q=ada");
      expect(namesOf(body)).toEqual(["Ada Admin"]);
    });

    it("matches on an email address", async () => {
      const { body } = await as(admin).call("GET", "/api/audit/actors?q=member@");
      expect(namesOf(body)).toEqual(["Test User"]);
    });

    it("narrows rather than widens as terms are added", async () => {
      const both = await as(admin).call("GET", "/api/audit/actors?q=a");
      expect(both.body.actors.length).toBeGreaterThan(1);

      const one = await as(admin).call("GET", "/api/audit/actors?q=ada%20admin");
      expect(namesOf(one.body)).toEqual(["Ada Admin"]);
    });

    it("treats a typed wildcard as a literal", async () => {
      const { body } = await as(admin).call("GET", "/api/audit/actors?q=%25");
      expect(body.actors).toHaveLength(0);
    });

    /*
     * A super admin acting in a parish is not in that parish's `/admin/users`
     * -- their home organization is null -- so this is the case that endpoint
     * could never have answered.
     */
    it("includes a super admin who acted here but belongs elsewhere", async () => {
      await createAuditEntry(db(), {
        organizationId: orgId,
        actorAppUserId: superAdmin.appUserId,
      });

      const { body } = await as(admin).call("GET", "/api/audit/actors");
      expect(namesOf(body)).toContain("super@test.example");
    });

    it("never offers an actor from another parish", async () => {
      const outsider = await createUser(db(), {
        organizationId: otherOrgId,
        role: "ADMIN",
        email: "outsider@test.example",
        firstName: "Other",
        lastName: "Parish",
      });
      await createAuditEntry(db(), {
        organizationId: otherOrgId,
        actorAppUserId: outsider.appUserId,
      });

      const { body } = await as(admin).call("GET", "/api/audit/actors");
      expect(namesOf(body)).not.toContain("Other Parish");
    });

    it("resolves the ids a saved filter names, for the chips", async () => {
      const { body } = await as(admin).call("GET", `/api/audit/actors?actorId=${member.appUserId}`);
      expect(body.actors).toEqual([
        { appUserId: member.appUserId, email: "member@test.example", name: "Test User" },
      ]);
    });

    it("resolves several ids at once", async () => {
      const { body } = await as(admin).call(
        "GET",
        `/api/audit/actors?actorId=${member.appUserId}&actorId=${admin.appUserId}`
      );
      expect(namesOf(body).sort()).toEqual(["Ada Admin", "Test User"]);
    });

    /*
     * Resolving takes precedence over `q`, so a stale term in the query string
     * cannot narrow away a chip the URL still says is selected.
     */
    it("ignores a search term while resolving ids", async () => {
      const { body } = await as(admin).call(
        "GET",
        `/api/audit/actors?actorId=${member.appUserId}&q=ada`
      );
      expect(namesOf(body)).toEqual(["Test User"]);
    });

    it("resolves nothing for an id from another parish", async () => {
      const outsider = await createUser(db(), {
        organizationId: otherOrgId,
        role: "ADMIN",
        email: "outsider2@test.example",
      });
      await createAuditEntry(db(), {
        organizationId: otherOrgId,
        actorAppUserId: outsider.appUserId,
      });

      const { body } = await as(admin).call(
        "GET",
        `/api/audit/actors?actorId=${outsider.appUserId}`
      );
      expect(body.actors).toHaveLength(0);
    });

    it("ignores an unparseable id rather than failing", async () => {
      const { status, body } = await as(admin).call("GET", "/api/audit/actors?actorId=nonsense");
      expect(status).toBe(200);
      // Falls through to the search, which with no term lists everybody.
      expect(body.actors.length).toBeGreaterThan(0);
    });

    it("caps how many it will return", async () => {
      const { body } = await as(admin).call("GET", "/api/audit/actors?limit=1");
      expect(body.actors).toHaveLength(1);
    });
  });
});

/**
 * Follows `nextCursor` to the end, collecting ids.
 *
 * The point is not the count but the set: a keyset that is wrong by one drops
 * rows or serves them twice, and only walking the whole thing shows it.
 */
async function walk(api: ReturnType<typeof client>, path: string, limit = 20): Promise<string[]> {
  const seen: string[] = [];
  let cursor: { createdAt: string; id: string } | null = null;

  for (let page = 0; page < limit; page += 1) {
    const query: string = cursor
      ? `${path}&cursorCreatedAt=${encodeURIComponent(cursor.createdAt)}&cursorId=${cursor.id}`
      : path;
    const { status, body } = await api.call("GET", query);
    expect(status).toBe(200);
    for (const entry of body.entries as { id: string }[]) seen.push(entry.id);
    cursor = body.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error("nextCursor never ran out");
}
