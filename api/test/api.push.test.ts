import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

/**
 * Registering a device for Web Push.
 *
 * The upsert is the whole of it, and it exists for two real situations: the SPA
 * re-subscribes on every load and normally gets the identical subscription
 * back, and a phone signed into a second account presents the same endpoint
 * under a new owner. Neither may produce a duplicate or a 409.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("push subscriptions", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgA: string;
  let member: CreatedUser;
  let other: CreatedUser;

  const ENDPOINT = "https://push.example.test/abc123";
  const subscribeBody = (endpoint = ENDPOINT) => ({
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
  });

  beforeEach(async () => {
    await resetTables();
    orgA = await createOrganization(db(), "All Saints", "all-saints");
    member = await createUser(db(), { organizationId: orgA, email: "member@a.test" });
    other = await createUser(db(), { organizationId: orgA, email: "other@a.test" });
  });

  afterAll(closeDatabase);

  const stored = () =>
    db().query<{
      app_user_id: string;
      endpoint: string;
      p256dh: string;
      organization_id: string;
    }>("select app_user_id, endpoint, p256dh, organization_id from push_subscriptions");

  it("registers a device", async () => {
    const { status, body } = await as(member).call(
      "POST",
      "/api/push/subscriptions",
      subscribeBody()
    );
    expect(status).toBe(201);
    expect(body).toEqual({ subscribed: true });

    const { rows } = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      app_user_id: member.appUserId,
      endpoint: ENDPOINT,
      organization_id: orgA,
    });
  });

  it("is idempotent: re-subscribing updates rather than duplicating", async () => {
    await as(member).call("POST", "/api/push/subscriptions", subscribeBody());
    const { status } = await as(member).call("POST", "/api/push/subscriptions", {
      endpoint: ENDPOINT,
      keys: { p256dh: "rotated-key", auth: "auth-key" },
    });
    expect(status).toBe(201);

    const { rows } = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe("rotated-key");
  });

  it("moves a shared device to whoever signed in last", async () => {
    await as(member).call("POST", "/api/push/subscriptions", subscribeBody());
    await as(other).call("POST", "/api/push/subscriptions", subscribeBody());

    const { rows } = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app_user_id).toBe(other.appUserId);
  });

  it("keeps one row per device, so two phones both get notified", async () => {
    await as(member).call("POST", "/api/push/subscriptions", subscribeBody());
    await as(member).call(
      "POST",
      "/api/push/subscriptions",
      subscribeBody("https://push.example.test/laptop")
    );

    const { rows } = await stored();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.app_user_id === member.appUserId)).toBe(true);
  });

  it("refuses a subscription that is not https", async () => {
    const { status } = await as(member).call("POST", "/api/push/subscriptions", {
      endpoint: "http://push.example.test/abc",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(status).toBe(400);
  });

  it("refuses one with a key missing", async () => {
    const { status } = await as(member).call("POST", "/api/push/subscriptions", {
      endpoint: ENDPOINT,
      keys: { p256dh: "p256dh-key" },
    });
    expect(status).toBe(400);
  });

  describe("unsubscribing", () => {
    it("removes the device", async () => {
      await as(member).call("POST", "/api/push/subscriptions", subscribeBody());

      const { status, body } = await as(member).call("DELETE", "/api/push/subscriptions", {
        endpoint: ENDPOINT,
      });
      expect(status).toBe(200);
      expect(body).toEqual({ subscribed: false });
      expect((await stored()).rows).toHaveLength(0);
    });

    it("will not let one member silence another's phone", async () => {
      await as(member).call("POST", "/api/push/subscriptions", subscribeBody());

      const { status } = await as(other).call("DELETE", "/api/push/subscriptions", {
        endpoint: ENDPOINT,
      });
      expect(status).toBe(404);
      expect((await stored()).rows).toHaveLength(1);
    });

    it("404s on a device that was never registered", async () => {
      const { status } = await as(member).call("DELETE", "/api/push/subscriptions", {
        endpoint: "https://push.example.test/never",
      });
      expect(status).toBe(404);
    });
  });

  it("goes away with the account", async () => {
    await as(member).call("POST", "/api/push/subscriptions", subscribeBody());
    await db().query("delete from app_users where id = $1", [member.appUserId]);
    expect((await stored()).rows).toHaveLength(0);
  });

  describe("staying inside one parish", () => {
    /*
     * The guarantee somebody will want to check before trusting this with a
     * second parish: a prayer request posted in one must never reach a phone
     * belonging to another.
     *
     * It holds by composition rather than by a filter in the sender --
     * `sendToUsers` selects `where app_user_id = any(...)`, and that array comes
     * from a fan-out scoped to `u.organization_id = $2`. Both halves are tested
     * separately (see "does not tell another parish" in
     * api.notifications.test.ts, and "does not send to a device whose owner is
     * not in the payload map" in push.test.ts), which means nobody reading
     * either file alone can see the property. This asserts it in one place.
     */
    async function registerDeviceFor(user: CreatedUser, organizationId: string): Promise<void> {
      await db().query(
        `insert into push_subscriptions
           (app_user_id, organization_id, endpoint, p256dh, auth)
         values ($1, $2, $3, 'p256dh-key', 'auth-key')`,
        [user.appUserId, organizationId, `https://push.example.test/${user.appUserId}`]
      );
    }

    it("never selects another parish's device for a request posted here", async () => {
      const orgB = await createOrganization(db(), "St. George", "st-george");
      const author = await createUser(db(), { organizationId: orgA, email: "author@a.test" });
      const reviewer = await createUser(db(), {
        organizationId: orgA,
        role: "PRAYER_REQUEST_ADMIN",
        email: "reviewer@a.test",
      });
      const elsewhere = await createUser(db(), { organizationId: orgB, email: "elsewhere@b.test" });

      // A phone in each parish, both of them subscribed and opted in.
      await registerDeviceFor(member, orgA);
      await registerDeviceFor(elsewhere, orgB);

      const { body: created } = await as(author).call("POST", "/api/prayer-requests", {
        title: "Only this parish",
        body: "Nobody in St. George should hear about it.",
      });
      await as(reviewer).call("POST", `/api/prayer-requests/${created.id}/approve`);

      /*
       * The recipients are exactly the accounts holding a notification, since
       * that is the list `pushToNotified` is handed. So the question "could a
       * push reach the wrong parish" is the question "does the sender's own
       * query, given those ids, return a device from the wrong parish".
       */
      const { rows } = await db().query<{ email: string; organization_id: string }>(
        `select u.email::text as email, s.organization_id
           from push_subscriptions s
           join app_users u on u.id = s.app_user_id
          where s.app_user_id = any(
            select distinct app_user_id from notifications
          )`
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organization_id === orgA)).toBe(true);
      expect(rows.map((row) => row.email)).not.toContain("elsewhere@b.test");
    });

    it("tells nobody in the other parish, on the bell either", async () => {
      const orgB = await createOrganization(db(), "St. George", "st-george");
      const author = await createUser(db(), { organizationId: orgA, email: "author2@a.test" });
      const reviewer = await createUser(db(), {
        organizationId: orgA,
        role: "PRAYER_REQUEST_ADMIN",
        email: "reviewer2@a.test",
      });
      await createUser(db(), { organizationId: orgB, email: "elsewhere2@b.test" });

      const { body: created } = await as(author).call("POST", "/api/prayer-requests", {
        title: "Only this parish",
        body: "Nobody in St. George should hear about it.",
      });
      await as(reviewer).call("POST", `/api/prayer-requests/${created.id}/approve`);

      const { rows } = await db().query<{ organization_id: string }>(
        "select distinct organization_id from notifications"
      );
      expect(rows).toEqual([{ organization_id: orgA }]);
    });
  });

  it("reports no VAPID key on /me when push is not configured", async () => {
    // The suite runs with PUSH_MODE=local, so this is the "push is unavailable
    // here" answer the settings page reads.
    const { body } = await as(member).call("GET", "/api/me");
    expect(body.pushPublicKey).toBeNull();
  });
});
