import { afterAll, beforeEach, describe, expect, it, inject, vi } from "vitest";
import * as email from "../src/email";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createFamily, createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

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

    it("disables rather than deletes", async () => {
      expect((await as(admin).call("DELETE", `/api/admin/users/${target.appUserId}`)).status).toBe(
        204
      );
      const { rows } = await db().query<{ status: string }>(
        "select status from app_users where id = $1",
        [target.appUserId]
      );
      expect(rows[0]!.status).toBe("DISABLED");
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
