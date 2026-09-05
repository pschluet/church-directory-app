import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/db";

/**
 * The push sender, without a network or a database.
 *
 * `services/push.ts` reads its configuration from `process.env` at import time
 * -- the same as photos.ts and email.ts -- so each case stubs the environment
 * and re-imports the module. That is also what lets the "not configured" and
 * "half configured" branches be exercised at all, and those are the ones a
 * deployment actually hits.
 */

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

/** web-push's own error, which carries the status code the sender branches on. */
class FakeWebPushError extends Error {
  constructor(readonly statusCode: number) {
    super(`push failed with ${statusCode}`);
    this.name = "WebPushError";
  }
}

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
  WebPushError: FakeWebPushError,
}));

const KEYS = {
  PUSH_MODE: "web-push",
  VAPID_PUBLIC_KEY: "public-key",
  VAPID_PRIVATE_KEY: "private-key",
  VAPID_SUBJECT: "mailto:no-reply@example.test",
};

async function loadPush(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(name, "");
    else vi.stubEnv(name, value);
  }
  return import("../src/services/push");
}

/** A query layer that records what it was asked and answers with fixed rows. */
function fakeDb(rows: Record<string, unknown>[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db: Queryable = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: (sql.trimStart().startsWith("select") ? rows : []) as never[] };
    },
    transaction: async (fn) => fn(db),
  };
  return { db, queries };
}

const subscription = (id: string, appUserId: string) => ({
  id,
  app_user_id: appUserId,
  endpoint: `https://push.example.test/${id}`,
  p256dh: "p256dh",
  auth: "auth",
});

const payload = (body: string, tag = "prayer-requests", title = "Prayer Requests") => ({
  title,
  body,
  url: "/prayer-requests",
  tag,
});

describe("push configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off in local mode, so the app runs with no keys", async () => {
    const push = await loadPush({ ...KEYS, PUSH_MODE: "local" });
    expect(push.isPushConfigured()).toBe(false);
    expect(push.pushPublicKey()).toBeNull();
    expect(() => push.assertPushConfig()).not.toThrow();
  });

  it("is off, without complaint, when no keys are set at all", async () => {
    const push = await loadPush({
      PUSH_MODE: "web-push",
      VAPID_PUBLIC_KEY: undefined,
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: undefined,
    });
    expect(push.isPushConfigured()).toBe(false);
    // A parish with no keypair is a supported state: prayer requests still work,
    // they just arrive without a notification.
    expect(() => push.assertPushConfig()).not.toThrow();
  });

  it("fails at start-up on a half-configured keypair", async () => {
    const push = await loadPush({ ...KEYS, VAPID_PRIVATE_KEY: undefined });
    expect(() => push.assertPushConfig()).toThrow(/half-configured/i);
    expect(() => push.assertPushConfig()).toThrow(/VAPID_PRIVATE_KEY/);
  });

  it("hands out the public key when everything is set", async () => {
    const push = await loadPush(KEYS);
    expect(push.isPushConfigured()).toBe(true);
    expect(push.pushPublicKey()).toBe("public-key");
  });
});

