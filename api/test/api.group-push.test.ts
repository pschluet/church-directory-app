import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PushPayload } from "../src/services/push";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

/**
 * What a group push says and where tapping it goes.
 *
 * The tap must land where the bell entry for the same notification does -- on
 * the message, lit -- and carry `from=push` so the page marks it read. The text
 * counts this group's unread messages and, separately, everything unread
 * across groups, never one passed off as the other.
 */

const sent: Map<string, PushPayload>[] = [];

vi.mock("../src/services/push", async () => {
  const actual =
    await vi.importActual<typeof import("../src/services/push")>("../src/services/push");
  return {
    ...actual,
    sendToUsers: async (_q: unknown, payloads: Map<string, PushPayload>) => {
      sent.push(payloads);
      return { sent: 0, failed: 0, pruned: 0 };
    },
  };
});

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("group push notifications", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgId: string;
  let creator: CreatedUser;
  let member: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    sent.length = 0;
    orgId = await createOrganization(db());
    creator = await createUser(db(), { organizationId: orgId, firstName: "Cara" });
    member = await createUser(db(), { organizationId: orgId, firstName: "Mo" });
  });
  afterAll(closeDatabase);

  async function createGroup(title: string): Promise<string> {
    const res = await as(creator).call("POST", "/api/groups", { title, visibility: "PUBLIC" });
    expect(res.status).toBe(201);
    const groupId = res.body.id as string;
    await as(creator).call("POST", `/api/groups/${groupId}/members`, {
      personId: member.personId,
    });
    return groupId;
  }

  async function post(groupId: string, body: Record<string, unknown>): Promise<string> {
    const res = await as(creator).call("POST", `/api/groups/${groupId}/posts`, body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  const lastFor = (u: CreatedUser) => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const payload = sent[i]!.get(u.appUserId);
      if (payload) return payload;
    }
    return undefined;
  };

  describe("where a tap lands", () => {
    it("opens a top-level message in the feed", async () => {
      const groupId = await createGroup("Choir");
      const postId = await post(groupId, { body: "Hello" });
      expect(lastFor(member)?.url).toBe(`/groups/${groupId}?message=${postId}&from=push`);
    });

    it("opens a reply in its thread", async () => {
      const groupId = await createGroup("Choir");
      const parentId = await post(groupId, { body: "Hello" });
      const replyId = await post(groupId, { body: "Again", parentPostId: parentId });
      expect(lastFor(member)?.url).toBe(
        `/groups/${groupId}/threads/${parentId}?message=${replyId}&from=push`
      );
    });

    it("opens a reply to an event on the event's page", async () => {
      const groupId = await createGroup("Choir");
      const eventId = await post(groupId, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      const replyId = await post(groupId, { body: "Count me in", parentPostId: eventId });
      expect(lastFor(member)?.url).toBe(
        `/groups/${groupId}/events/${eventId}?message=${replyId}&from=push`
      );
    });

    it("opens a mention on the message, and counts it", async () => {
      const groupId = await createGroup("Choir");
      const postId = await post(groupId, {
        body: "Hi @Mo",
        mentionedAppUserIds: [member.appUserId],
      });
      const payload = lastFor(member);
      expect(payload?.url).toBe(`/groups/${groupId}?message=${postId}&from=push`);
      expect(payload?.body).toBe("1 new message in Choir");
    });

    it("shares one tag across groups, so the newest message replaces the last", async () => {
      const a = await createGroup("Choir");
      const b = await createGroup("Youth");
      await post(a, { body: "One" });
      const tagA = lastFor(member)?.tag;
      await post(b, { body: "Two" });
      expect(lastFor(member)?.tag).toBe(tagA);
      expect(tagA).toBe("group-messages");
    });
  });

  describe("what it says", () => {
    it("counts this group alone when nothing else is unread", async () => {
      const groupId = await createGroup("Choir");
      await post(groupId, { body: "One" });
      await post(groupId, { body: "Two" });
      expect(lastFor(member)?.body).toBe("2 new messages in Choir");
    });

    it("counts this group, and the total across groups separately", async () => {
      const a = await createGroup("Choir");
      const b = await createGroup("Youth");
      await post(a, { body: "One" });
      await post(a, { body: "Two" });
      await post(b, { body: "Three" });
      expect(lastFor(member)?.body).toBe("1 new message in Youth · 3 unread total");

      await post(a, { body: "Four" });
      expect(lastFor(member)?.body).toBe("3 new messages in Choir · 4 unread total");
    });

    it("stops counting what has been read", async () => {
      const a = await createGroup("Choir");
      const b = await createGroup("Youth");
      const first = await post(a, { body: "One" });
      await as(member).call("POST", "/api/notifications/seen", { groupPostIds: [first] });
      await post(b, { body: "Two" });
      expect(lastFor(member)?.body).toBe("1 new message in Youth");
    });
  });

  describe("marking read once a message has been seen", () => {
    it("clears only the caller's notifications for the posts seen", async () => {
      const groupId = await createGroup("Choir");
      const third = await createUser(db(), { organizationId: orgId, firstName: "Tess" });
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: third.personId,
      });
      const one = await post(groupId, { body: "One" });
      await post(groupId, { body: "Two" });

      const res = await as(member).call("POST", "/api/notifications/seen", {
        groupPostIds: [one],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: 1 });

      expect((await as(member).call("GET", "/api/notifications")).body.unreadCount).toBe(1);
      expect((await as(third).call("GET", "/api/notifications")).body.unreadCount).toBe(2);

      // Again, or for a post they were never told about: nothing to clear.
      const again = await as(member).call("POST", "/api/notifications/seen", {
        groupPostIds: [one, "00000000-0000-0000-0000-000000000000"],
      });
      expect(again.body).toEqual({ cleared: 0 });
    });

    it("clears several posts at once", async () => {
      const groupId = await createGroup("Choir");
      const one = await post(groupId, { body: "One" });
      const two = await post(groupId, { body: "Two" });
      await post(groupId, { body: "Three" });

      const res = await as(member).call("POST", "/api/notifications/seen", {
        groupPostIds: [one, two],
      });
      expect(res.body).toEqual({ cleared: 2 });
      expect((await as(member).call("GET", "/api/notifications")).body.unreadCount).toBe(1);
    });

    it("does not clear a group's join request by seeing one of its posts", async () => {
      const groupId = await createGroup("Choir");
      const one = await post(groupId, { body: "One" });
      await db().query(
        `insert into notifications (app_user_id, organization_id, type, group_id)
         select app_user_id, organization_id, 'GROUP_JOIN_REQUEST', group_id
           from notifications where group_post_id = $1 and app_user_id = $2`,
        [one, member.appUserId]
      );

      await as(member).call("POST", "/api/notifications/seen", { groupPostIds: [one] });
      const inbox = (await as(member).call("GET", "/api/notifications")).body;
      expect(inbox.unreadCount).toBe(1);
      expect(inbox.notifications.find((n: { read: boolean }) => !n.read).type).toBe(
        "GROUP_JOIN_REQUEST"
      );

      const banner = await as(member).call("POST", "/api/notifications/seen", {
        joinRequestGroupIds: [groupId],
      });
      expect(banner.body).toEqual({ cleared: 1 });
    });

    it("rejects a malformed id, or naming nothing", async () => {
      for (const body of [{ groupPostIds: ["nope"] }, {}, { groupPostIds: [] }]) {
        const res = await as(member).call("POST", "/api/notifications/seen", body);
        expect(res.status).toBe(400);
      }
    });
  });
});
