import { afterAll, afterEach, beforeEach, describe, expect, it, inject, vi } from "vitest";
import * as cognito from "../src/cognito";
import * as email from "../src/email";
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

/**
 * Changing the address an account signs in with: self-service (a code to the
 * new address, nothing changes until it is confirmed) and the admin override
 * (immediate, for someone who has lost access to their old mailbox). See
 * api/src/services/email-change.ts.
 */
describe.skipIf(!hasDb)("changing a sign-in email", () => {
  const db = () => testDb();
  let orgId: string;
  let admin: CreatedUser;
  let member: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
    });
    member = await createUser(db(), { organizationId: orgId, email: "member@test.example" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  // vi.spyOn on a property that is already a spy returns that same spy
  // rather than stacking a new one, so call history survives into the next
  // `it` unless it is explicitly cleared here.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  const appUserEmail = async (appUserId: string) =>
    (
      await db().query<{ email: string }>(
        "select email::text as email from app_users where id = $1",
        [appUserId]
      )
    ).rows[0]!.email;

  const personEmail = async (appUserId: string) =>
    (
      await db().query<{ email: string | null }>(
        "select email::text as email from persons where app_user_id = $1",
        [appUserId]
      )
    ).rows[0]!.email;

  /** Spies on the code email and hands back a getter for the code it sent. */
  function captureCode(): () => string {
    let captured = "";
    vi.spyOn(email, "sendEmailChangeCodeEmail").mockImplementation(async ({ code }) => {
      captured = code;
    });
    return () => captured;
  }

  describe("self-service", () => {
    it("holds the change until the code is confirmed, then mirrors both emails", async () => {
      const code = captureCode();
      const notice = vi.spyOn(email, "sendEmailChangedNoticeEmail").mockResolvedValue();
      const updateEmail = vi.spyOn(cognito, "updateUserEmail").mockResolvedValue();

      const requested = await as(member).call("POST", "/api/me/email", {
        email: "new@test.example",
      });
      expect(requested.status).toBe(200);
      expect(requested.body.email).toBe("new@test.example");
      expect(updateEmail).not.toHaveBeenCalled();
      expect(await appUserEmail(member.appUserId)).toBe(member.email);

      const confirmed = await as(member).call("POST", "/api/me/email/confirm", {
        code: code(),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.appUser.email).toBe("new@test.example");

      // By sub, not by the old email -- updateUserEmail never changes the
      // username, so a second change would be looked up by the wrong value.
      expect(updateEmail).toHaveBeenCalledWith(member.cognitoSub, "new@test.example");
      expect(await appUserEmail(member.appUserId)).toBe("new@test.example");
      expect(await personEmail(member.appUserId)).toBe("new@test.example");
      expect(notice).toHaveBeenCalledWith(
        expect.objectContaining({ to: member.email, newEmail: "new@test.example" })
      );
    });

    it("refuses a wrong code three times, then refuses the right one too", async () => {
      const code = captureCode();
      vi.spyOn(email, "sendEmailChangedNoticeEmail").mockResolvedValue();
      vi.spyOn(cognito, "updateUserEmail").mockResolvedValue();

      await as(member).call("POST", "/api/me/email", { email: "new@test.example" });

      for (let i = 0; i < 3; i++) {
        const { status } = await as(member).call("POST", "/api/me/email/confirm", {
          code: "000000",
        });
        expect(status).toBe(400);
      }

      // The attempt budget is spent -- even the code that was actually sent
      // is refused now, and a fresh request is the only way forward.
      const { status } = await as(member).call("POST", "/api/me/email/confirm", { code: code() });
      expect(status).toBe(400);
      expect(await appUserEmail(member.appUserId)).toBe(member.email);
    });

    it("refuses a code once the request has expired", async () => {
      const code = captureCode();
      await as(member).call("POST", "/api/me/email", { email: "new@test.example" });
      await db().query(
        "update email_change_requests set expires_at = now() - interval '1 minute' where app_user_id = $1",
        [member.appUserId]
      );

      const { status } = await as(member).call("POST", "/api/me/email/confirm", { code: code() });
      expect(status).toBe(400);
    });

    it("refuses an address that already belongs to another account", async () => {
      const { status, body } = await as(member).call("POST", "/api/me/email", {
        email: admin.email,
      });
      expect(status).toBe(409);
      expect(body.error).toMatch(/already has an account/i);
    });

    it("cancelling drops the pending request without changing anything", async () => {
      captureCode();
      await as(member).call("POST", "/api/me/email", { email: "new@test.example" });

      const { status } = await as(member).call("DELETE", "/api/me/email");
      expect(status).toBe(204);

      const { rows } = await db().query(
        "select 1 from email_change_requests where app_user_id = $1",
        [member.appUserId]
      );
      expect(rows).toHaveLength(0);
    });

    it("lets every other field in the save commit while the email waits on a code", async () => {
      captureCode();

      const { status, body } = await as(member).call("PATCH", `/api/persons/${member.personId}`, {
        firstName: "Changed",
        email: "new@test.example",
      });
      expect(status).toBe(200);
      expect(body.firstName).toBe("Changed");
      expect(body.pendingEmailChange).toEqual({
        email: "new@test.example",
        expiresAt: expect.any(String),
      });

      const { rows } = await db().query<{ first_name: string; email: string | null }>(
        "select first_name, email::text as email from persons where id = $1",
        [member.personId]
      );
      expect(rows[0]!.first_name).toBe("Changed");
      expect(rows[0]!.email).toBe(member.email);
    });
  });

  describe("admin override", () => {
    it("changes both emails immediately, with no code, and notifies the old address", async () => {
      const notice = vi.spyOn(email, "sendEmailChangedNoticeEmail").mockResolvedValue();
      const updateEmail = vi.spyOn(cognito, "updateUserEmail").mockResolvedValue();
      const codeEmail = vi.spyOn(email, "sendEmailChangeCodeEmail");

      const { status, body } = await as(admin).call(
        "PUT",
        `/api/admin/users/${member.appUserId}/email`,
        { email: "Rescued@Test.Example" }
      );
      expect(status).toBe(200);
      expect(body.email).toBe("rescued@test.example");
      expect(codeEmail).not.toHaveBeenCalled();
      expect(updateEmail).toHaveBeenCalledWith(member.cognitoSub, "rescued@test.example");
      expect(notice).toHaveBeenCalledWith(
        expect.objectContaining({ to: member.email, newEmail: "rescued@test.example" })
      );
      expect(await personEmail(member.appUserId)).toBe("rescued@test.example");
    });

    it("refuses an address already in use", async () => {
      const { status } = await as(admin).call("PUT", `/api/admin/users/${member.appUserId}/email`, {
        email: admin.email,
      });
      expect(status).toBe(409);
    });

    it("also applies immediately through PATCH /persons/:id, with no pendingEmailChange", async () => {
      vi.spyOn(email, "sendEmailChangedNoticeEmail").mockResolvedValue();
      vi.spyOn(cognito, "updateUserEmail").mockResolvedValue();

      const { status, body } = await as(admin).call("PATCH", `/api/persons/${member.personId}`, {
        email: "rescued2@test.example",
      });
      expect(status).toBe(200);
      expect(body.email).toBe("rescued2@test.example");
      expect(body.pendingEmailChange).toBeUndefined();
      expect(await appUserEmail(member.appUserId)).toBe("rescued2@test.example");
    });
  });

  describe("email inheritance", () => {
    it("is refused for a person who has their own account", async () => {
      const familyId = await createFamily(db(), orgId);
      await db().query("update persons set family_id = $2 where id = $1", [
        member.personId,
        familyId,
      ]);
      const spouse = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Spouse",
      });

      const { status, body } = await as(member).call("PATCH", `/api/persons/${member.personId}`, {
        inheritEmailFromPersonId: spouse,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/signs in with their own email/i);
    });

    it("still works for a family member who has no account", async () => {
      const familyId = await createFamily(db(), orgId);
      await db().query("update persons set family_id = $2 where id = $1", [
        member.personId,
        familyId,
      ]);
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Child",
      });

      const { status } = await as(member).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: member.personId,
      });
      expect(status).toBe(200);
    });
  });
});