describe("sendToUsers", () => {
  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    sendNotification.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends nothing, and asks nothing, when push is not configured", async () => {
    const push = await loadPush({ ...KEYS, PUSH_MODE: "local" });
    const { db, queries } = fakeDb([subscription("s1", "user-1")]);

    const result = await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]));

    expect(result).toEqual({ sent: 0, failed: 0, pruned: 0 });
    expect(queries).toHaveLength(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends one notification per device, with that person's own body", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([
      subscription("s1", "user-1"),
      subscription("s2", "user-1"),
      subscription("s3", "user-2"),
    ]);

    const result = await push.sendToUsers(
      db,
      new Map([
        ["user-1", payload("3 new prayer requests")],
        ["user-2", payload("1 new prayer request")],
      ])
    );

    expect(result.sent).toBe(3);
    // Both of user-1's devices get user-1's count, not a shared one.
    const bodies = sendNotification.mock.calls.map(
      ([, json]) => JSON.parse(json as string).body as string
    );
    expect(bodies.filter((b) => b === "3 new prayer requests")).toHaveLength(2);
    expect(bodies.filter((b) => b === "1 new prayer request")).toHaveLength(1);
  });

  it("passes the endpoint and both keys through in the browser's shape", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1")]);

    await push.sendToUsers(db, new Map([["user-1", payload("1 new prayer request")]]));

    expect(sendNotification).toHaveBeenCalledWith(
      {
        endpoint: "https://push.example.test/s1",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
      JSON.stringify(payload("1 new prayer request"))
    );
  });

  it("carries the page to open, which is what the click handler reads", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1")]);

    await push.sendToUsers(db, new Map([["user-1", payload("1 new prayer request")]]));

    const [, json] = sendNotification.mock.calls[0]!;
    expect(JSON.parse(json as string).url).toBe("/prayer-requests");
  });

  it("carries the tag, so the two kinds do not displace one another", async () => {
    /*
     * A reviewer can have something waiting *and* something newly posted. They
     * are different things to do, so they must not replace each other on the
     * lock screen -- which is what a shared tag would cause.
     */
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1"), subscription("s2", "user-2")]);

    await push.sendToUsers(
      db,
      new Map([
        ["user-1", payload("1 new prayer request", "prayer-requests")],
        ["user-2", payload("1 prayer request waiting for review", "prayer-requests-review")],
      ])
    );

    const tags = sendNotification.mock.calls.map(
      ([, json]) => JSON.parse(json as string).tag as string
    );
    expect(new Set(tags)).toEqual(new Set(["prayer-requests", "prayer-requests-review"]));
  });

  it("deletes a subscription the push service says is gone", async () => {
    const push = await loadPush(KEYS);
    const { db, queries } = fakeDb([subscription("s1", "user-1"), subscription("s2", "user-1")]);
    sendNotification
      .mockRejectedValueOnce(new FakeWebPushError(410))
      .mockResolvedValueOnce(undefined);

    const result = await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]));

    expect(result).toMatchObject({ sent: 1, failed: 0, pruned: 1 });
    const del = queries.find((q) => q.sql.includes("delete from push_subscriptions"));
    expect(del?.params[0]).toEqual(["s1"]);
  });

  it("treats a 404 the same way -- the app was uninstalled", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1")]);
    sendNotification.mockRejectedValueOnce(new FakeWebPushError(404));

    expect(await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]))).toMatchObject({
      sent: 0,
      pruned: 1,
    });
  });

  it("keeps a subscription that failed for some other reason", async () => {
    const push = await loadPush(KEYS);
    const { db, queries } = fakeDb([subscription("s1", "user-1")]);
    sendNotification.mockRejectedValueOnce(new FakeWebPushError(429));

    const result = await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]));

    expect(result).toMatchObject({ sent: 0, failed: 1, pruned: 0 });
    expect(queries.some((q) => q.sql.includes("delete"))).toBe(false);
  });

  it("never throws, so a dead push service cannot fail an approval", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1")]);
    sendNotification.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(
      push.sendToUsers(db, new Map([["user-1", payload("1 new")]]))
    ).resolves.toMatchObject({ failed: 1 });
  });

  it("does not send to a device whose owner is not in the payload map", async () => {
    const push = await loadPush(KEYS);
    // The query is scoped by app_user_id, but a stale row would otherwise be
    // sent an undefined body.
    const { db } = fakeDb([subscription("s1", "user-1"), subscription("s2", "someone-else")]);

    const result = await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]));
    expect(result.sent).toBe(1);
  });

  it("short-circuits when there is nobody to tell", async () => {
    const push = await loadPush(KEYS);
    const { db, queries } = fakeDb([]);
    expect(await push.sendToUsers(db, new Map())).toEqual({ sent: 0, failed: 0, pruned: 0 });
    expect(queries).toHaveLength(0);
  });

  it("configures VAPID once, not once per send", async () => {
    const push = await loadPush(KEYS);
    const { db } = fakeDb([subscription("s1", "user-1")]);

    await push.sendToUsers(db, new Map([["user-1", payload("1 new")]]));
    await push.sendToUsers(db, new Map([["user-1", payload("2 new")]]));

    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(setVapidDetails).toHaveBeenCalledWith(
      "mailto:no-reply@example.test",
      "public-key",
      "private-key"
    );
  });
});
