import { afterAll, beforeEach, describe, expect, it, inject, vi } from "vitest";
import * as email from "../src/email";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("directory requests", () => {
  const db = () => testDb();
  const anonymous = () => client(db(), null);
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgId: string;
  let otherOrgId: string;
  let admin: CreatedUser;
  let secondAdmin: CreatedUser;
  let member: CreatedUser;
  let otherAdmin: CreatedUser;

  const request = (overrides: Record<string, unknown> = {}) => ({
    firstName: "Maria",
    lastName: "Lopez",
    email: "Maria@Example.com",
    organizationId: orgId,
    ...overrides,
  });

  async function pendingRequests() {
    const { rows } = await db().query<{ id: string; email: string; status: string }>(
      "select id, email::text as email, status from directory_requests order by requested_at"
    );
    return rows;
  }

  async function inbox(user: CreatedUser) {
    return (await as(user).call("GET", "/api/notifications")).body;
  }

  beforeEach(async () => {
    await resetTables();
    vi.spyOn(email, "sendInvitationEmail").mockResolvedValue();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");
    admin = await createUser(db(), { organizationId: orgId, role: "ADMIN" });
    secondAdmin = await createUser(db(), { organizationId: orgId, role: "ADMIN" });
    member = await createUser(db(), { organizationId: orgId, role: "USER" });
    otherAdmin = await createUser(db(), { organizationId: otherOrgId, role: "ADMIN" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe("public", () => {
    it("lists churches by name without signing in", async () => {
      const { status, body } = await anonymous().call("GET", "/api/directory-requests/churches");
      expect(status).toBe(200);
      expect(body.churches).toEqual([
        { id: orgId, name: "All Saints" },
        { id: otherOrgId, name: "St. George" },
      ]);
    });

    it("accepts a request without signing in, lowercasing the address", async () => {
      const { status } = await anonymous().call("POST", "/api/directory-requests", request());
      expect(status).toBe(202);
      expect(await pendingRequests()).toMatchObject([
        { email: "maria@example.com", status: "PENDING" },
      ]);
    });

    it("requires every field", async () => {
      for (const missing of ["firstName", "lastName", "email", "organizationId"]) {
        const { status } = await anonymous().call(
          "POST",
          "/api/directory-requests",
          request({ [missing]: undefined })
        );
        expect(status, missing).toBe(400);
      }
      expect(await pendingRequests()).toEqual([]);
    });

    it("rejects a church that does not exist", async () => {
      const { status } = await anonymous().call(
        "POST",
        "/api/directory-requests",
        request({ organizationId: "00000000-0000-4000-8000-000000000000" })
      );
      expect(status).toBe(400);
    });

    it("stores nothing when the honeypot is filled, but answers the same", async () => {
      const { status } = await anonymous().call(
        "POST",
        "/api/directory-requests",
        request({ website: "http://spam.example" })
      );
      expect(status).toBe(202);
      expect(await pendingRequests()).toEqual([]);
    });

    it("keeps one pending request per address per church", async () => {
      await anonymous().call("POST", "/api/directory-requests", request());
      const again = await anonymous().call(
        "POST",
        "/api/directory-requests",
        request({ email: "maria@example.com" })
      );
      expect(again.status).toBe(202);
      expect(await pendingRequests()).toHaveLength(1);
      expect((await inbox(admin)).unreadCount).toBe(1);
    });

    it("stores nothing for an address that already has an account, but answers the same", async () => {
      const { status } = await anonymous().call(
        "POST",
        "/api/directory-requests",
        request({ email: member.email })
      );
      expect(status).toBe(202);
      expect(await pendingRequests()).toEqual([]);
    });
  });

  describe("notifications", () => {
    it("tells every administrator of that church, and nobody else", async () => {
      await anonymous().call("POST", "/api/directory-requests", request());

      for (const user of [admin, secondAdmin]) {
        const body = await inbox(user);
        expect(body.unreadCount).toBe(1);
        expect(body.notifications[0]).toMatchObject({
          type: "DIRECTORY_REQUEST",
          title: "Maria Lopez",
        });
      }
      expect((await inbox(member)).unreadCount).toBe(0);
      expect((await inbox(otherAdmin)).unreadCount).toBe(0);
    });

    it("skips an administrator who switched it off", async () => {
      const off = await as(admin).call("PUT", "/api/notifications/preferences", {
        directoryRequests: false,
      });
      expect(off.body.directoryRequests).toBe(false);
      // The other switches are left alone.
      expect(off.body.prayerRequests).toBe(true);

      await anonymous().call("POST", "/api/directory-requests", request());
      expect((await inbox(admin)).unreadCount).toBe(0);
      expect((await inbox(secondAdmin)).unreadCount).toBe(1);
    });

    it("defaults the switch on", async () => {
      const { body } = await as(admin).call("GET", "/api/notifications/preferences");
      expect(body.directoryRequests).toBe(true);
    });
  });

  describe("admin", () => {
    async function submit(): Promise<string> {
      await anonymous().call("POST", "/api/directory-requests", request());
      const { body } = await as(admin).call("GET", "/api/admin/directory-requests");
      return body.directoryRequests[0].id;
    }

    it("lists pending requests for the church", async () => {
      await submit();
      const { status, body } = await as(admin).call("GET", "/api/admin/directory-requests");
      expect(status).toBe(200);
      expect(body.directoryRequests).toMatchObject([
        { firstName: "Maria", lastName: "Lopez", email: "maria@example.com" },
      ]);

      const other = await as(otherAdmin).call("GET", "/api/admin/directory-requests");
      expect(other.body.directoryRequests).toEqual([]);
    });

    it("is for administrators only", async () => {
      const id = await submit();
      expect((await as(member).call("GET", "/api/admin/directory-requests")).status).toBe(403);
      expect(
        (await as(member).call("POST", `/api/admin/directory-requests/${id}/approve`)).status
      ).toBe(403);
    });

    it("approving invites them as a member, and clears every administrator's bell", async () => {
      const id = await submit();
      const { status, body } = await as(admin).call(
        "POST",
        `/api/admin/directory-requests/${id}/approve`
      );

      expect(status).toBe(201);
      expect(body).toMatchObject({
        email: "maria@example.com",
        role: "USER",
        status: "INVITED",
        organizationId: orgId,
        personName: "Maria Lopez",
      });
      expect(email.sendInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "maria@example.com", organizationName: "All Saints" })
      );
      expect(await pendingRequests()).toMatchObject([{ status: "APPROVED" }]);
      expect((await inbox(secondAdmin)).unreadCount).toBe(0);
      expect((await as(admin).call("GET", "/api/admin/directory-requests")).body).toEqual({
        directoryRequests: [],
      });

      const again = await as(secondAdmin).call(
        "POST",
        `/api/admin/directory-requests/${id}/approve`
      );
      expect(again.status).toBe(404);
    });

    it("declining clears the bell and invites nobody", async () => {
      const id = await submit();
      const { status } = await as(admin).call(
        "POST",
        `/api/admin/directory-requests/${id}/decline`
      );
      expect(status).toBe(204);
      expect(await pendingRequests()).toMatchObject([{ status: "DECLINED" }]);
      expect((await inbox(secondAdmin)).unreadCount).toBe(0);
      const { rows } = await db().query("select 1 from app_users where email = $1", [
        "maria@example.com",
      ]);
      expect(rows).toEqual([]);
    });

    it("cannot decide another church's request", async () => {
      const id = await submit();
      const { status } = await as(otherAdmin).call(
        "POST",
        `/api/admin/directory-requests/${id}/approve`
      );
      expect(status).toBe(404);
    });

    it("leaves the request pending when the address has since got an account", async () => {
      const id = await submit();
      await createUser(db(), { organizationId: orgId, email: "maria@example.com" });
      const { status } = await as(admin).call(
        "POST",
        `/api/admin/directory-requests/${id}/approve`
      );
      expect(status).toBe(409);
      expect(await pendingRequests()).toMatchObject([{ status: "PENDING" }]);
    });
  });
});
