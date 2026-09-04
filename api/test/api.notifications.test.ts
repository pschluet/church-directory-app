import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

/**
 * The notification inbox behind the bell.
 *
 * Most of this file is about who is *not* told: the author, the reviewer who
 * just posted it, anyone who has switched prayer requests off, anyone who has
 * never signed in or has been disabled, and every member of another parish.
 * Getting that wrong is how a parish directory starts sending mail nobody asked
 * for.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("notifications", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgA: string;
  let orgB: string;
  let author: CreatedUser;
  let member: CreatedUser;
  let other: CreatedUser;
  let reviewer: CreatedUser;
  let admin: CreatedUser;
  let outsider: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgA = await createOrganization(db(), "All Saints", "all-saints");
    orgB = await createOrganization(db(), "St. George", "st-george");

    author = await createUser(db(), { organizationId: orgA, email: "author@a.test" });
    member = await createUser(db(), { organizationId: orgA, email: "member@a.test" });
    other = await createUser(db(), { organizationId: orgA, email: "other@a.test" });
    reviewer = await createUser(db(), {
      organizationId: orgA,
      role: "PRAYER_REQUEST_ADMIN",
      email: "reviewer@a.test",
    });
    // An ADMIN reviews too -- the role is a floor -- so the review fan-out has
    // to reach them without naming their role anywhere.
    admin = await createUser(db(), {
      organizationId: orgA,
      role: "ADMIN",
      email: "admin@a.test",
    });
    outsider = await createUser(db(), { organizationId: orgB, email: "outsider@b.test" });
  });

  afterAll(closeDatabase);

  /** Submits and posts one request, returning its id. */
  async function post(title = "For my mother"): Promise<string> {
    const { body } = await as(author).call("POST", "/api/prayer-requests", {
      title,
      body: "Surgery Thursday.",
    });
    await as(reviewer).call("POST", `/api/prayer-requests/${body.id}/approve`);
    return body.id;
  }

  const inbox = (u: CreatedUser) => as(u).call("GET", "/api/notifications");

  describe("fan-out on approval", () => {
    it("tells the other members, with the request's title", async () => {
      await post("For my mother");
      const { status, body } = await inbox(member);
      expect(status).toBe(200);
      expect(body.unreadCount).toBe(1);
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]).toMatchObject({
        type: "PRAYER_REQUEST",
        title: "For my mother",
        read: false,
      });
      expect(body.notifications[0].prayerRequestId).toBeTruthy();
    });

    it("tells the author their request is now up", async () => {
      // The most useful notification this app sends: until it arrives the
      // author has no signal that anything happened to what they wrote.
      await post("For my mother");
      const { body } = await inbox(author);
      expect(body.unreadCount).toBe(1);
      expect(body.notifications[0]).toMatchObject({ title: "For my mother", read: false });
    });

    it("does not tell the reviewer, who is the one who just posted it", async () => {
      /*
       * Load-bearing in two directions, so do not "simplify" it. The reviewer
       * is excluded from the posted fan-out because they acted -- and they also
       * held a PRAYER_REQUEST_REVIEW notification for this request, which is
       * only invisible here because approval moved it out of PENDING. Reverse
       * either half of NOTIFICATION_VISIBLE and this is the case that fails.
       */
      await post();
      const { body } = await inbox(reviewer);
      expect(body).toMatchObject({ unreadCount: 0, notifications: [] });
    });

    it("does not tell another parish", async () => {
      await post();
      const { body } = await inbox(outsider);
      expect(body.unreadCount).toBe(0);
    });

    it("says nothing to the parish until the request is approved", async () => {
      await as(author).call("POST", "/api/prayer-requests", {
        title: "Still waiting",
        body: "Not yet reviewed.",
      });
      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(0);
      // The reviewers are a different matter -- see "waiting for review" below.
      expect((await inbox(reviewer)).body.unreadCount).toBe(1);
    });

    it("says nothing when a request is declined", async () => {
      const { body: created } = await as(author).call("POST", "/api/prayer-requests", {
        title: "Declined",
        body: "No.",
      });
      await as(reviewer).call("POST", `/api/prayer-requests/${created.id}/reject`);
      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(0);
    });

    it("tells nobody at all when a reviewer posts their own request directly", async () => {
      // They are both the author and the person who acted, so there is nobody
      // to exclude twice and nobody left out who should have been told.
      const { body: created } = await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      expect(created.status).toBe("APPROVED");

      expect((await inbox(reviewer)).body.unreadCount).toBe(0);
      // Everyone else still hears about it.
      expect((await inbox(member)).body.unreadCount).toBe(1);
      expect((await inbox(author)).body.unreadCount).toBe(1);
    });

    it("counts one per request, newest first", async () => {
      await post("First");
      await post("Second");
      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(2);
      expect(body.notifications.map((n: { title: string }) => n.title)).toEqual([
        "Second",
        "First",
      ]);
    });

    it("skips an account that has never signed in, or has been disabled", async () => {
      const invited = await createUser(db(), { organizationId: orgA, email: "invited@a.test" });
      const disabled = await createUser(db(), { organizationId: orgA, email: "disabled@a.test" });
      await db().query("update app_users set status = 'INVITED' where id = $1", [
        invited.appUserId,
      ]);
      await db().query("update app_users set status = 'DISABLED' where id = $1", [
        disabled.appUserId,
      ]);

      await post();

      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notifications where app_user_id = any($1)",
        [[invited.appUserId, disabled.appUserId]]
      );
      expect(rows[0]!.count).toBe("0");
    });

    it("is idempotent, so a repeated fan-out cannot double up", async () => {
      const id = await post();
      // What a race between two reviewers, or a retry, would do.
      await db().query(
        `insert into notifications (app_user_id, organization_id, type, prayer_request_id)
         values ($1, $2, 'PRAYER_REQUEST', $3)
         on conflict do nothing`,
        [member.appUserId, orgA, id]
      );
      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(1);
    });
  });

  describe("waiting for review", () => {
    /** A request that stays pending, so the review notifications survive. */
    async function submit(title = "For my mother"): Promise<string> {
      const { body } = await as(author).call("POST", "/api/prayer-requests", {
        title,
        body: "Surgery Thursday.",
      });
      return body.id;
    }

    it("tells every reviewer in the parish, by title", async () => {
      await submit("For my mother");

      for (const who of [reviewer, admin]) {
        const { body } = await inbox(who);
        expect(body.unreadCount).toBe(1);
        expect(body.notifications[0]).toMatchObject({
          type: "PRAYER_REQUEST_REVIEW",
          title: "For my mother",
          read: false,
        });
      }
    });

    it("does not tell the author, or anyone who cannot review", async () => {
      await submit();
      expect((await inbox(author)).body.unreadCount).toBe(0);
      expect((await inbox(member)).body.unreadCount).toBe(0);
    });

    it("does not tell another parish's reviewer", async () => {
      const elsewhere = await createUser(db(), {
        organizationId: orgB,
        role: "PRAYER_REQUEST_ADMIN",
        email: "reviewer@b.test",
      });
      await submit();
      expect((await inbox(elsewhere)).body.unreadCount).toBe(0);
    });

    it("does not tell a super admin with no home parish", async () => {
      /*
       * They may approve anywhere, but this is scoped to the parish -- so the
       * bootstrap super admin from V3, whose organization_id is null, is not
       * told. Asserted because it is a deliberate limitation, not an oversight.
       */
      const wandering = await createUser(db(), {
        organizationId: null,
        role: "SUPER_ADMIN",
        email: "super@nowhere.test",
      });
      await submit();
      expect((await inbox(wandering)).body.unreadCount).toBe(0);
    });

    it("respects a reviewer who has switched prayer requests off", async () => {
      await as(reviewer).call("PUT", "/api/notifications/preferences", {
        prayerRequests: false,
      });
      await submit();
      expect((await inbox(reviewer)).body.unreadCount).toBe(0);
      expect((await inbox(admin)).body.unreadCount).toBe(1);
    });

    it("clears itself once the request is approved, even by somebody else", async () => {
      // The reviewer who acts is excluded from the posted fan-out, so Layla
      // ends at zero; the admin swaps one kind of notification for the other.
      const id = await submit();
      expect((await inbox(admin)).body.unreadCount).toBe(1);

      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);

      expect((await inbox(reviewer)).body.unreadCount).toBe(0);
      const { body } = await inbox(admin);
      expect(body.unreadCount).toBe(1);
      expect(body.notifications[0]!.type).toBe("PRAYER_REQUEST");
    });

    it("clears itself when the request is rejected, leaving nothing", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`);

      for (const who of [reviewer, admin, author, member]) {
        expect((await inbox(who)).body.unreadCount).toBe(0);
      }
    });

    it("keeps the row -- it is the join that hides it, not a delete", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);

      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notifications where type = 'PRAYER_REQUEST_REVIEW'"
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    });

    it("says nothing when a reviewer posts their own, since it needs no review", async () => {
      await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      // Nothing to review, so the admin hears about it as a *posted* request.
      const { body } = await inbox(admin);
      expect(body.unreadCount).toBe(1);
      expect(body.notifications[0]!.type).toBe("PRAYER_REQUEST");
    });

    it("is idempotent, so a retry cannot double up", async () => {
      const id = await submit();
      await db().query(
        `insert into notifications (app_user_id, organization_id, type, prayer_request_id)
         values ($1, $2, 'PRAYER_REQUEST_REVIEW', $3)
         on conflict do nothing`,
        [reviewer.appUserId, orgA, id]
      );
      expect((await inbox(reviewer)).body.unreadCount).toBe(1);
    });

    it("can hold both kinds for one request without colliding", async () => {
      /*
       * The unique index is (app_user_id, type, prayer_request_id), so a
       * reviewer legitimately holds a review row and a posted row for the same
       * request. Exactly one is ever visible.
       */
      const id = await submit();
      await as(admin).call("POST", `/api/prayer-requests/${id}/approve`);

      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notifications where app_user_id = $1 and prayer_request_id = $2",
        [reviewer.appUserId, id]
      );
      expect(rows[0]!.count).toBe("2");
      expect((await inbox(reviewer)).body.notifications).toHaveLength(1);
    });
  });

  describe("preferences", () => {
    it("defaults to on, with no row stored", async () => {
      const { status, body } = await as(member).call("GET", "/api/notifications/preferences");
      expect(status).toBe(200);
      expect(body).toEqual({ prayerRequests: true });

      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notification_preferences"
      );
      expect(rows[0]!.count).toBe("0");
    });

    it("skips a member who has switched prayer requests off", async () => {
      const off = await as(member).call("PUT", "/api/notifications/preferences", {
        prayerRequests: false,
      });
      expect(off.body).toEqual({ prayerRequests: false });

      await post();

      expect((await inbox(member)).body.unreadCount).toBe(0);
      // Everyone else still hears about it, the author included.
      expect((await inbox(other)).body.unreadCount).toBe(1);
      expect((await inbox(author)).body.unreadCount).toBe(1);
    });

    it("skips an author who has switched prayer requests off", async () => {
      // Being the author is not an override: somebody who has asked not to be
      // notified about prayer requests has asked about all of them.
      await as(author).call("PUT", "/api/notifications/preferences", {
        prayerRequests: false,
      });

      await post();

      expect((await inbox(author)).body.unreadCount).toBe(0);
      expect((await inbox(member)).body.unreadCount).toBe(1);
    });

    it("switches back on again", async () => {
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: true });
      await post();
      expect((await inbox(member)).body.unreadCount).toBe(1);
    });

    it("leaves an unmentioned preference alone", async () => {
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      const { body } = await as(member).call("PUT", "/api/notifications/preferences", {});
      expect(body).toEqual({ prayerRequests: false });
    });

    it("is per account, not per parish", async () => {
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      const { body } = await as(other).call("GET", "/api/notifications/preferences");
      expect(body).toEqual({ prayerRequests: true });
    });
  });

  describe("marking read", () => {
    it("clears the badge", async () => {
      await post("First");
      await post("Second");
      expect((await inbox(member)).body.unreadCount).toBe(2);

      const { status, body } = await as(member).call("POST", "/api/notifications/read");
      expect(status).toBe(200);
      expect(body.cleared).toBe(2);

      const after = (await inbox(member)).body;
      expect(after.unreadCount).toBe(0);
      // Read, but still listed -- the panel is a short history, not just a queue.
      expect(after.notifications).toHaveLength(2);
      expect(after.notifications.every((n: { read: boolean }) => n.read)).toBe(true);
    });

    it("leaves one that arrived after the panel was opened unread", async () => {
      await post("First");
      await as(member).call("POST", "/api/notifications/read");
      await post("Second");

      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(1);
      expect(body.notifications[0]).toMatchObject({ title: "Second", read: false });
      expect(body.notifications[1]).toMatchObject({ title: "First", read: true });
    });

    it("touches nobody else's", async () => {
      await post();
      await as(member).call("POST", "/api/notifications/read");
      expect((await inbox(other)).body.unreadCount).toBe(1);
    });
  });

  describe("notifications that no longer lead anywhere", () => {
    it("drops one whose request has aged out of the window", async () => {
      const id = await post();
      await db().query(
        "update prayer_requests set posted_at = now() - interval '40 days' where id = $1",
        [id]
      );

      const { body } = await inbox(member);
      expect(body.unreadCount).toBe(0);
      expect(body.notifications).toEqual([]);

      // The row is still there; it is the join that hides it.
      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notifications"
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    });

    it("goes with the request when the author withdraws it", async () => {
      const id = await post();
      expect((await inbox(member)).body.unreadCount).toBe(1);

      await as(author).call("DELETE", `/api/prayer-requests/${id}`);

      expect((await inbox(member)).body.unreadCount).toBe(0);
      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from notifications"
      );
      expect(rows[0]!.count).toBe("0");
    });
  });
});
