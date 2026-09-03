import { afterAll, beforeEach, describe, expect, it, inject, vi } from "vitest";
import * as email from "../src/email";
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

describe.skipIf(!hasDb)("account management", () => {
  const db = () => testDb();
  let orgId: string;
  let otherOrgId: string;
  let admin: CreatedUser;
  let superAdmin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");
    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
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

  describe("inviting", () => {
    it("emails the invitation, naming the parish and the inviter", async () => {
      const send = vi.spyOn(email, "sendInvitationEmail").mockResolvedValue();

      const { status } = await as(admin).call("POST", "/api/admin/users", {
        email: "invited@test.example",
        firstName: "Invited",
        role: "USER",
      });

      expect(status).toBe(201);
      expect(send).toHaveBeenCalledWith({
        to: "invited@test.example",
        firstName: "Invited",
        organizationName: "All Saints",
        invitedBy: admin.email,
      });
    });

    it("keeps the account when the invitation email fails", async () => {
      // A bounced invitation is recoverable -- the person can be told to sign
      // in another way. Losing the account would not be.
      vi.spyOn(email, "sendInvitationEmail").mockRejectedValue(new Error("SES is down"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const { status, body } = await as(admin).call("POST", "/api/admin/users", {
        email: "bounced@test.example",
        firstName: "Bounced",
        role: "USER",
      });

      expect(status).toBe(201);
      expect(body.email).toBe("bounced@test.example");
    });

    it("creates the account and its directory record together", async () => {
      const { status, body } = await as(admin).call("POST", "/api/admin/users", {
        email: "New.Person@Test.Example",
        firstName: "New",
        lastName: "Person",
        role: "USER",
      });

      expect(status).toBe(201);
      expect(body.email).toBe("new.person@test.example");
      expect(body.status).toBe("INVITED");
      expect(body.personName).toBe("New Person");
      expect(body.organizationName).toBe("All Saints");
    });

    it("can drop the new person straight into a family", async () => {
      const familyId = await createFamily(db(), orgId, "Popov");
      const { body } = await as(admin).call("POST", "/api/admin/users", {
        email: "boris@test.example",
        firstName: "Boris",
        role: "USER",
        familyId,
      });

      const { rows } = await db().query<{ family_id: string }>(
        "select family_id from persons where id = $1",
        [body.personId]
      );
      expect(rows[0]!.family_id).toBe(familyId);
    });

    it("refuses a family in another organization", async () => {
      const foreignFamily = await createFamily(db(), otherOrgId, "Georgiev");
      const { status } = await as(admin).call("POST", "/api/admin/users", {
        email: "nope@test.example",
        firstName: "Nope",
        role: "USER",
        familyId: foreignFamily,
      });
      expect(status).toBe(404);
    });

    it("refuses an email that already has an account", async () => {
      await as(admin).call("POST", "/api/admin/users", {
        email: "dup@test.example",
        firstName: "Dup",
        role: "USER",
      });
      const { status, body } = await as(admin).call("POST", "/api/admin/users", {
        email: "dup@test.example",
        firstName: "Dup",
        role: "USER",
      });
      expect(status).toBe(409);
      expect(body.error).toMatch(/already has an account/i);
    });

    it("gives a super admin invited with a church a record in it", async () => {
      const { status, body } = await as(superAdmin).call("POST", "/api/admin/users", {
        email: "super-with-parish@test.example",
        firstName: "Super",
        lastName: "Parishioner",
        role: "SUPER_ADMIN",
        organizationId: orgId,
      });
      expect(status).toBe(201);
      expect(body.organizationId).toBe(orgId);
      expect(body.personId).not.toBeNull();
      expect(body.personName).toBe("Super Parishioner");
    });

    it("gives a super admin no directory record until they have an organization", async () => {
      const { body } = await as(superAdmin).call("POST", "/api/admin/users", {
        email: "super2@test.example",
        firstName: "Super",
        role: "SUPER_ADMIN",
      });
      expect(body.organizationId).toBeNull();
      expect(body.personId).toBeNull();
    });
  });

  describe("changing an account", () => {
    let target: CreatedUser;

    beforeEach(async () => {
      target = await createUser(db(), { organizationId: orgId, email: "target@test.example" });
    });

    it("promotes a user to admin", async () => {
      const { status, body } = await as(admin).call(
        "PATCH",
        `/api/admin/users/${target.appUserId}`,
        { role: "ADMIN" }
      );
      expect(status).toBe(200);
      expect(body.role).toBe("ADMIN");
    });

    it("stops an admin promoting anyone to super admin", async () => {
      const { status } = await as(admin).call("PATCH", `/api/admin/users/${target.appUserId}`, {
        role: "SUPER_ADMIN",
      });
      expect(status).toBe(403);
    });

    it("stops an admin moving someone between organizations", async () => {
      const { status } = await as(admin).call("PATCH", `/api/admin/users/${target.appUserId}`, {
        organizationId: otherOrgId,
      });
      expect(status).toBe(403);
    });

    it("lets a super admin move someone between organizations, record and all", async () => {
      const { status, body } = await as(superAdmin).call(
        "PATCH",
        `/api/admin/users/${target.appUserId}`,
        { organizationId: otherOrgId }
      );
      expect(status).toBe(200);
      expect(body.organizationName).toBe("St. George");

      // The account used to move on its own, leaving the directory record
      // behind in the old organization. api.membership.test.ts covers the
      // fallout in detail; this pins the basics at the point of the move.
      const { rows } = await db().query<{ organization_id: string; family_id: string | null }>(
        "select organization_id, family_id from persons where app_user_id = $1",
        [target.appUserId]
      );
      expect(rows[0]!.organization_id).toBe(otherOrgId);
      expect(rows[0]!.family_id).toBeNull();
    });

    it("refuses to demote a super admin who has no church", async () => {
      // Only super admins may be church-less, so the demotion would violate the
      // CHECK constraint. It used to surface as an unexplained 400.
      const { status, body } = await as(superAdmin).call(
        "PATCH",
        `/api/admin/users/${superAdmin.appUserId}`,
        { role: "ADMIN" }
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/choose a church/i);
    });

    it("allows the demotion when a church is given in the same request", async () => {
      const other = await createUser(db(), {
        organizationId: null,
        role: "SUPER_ADMIN",
        email: "demote-me@test.example",
      });
      const { status, body } = await as(superAdmin).call(
        "PATCH",
        `/api/admin/users/${other.appUserId}`,
        { role: "ADMIN", organizationId: orgId, firstName: "Demoted" }
      );
      expect(status).toBe(200);
      expect(body.role).toBe("ADMIN");
      expect(body.organizationName).toBe("All Saints");
      expect(body.personName).toBe("Demoted");
    });

    it("stops an admin touching a super admin", async () => {
      const { status } = await as(admin).call("PATCH", `/api/admin/users/${superAdmin.appUserId}`, {
        status: "DISABLED",
      });
      expect(status).toBe(404);
    });

    it("locks out a disabled account on its next request", async () => {
      expect(
        (
          await as(admin).call("PATCH", `/api/admin/users/${target.appUserId}`, {
            status: "DISABLED",
          })
        ).status
      ).toBe(200);
      expect((await as(target).call("GET", "/api/me")).status).toBe(403);
    });

    it("changes the address an account signs in with", async () => {
      const { status, body } = await as(admin).call(
        "PUT",
        `/api/admin/users/${target.appUserId}/email`,
        { email: "Renamed@Test.Example" }
      );
      expect(status).toBe(200);
      expect(body.email).toBe("renamed@test.example");
    });
  });

  /*
   * The permanent one. Disabling is the PATCH above and keeps every row; this
   * takes the account, the Cognito user and the directory record together,
   * which is what makes it safe to remove a Person who has a login at all --
   * DELETE /persons/:id refuses exactly that case.
   */
  describe("deleting an account", () => {
    let target: CreatedUser;

    beforeEach(async () => {
      target = await createUser(db(), { organizationId: orgId, email: "target@test.example" });
    });

    const appUserRows = async (id: string) =>
      (await db().query("select id from app_users where id = $1", [id])).rows;
    const personRows = async (id: string) =>
      (await db().query("select id from persons where id = $1", [id])).rows;

    it("removes the account and the directory record, not just the login", async () => {
      const { status } = await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`);
      expect(status).toBe(204);
      expect(await appUserRows(target.appUserId)).toHaveLength(0);
      // Hard, not the soft delete /persons/:id does -- the row is gone, not
      // flagged, so there is nothing left for deleted_at to be checked against.
      expect(await personRows(target.personId!)).toHaveLength(0);
    });

    it("takes their own special dates with them", async () => {
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: target.personId!,
        type: "BIRTHDAY",
        month: 4,
        day: 12,
      });

      await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`);

      const { rows } = await db().query("select id from special_dates where person_id = $1", [
        target.personId,
      ]);
      expect(rows).toHaveLength(0);
    });

    it("removes a shared anniversary from the other person's record too", async () => {
      /*
       * The consequence the confirmation on the admin screen promises, and the
       * one nobody would guess: special_dates cascades on related_person_id as
       * well as person_id, so the surviving spouse loses the date from their
       * own record. If this ever stops being true the dialog is lying.
       */
      const spouse = await createUser(db(), {
        organizationId: orgId,
        email: "spouse@test.example",
      });
      await createSpecialDate(db(), {
        organizationId: orgId,
        personId: spouse.personId!,
        relatedPersonId: target.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 1,
        year: 2010,
      });

      await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`);

      const { rows } = await db().query("select id from special_dates where person_id = $1", [
        spouse.personId,
      ]);
      expect(rows).toHaveLength(0);
      // The spouse themselves is untouched.
      expect(await personRows(spouse.personId!)).toHaveLength(1);
    });

    it("sends a family member who inherited from them back to their own value", async () => {
      /*
       * clearInheritanceFor nulls the pointer; it does not copy the value down.
       * So the child stops showing the deleted person's surname and shows their
       * own again -- which is what the confirmation on the person page has
       * always promised ("will go back to their own"), and is only observable
       * through persons_resolved, where inheritance is applied.
       */
      const familyId = await createFamily(db(), orgId, "Inheritors");
      await db().query("update persons set family_id = $2, last_name = 'Haddad' where id = $1", [
        target.personId,
        familyId,
      ]);
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Child",
        lastName: "Popov",
      });
      await setInheritance(db(), child, { lastName: target.personId! });

      const before = await db().query<{ last_name: string | null }>(
        "select last_name from persons_resolved where id = $1",
        [child]
      );
      expect(before.rows[0]!.last_name).toBe("Haddad");

      await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`);

      const after = await db().query<{ last_name: string | null }>(
        "select last_name from persons_resolved where id = $1",
        [child]
      );
      expect(after.rows[0]!.last_name).toBe("Popov");
    });

    it("hides another parish's account behind a 404 rather than a refusal", async () => {
      const outsider = await createUser(db(), {
        organizationId: otherOrgId,
        email: "outsider@test.example",
      });
      const { status } = await as(admin).call("DELETE", `/api/admin/users/${outsider.appUserId}`);
      expect(status).toBe(404);
      expect(await appUserRows(outsider.appUserId)).toHaveLength(1);
    });

    it("stops an admin deleting a super admin in their own parish", async () => {
      // A super admin who has been given a parish passes the org-scope check,
      // so this is the case where the role check is what refuses.
      const localSuper = await createUser(db(), {
        organizationId: orgId,
        role: "SUPER_ADMIN",
        email: "local-super@test.example",
      });
      const { status } = await as(admin).call("DELETE", `/api/admin/users/${localSuper.appUserId}`);
      expect(status).toBe(403);
      expect(await appUserRows(localSuper.appUserId)).toHaveLength(1);
    });

    it("hides a parish-less super admin behind a 404 instead", async () => {
      // Org scope is checked before role, and a parish-less super admin is in
      // nobody's parish -- so an admin cannot even learn the account exists.
      // Same ordering as the PATCH case above.
      const { status } = await as(admin).call("DELETE", `/api/admin/users/${superAdmin.appUserId}`);
      expect(status).toBe(404);
      expect(await appUserRows(superAdmin.appUserId)).toHaveLength(1);
    });

    it("refuses to delete the caller's own account", async () => {
      /*
       * Also what makes a "last super admin" guard unnecessary: only a super
       * admin can delete a super admin, and this refuses self, so any such
       * delete leaves at least the caller.
       */
      const { status } = await as(admin).call("DELETE", `/api/admin/users/${admin.appUserId}`);
      expect(status).toBe(400);
      expect(await appUserRows(admin.appUserId)).toHaveLength(1);
    });

    it("deletes an account that has no directory record", async () => {
      // A super admin with no parish gets no persons row at all, so the person
      // half of this is simply absent rather than missing.
      const { status } = await as(superAdmin).call(
        "DELETE",
        `/api/admin/users/${superAdmin.appUserId}`
      );
      expect(status).toBe(400); // self

      const parishless = await createUser(db(), {
        organizationId: null,
        role: "SUPER_ADMIN",
        email: "parishless@test.example",
      });
      expect(
        (await as(superAdmin).call("DELETE", `/api/admin/users/${parishless.appUserId}`)).status
      ).toBe(204);
      expect(await appUserRows(parishless.appUserId)).toHaveLength(0);
    });

    it("records who did it, against an id that no longer exists", async () => {
      await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`);
      const { rows } = await db().query<{ action: string; actor_app_user_id: string | null }>(
        "select action, actor_app_user_id from audit_log where entity_id = $1",
        [target.appUserId]
      );
      expect(rows.map((r) => r.action)).toContain("user.delete");
      // The actor is the caller, so the trail outlives the account it names.
      expect(rows[0]!.actor_app_user_id).toBe(admin.appUserId);
    });
  });

  describe("first sign-in", () => {
    /** An account exactly as POST /api/admin/users leaves it: sub already stored. */
    async function invitedRow(email: string, sub: string): Promise<void> {
      await db().query(
        `insert into app_users (cognito_sub, email, role, organization_id, status)
         values ($1, $2, 'USER', $3, 'INVITED')`,
        [sub, email, orgId]
      );
    }

    const statusOf = async (email: string): Promise<string> => {
      const { rows } = await db().query<{ status: string }>(
        "select status from app_users where email = $1",
        [email]
      );
      return rows[0]!.status;
    };

    it("marks an invited account active the first time it signs in", async () => {
      await invitedRow("invitee@test.example", "sub-invitee");

      const { status, body } = await client(db(), {
        sub: "sub-invitee",
        email: "invitee@test.example",
      }).call("GET", "/api/me");

      expect(status).toBe(200);
      // Right on the request that activated it, not one request late.
      expect(body.appUser.status).toBe("ACTIVE");
      expect(await statusOf("invitee@test.example")).toBe("ACTIVE");
    });

    it("shows as active on the People & Accounts list once they have signed in", async () => {
      await invitedRow("invitee@test.example", "sub-invitee");

      const before = await as(admin).call("GET", "/api/admin/users");
      expect(before.body.users.find((u: any) => u.email === "invitee@test.example").status).toBe(
        "INVITED"
      );

      await client(db(), { sub: "sub-invitee", email: "invitee@test.example" }).call(
        "GET",
        "/api/me"
      );

      const after = await as(admin).call("GET", "/api/admin/users");
      expect(after.body.users.find((u: any) => u.email === "invitee@test.example").status).toBe(
        "ACTIVE"
      );
    });

    it("does not resurrect a disabled account", async () => {
      await db().query(
        `insert into app_users (cognito_sub, email, role, organization_id, status)
         values ('sub-disabled', 'disabled@test.example', 'USER', $1, 'DISABLED')`,
        [orgId]
      );

      const { status } = await client(db(), {
        sub: "sub-disabled",
        email: "disabled@test.example",
      }).call("GET", "/api/me");

      expect(status).toBe(403);
      expect(await statusOf("disabled@test.example")).toBe("DISABLED");
    });
  });

  describe("bootstrap super admin", () => {
    it("binds an unclaimed account to the Cognito subject on first sign-in", async () => {
      // V3__bootstrap_super_admin.sql inserts exactly this: a super admin row
      // with no cognito_sub, because the database is private and the row has to
      // arrive with the migrations.
      await db().query(
        `insert into app_users (email, role, organization_id, status)
         values ('bootstrap@test.example', 'SUPER_ADMIN', null, 'INVITED')`
      );

      const { status, body } = await client(db(), {
        sub: "sub-from-cognito",
        email: "bootstrap@test.example",
      }).call("GET", "/api/me");

      expect(status).toBe(200);
      expect(body.appUser.role).toBe("SUPER_ADMIN");
      expect(body.appUser.status).toBe("ACTIVE");

      const { rows } = await db().query<{ cognito_sub: string }>(
        "select cognito_sub from app_users where email = 'bootstrap@test.example'"
      );
      expect(rows[0]!.cognito_sub).toBe("sub-from-cognito");
    });

    it("refuses to bind when the email is not verified", async () => {
      await db().query(
        `insert into app_users (email, role, organization_id, status)
         values ('unverified@test.example', 'SUPER_ADMIN', null, 'INVITED')`
      );

      const { status } = await client(db(), {
        sub: "sub-unverified",
        email: "unverified@test.example",
        emailVerified: false,
      }).call("GET", "/api/me");
      expect(status).toBe(403);
    });

    it("will not rebind an account that already has a subject", async () => {
      const existing = await createUser(db(), {
        organizationId: orgId,
        email: "claimed@test.example",
      });
      const { status } = await client(db(), {
        sub: "different-sub",
        email: existing.email,
      }).call("GET", "/api/me");
      expect(status).toBe(403);
    });
  });

  describe("GET /api/me", () => {
    it("gives a super admin the organizations they can switch between", async () => {
      const { body } = await as(superAdmin).call("GET", "/api/me");
      expect(body.availableOrganizations.map((o: any) => o.name).sort()).toEqual([
        "All Saints",
        "St. George",
      ]);
    });

    it("gives everyone else no switcher", async () => {
      const { body } = await as(admin).call("GET", "/api/me");
      expect(body.availableOrganizations).toEqual([]);
      expect(body.organization.name).toBe("All Saints");
    });
  });
});
