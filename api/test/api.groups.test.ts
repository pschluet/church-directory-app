import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createNonUserPerson,
  createOrganization,
  createUser,
  type CreatedUser,
} from "./helpers/fixtures";

/**
 * Groups: the visibility matrix is the heart of this suite. A Secret group
 * must be invisible to anyone outside it except a parish admin, a Private
 * group's messages must stay member-only even though its existence is public,
 * and none of that may depend on who happens to be asking in what order.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("groups", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgId: string;
  let creator: CreatedUser;
  let member: CreatedUser;
  let outsider: CreatedUser;
  let parishAdmin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    creator = await createUser(db(), {
      organizationId: orgId,
      firstName: "Cara",
      lastName: "Creator",
    });
    member = await createUser(db(), { organizationId: orgId, firstName: "Mo", lastName: "Member" });
    outsider = await createUser(db(), {
      organizationId: orgId,
      firstName: "Ozzy",
      lastName: "Outsider",
    });
    parishAdmin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      firstName: "Ada",
      lastName: "Admin",
    });
  });
  afterAll(closeDatabase);

  async function createGroup(
    user: CreatedUser,
    visibility: "PUBLIC" | "PRIVATE" | "SECRET" = "PUBLIC"
  ): Promise<string> {
    const res = await as(user).call("POST", "/api/groups", { title: "Youth Group", visibility });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  describe("visibility", () => {
    it("lists a public group for everyone", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const res = await as(outsider).call("GET", "/api/groups");
      expect(res.body.groups.map((g: { id: string }) => g.id)).toContain(groupId);
    });

    it("lists a private group for a non-member, but hides its content", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const list = await as(outsider).call("GET", "/api/groups");
      expect(list.body.groups.map((g: { id: string }) => g.id)).toContain(groupId);

      const detail = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.members).toEqual([]);

      const posts = await as(outsider).call("GET", `/api/groups/${groupId}/posts`);
      expect(posts.status).toBe(403);
    });

    it("never shows an unread count to someone who is not a member", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Hello" });

      const list = await as(outsider).call("GET", "/api/groups");
      const row = list.body.groups.find((g: { id: string }) => g.id === groupId);
      expect(row.unreadCount).toBe(0);

      const detail = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.unreadCount).toBe(0);

      // A member, by contrast, does see it -- and it clears once they visit.
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      const memberList = await as(member).call("GET", "/api/groups");
      expect(memberList.body.groups.find((g: { id: string }) => g.id === groupId).unreadCount).toBe(
        1
      );

      const memberDetail = await as(member).call("GET", `/api/groups/${groupId}`);
      expect(memberDetail.body.unreadCount).toBe(1);

      await as(member).call("POST", `/api/groups/${groupId}/read`);
      const afterRead = await as(member).call("GET", `/api/groups/${groupId}`);
      expect(afterRead.body.unreadCount).toBe(0);
    });

    it("hides a secret group entirely from a non-member", async () => {
      const groupId = await createGroup(creator, "SECRET");
      const list = await as(outsider).call("GET", "/api/groups");
      expect(list.body.groups.map((g: { id: string }) => g.id)).not.toContain(groupId);

      const detail = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(detail.status).toBe(404);
    });

    it("lets a parish admin see a secret group, and marks it as admin viewing", async () => {
      const groupId = await createGroup(creator, "SECRET");
      const detail = await as(parishAdmin).call("GET", `/api/groups/${groupId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.viewingAsAdmin).toBe(true);

      const audit = await as(parishAdmin).call("GET", "/api/audit");
      expect(
        audit.body.entries.some(
          (e: { action: string; entityId: string }) =>
            e.action === "group.adminView" && e.entityId === groupId
        )
      ).toBe(true);
    });

    it("lets a member see a secret group's content without being flagged as admin-viewing", async () => {
      const groupId = await createGroup(creator, "SECRET");
      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.viewingAsAdmin).toBe(false);
      expect(detail.body.members).toHaveLength(1);
    });
  });

  describe("visibility conversion", () => {
    it("allows public to private, public to secret, and secret to private", async () => {
      const g1 = await createGroup(creator, "PUBLIC");
      expect(
        (await as(creator).call("POST", `/api/groups/${g1}/visibility`, { visibility: "PRIVATE" }))
          .status
      ).toBe(200);

      const g2 = await createGroup(creator, "PUBLIC");
      expect(
        (await as(creator).call("POST", `/api/groups/${g2}/visibility`, { visibility: "SECRET" }))
          .status
      ).toBe(200);

      const g3 = await createGroup(creator, "SECRET");
      expect(
        (await as(creator).call("POST", `/api/groups/${g3}/visibility`, { visibility: "PRIVATE" }))
          .status
      ).toBe(200);
    });

    it("never allows converting back to public", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const res = await as(creator).call("POST", `/api/groups/${groupId}/visibility`, {
        visibility: "PUBLIC",
      });
      expect(res.status).toBe(409);
    });

    it("rejects private to secret going back to private as a no-op the matrix still allows, but blocks private to public", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const toSecret = await as(creator).call("POST", `/api/groups/${groupId}/visibility`, {
        visibility: "SECRET",
      });
      expect(toSecret.status).toBe(200);
    });

    it("requires group admin to convert", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      const res = await as(member).call("POST", `/api/groups/${groupId}/visibility`, {
        visibility: "PRIVATE",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("membership", () => {
    it("adds the creator as the first admin", async () => {
      const groupId = await createGroup(creator);
      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.myRole).toBe("ADMIN");
    });

    it("lets anyone join a public group", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const res = await as(member).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      expect(res.status).toBe(204);
      const detail = await as(member).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.myRole).toBe("MEMBER");
    });

    it("refuses to add a person with no account", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const childId = await createNonUserPerson(db(), { organizationId: orgId, familyId: null });
      const res = await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: childId,
      });
      expect(res.status).toBe(400);
    });

    it("blocks the sole admin from leaving", async () => {
      const groupId = await createGroup(creator);
      const res = await as(creator).call("POST", `/api/groups/${groupId}/leave`);
      expect(res.status).toBe(409);
    });

    it("allows leaving once another admin exists", async () => {
      const groupId = await createGroup(creator);
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      await as(creator).call("POST", `/api/groups/${groupId}/members/${member.personId}/role`, {
        role: "ADMIN",
      });
      const res = await as(creator).call("POST", `/api/groups/${groupId}/leave`);
      expect(res.status).toBe(204);
    });

    it("refuses to demote the only admin", async () => {
      const groupId = await createGroup(creator);
      const res = await as(creator).call(
        "POST",
        `/api/groups/${groupId}/members/${creator.personId}/role`,
        {
          role: "MEMBER",
        }
      );
      expect(res.status).toBe(409);
    });

    it("requires a request-to-join for a private group, then approval", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const ask = await as(outsider).call("POST", `/api/groups/${groupId}/join-requests`);
      expect(ask.status).toBe(201);

      const dupe = await as(outsider).call("POST", `/api/groups/${groupId}/join-requests`);
      expect(dupe.status).toBe(409);

      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.pendingJoinRequests).toHaveLength(1);
      const requestId = detail.body.pendingJoinRequests[0].id;

      const approve = await as(creator).call(
        "POST",
        `/api/groups/${groupId}/join-requests/${requestId}/approve`
      );
      expect(approve.status).toBe(200);

      const now = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(now.body.myRole).toBe("MEMBER");
    });
  });

  describe("photo", () => {
    it("returns the stored dimensions once a photo is attached", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const attach = await as(creator).call("PUT", `/api/groups/${groupId}/photo`, {
        photoKey: `photos/${orgId}/group/${groupId}/01TESTULID0000000000000000/`,
        photoWidth: 640,
        photoHeight: 480,
      });
      expect(attach.status).toBe(200);

      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.photoWidth).toBe(640);
      expect(detail.body.photoHeight).toBe(480);
      expect(detail.body.thumbUrl).not.toBeNull();
    });

    it("returns a card URL when the upload includes a card crop, matching the groups-page card box", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const photoKey = `photos/${orgId}/group/${groupId}/01TESTULID0000000000000001/`;
      const attach = await as(creator).call("PUT", `/api/groups/${groupId}/photo`, {
        photoKey,
        photoWidth: 640,
        photoHeight: 480,
        hasCard: true,
      });
      expect(attach.status).toBe(200);
      expect(attach.body.cardUrl).toBe(`/${photoKey}card`);

      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.cardUrl).toBe(`/${photoKey}card`);

      const list = await as(creator).call("GET", "/api/groups");
      expect(list.body.groups.find((g: { id: string }) => g.id === groupId).cardUrl).toBe(
        `/${photoKey}card`
      );
    });

    it("has no card URL when the upload has no card crop", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const attach = await as(creator).call("PUT", `/api/groups/${groupId}/photo`, {
        photoKey: `photos/${orgId}/group/${groupId}/01TESTULID0000000000000002/`,
        photoWidth: 640,
        photoHeight: 480,
      });
      expect(attach.body.cardUrl).toBeNull();
    });

    it("clears the photo, its dimensions and its card flag together", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("PUT", `/api/groups/${groupId}/photo`, {
        photoKey: `photos/${orgId}/group/${groupId}/01TESTULID0000000000000003/`,
        photoWidth: 640,
        photoHeight: 480,
        hasCard: true,
      });

      const cleared = await as(creator).call("PUT", `/api/groups/${groupId}/photo`, {
        photoKey: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.thumbUrl).toBeNull();
      expect(cleared.body.cardUrl).toBeNull();

      const detail = await as(creator).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.thumbUrl).toBeNull();
      expect(detail.body.photoWidth).toBeNull();
      expect(detail.body.cardUrl).toBeNull();
    });
  });

  describe("pin", () => {
    it("pins and unpins a group, sorting pinned groups first", async () => {
      const g1 = await createGroup(creator, "PUBLIC");
      const g2 = await createGroup(creator, "PUBLIC");

      const before = await as(creator).call("GET", "/api/groups");
      expect(before.body.groups.map((g: { id: string; pinned: boolean }) => g.pinned)).toEqual([
        false,
        false,
      ]);

      const pin = await as(creator).call("POST", `/api/groups/${g2}/pin`);
      expect(pin.status).toBe(204);

      const after = await as(creator).call("GET", "/api/groups");
      expect(after.body.groups[0].id).toBe(g2);
      expect(after.body.groups[0].pinned).toBe(true);
      expect(after.body.groups.find((g: { id: string }) => g.id === g1).pinned).toBe(false);

      const detail = await as(creator).call("GET", `/api/groups/${g2}`);
      expect(detail.body.pinned).toBe(true);

      const unpin = await as(creator).call("DELETE", `/api/groups/${g2}/pin`);
      expect(unpin.status).toBe(204);

      const afterUnpin = await as(creator).call("GET", `/api/groups/${g2}`);
      expect(afterUnpin.body.pinned).toBe(false);
    });

    it("is personal -- one account pinning a group does not pin it for another", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/pin`);

      const otherView = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(otherView.body.pinned).toBe(false);
    });

    it("lets anyone who can see a group pin it, not just members", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const pin = await as(outsider).call("POST", `/api/groups/${groupId}/pin`);
      expect(pin.status).toBe(204);
      const detail = await as(outsider).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.pinned).toBe(true);
    });

    it("refuses to pin a secret group the caller cannot see", async () => {
      const groupId = await createGroup(creator, "SECRET");
      const pin = await as(outsider).call("POST", `/api/groups/${groupId}/pin`);
      expect(pin.status).toBe(404);
    });

    it("pinning twice is a no-op, not an error", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/pin`);
      const again = await as(creator).call("POST", `/api/groups/${groupId}/pin`);
      expect(again.status).toBe(204);
    });
  });

  describe("posts", () => {
    async function withMember(groupId: string): Promise<void> {
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
    }

    it("lets a member post and read it back", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await withMember(groupId);
      const post = await as(member).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hello group",
      });
      expect(post.status).toBe(201);
      expect(post.body.body).toBe("Hello group");
      expect(post.body.canEdit).toBe(true);
    });

    it("enforces one level of threading", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await withMember(groupId);
      const root = await as(member).call("POST", `/api/groups/${groupId}/posts`, { body: "Root" });
      const reply = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Reply",
        parentPostId: root.body.id,
      });
      expect(reply.status).toBe(201);

      const nested = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Nested",
        parentPostId: reply.body.id,
      });
      expect(nested.status).toBe(400);
    });

    it("soft-deletes a post, leaving a tombstone", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Delete me",
      });
      const del = await as(creator).call("DELETE", `/api/groups/${groupId}/posts/${post.body.id}`);
      expect(del.status).toBe(204);

      const feed = await as(creator).call("GET", `/api/groups/${groupId}/posts`);
      const found = feed.body.posts.find((p: { id: string }) => p.id === post.body.id);
      expect(found.body).toBeNull();
      expect(found.deletedAt).not.toBeNull();
    });

    it("purges a post's attachments, not just its visible content, on delete", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Here's the file",
        attachments: [
          {
            photoKey: `photos/${orgId}/group-post/${creator.personId}/01TESTULID0000000000000001/`,
            kind: "FILE",
            filename: "handout.txt",
            contentType: "text/plain",
            byteSize: 42,
          },
        ],
      });
      expect(post.body.attachments).toHaveLength(1);

      await as(creator).call("DELETE", `/api/groups/${groupId}/posts/${post.body.id}`);

      const { rows } = await db().query(
        "select id from group_post_attachments where post_id = $1",
        [post.body.id]
      );
      expect(rows).toHaveLength(0);
    });

    it("keeps an existing reply thread reachable after the root is deleted, but refuses a new reply", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const root = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Root",
      });
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Existing reply",
        parentPostId: root.body.id,
      });

      await as(creator).call("DELETE", `/api/groups/${groupId}/posts/${root.body.id}`);

      const replies = await as(creator).call(
        "GET",
        `/api/groups/${groupId}/posts/${root.body.id}/replies`
      );
      expect(replies.status).toBe(200);
      expect(replies.body.replies).toHaveLength(1);
      expect(replies.body.replies[0].body).toBe("Existing reply");

      const newReply = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Too late",
        parentPostId: root.body.id,
      });
      expect(newReply.status).toBe(409);
    });

    it("lets a group admin delete someone else's post and records it in the audit log", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await withMember(groupId);
      const post = await as(member).call("POST", `/api/groups/${groupId}/posts`, { body: "Oops" });
      const del = await as(creator).call("DELETE", `/api/groups/${groupId}/posts/${post.body.id}`);
      expect(del.status).toBe(204);

      const audit = await as(parishAdmin).call("GET", "/api/audit");
      expect(
        audit.body.entries.some(
          (e: { action: string; entityId: string }) =>
            e.action === "group.post.adminDelete" && e.entityId === post.body.id
        )
      ).toBe(true);
    });

    it("rejects mentioning someone who is not a member", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const res = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hey @outsider",
        mentionedAppUserIds: [outsider.appUserId],
      });
      expect(res.status).toBe(400);
    });

    it("creates an event post with RSVP support", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await withMember(groupId);
      const event = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      expect(event.status).toBe(201);
      expect(event.body.event.title).toBe("Potluck");

      const rsvp = await as(member).call(
        "PUT",
        `/api/groups/${groupId}/posts/${event.body.id}/rsvp`,
        {
          response: "YES",
          guestCount: 2,
        }
      );
      expect(rsvp.status).toBe(200);
      expect(rsvp.body.event.rsvpCounts.yes).toBe(1);
      expect(rsvp.body.event.myRsvp).toEqual({ response: "YES", guestCount: 2 });
    });
  });

  describe("rsvp roster", () => {
    async function withMember(groupId: string): Promise<void> {
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
    }

    it("lists every RSVP with the responder's name and guest count", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await withMember(groupId);
      const event = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      const postId = event.body.id as string;

      await as(creator).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
        response: "YES",
        guestCount: 3,
      });
      await as(member).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
        response: "MAYBE",
        guestCount: 0,
      });

      const roster = await as(member).call("GET", `/api/groups/${groupId}/posts/${postId}/rsvps`);
      expect(roster.status).toBe(200);
      expect(roster.body.rsvps).toHaveLength(2);
      expect(roster.body.rsvps).toEqual(
        expect.arrayContaining([
          {
            appUserId: creator.appUserId,
            personId: creator.personId,
            name: "Cara Creator",
            thumbUrl: null,
            response: "YES",
            guestCount: 3,
          },
          {
            appUserId: member.appUserId,
            personId: member.personId,
            name: "Mo Member",
            thumbUrl: null,
            response: "MAYBE",
            guestCount: 0,
          },
        ])
      );
    });

    it("refuses a non-member of a private group", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      const event = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      const res = await as(outsider).call(
        "GET",
        `/api/groups/${groupId}/posts/${event.body.id}/rsvps`
      );
      expect(res.status).toBe(403);
    });

    it("404s for a post that is not an event", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Not an event",
      });
      const res = await as(creator).call(
        "GET",
        `/api/groups/${groupId}/posts/${post.body.id}/rsvps`
      );
      expect(res.status).toBe(404);
    });
  });

  describe("reporting", () => {
    it("lets a member report a post, blocks a duplicate, and resolving by deletion removes the post but keeps the report", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Questionable",
      });

      const report = await as(member).call(
        "POST",
        `/api/groups/${groupId}/posts/${post.body.id}/report`,
        {
          reason: "Not appropriate",
        }
      );
      expect(report.status).toBe(204);

      const again = await as(member).call(
        "POST",
        `/api/groups/${groupId}/posts/${post.body.id}/report`,
        {}
      );
      expect(again.status).toBe(409);

      const queue = await as(creator).call("GET", `/api/groups/${groupId}/reports`);
      expect(queue.body.reports).toHaveLength(1);
      const reportId = queue.body.reports[0].id;

      const resolve = await as(creator).call(
        "POST",
        `/api/groups/${groupId}/reports/${reportId}/delete`
      );
      expect(resolve.status).toBe(204);

      const feed = await as(creator).call("GET", `/api/groups/${groupId}/posts`);
      const found = feed.body.posts.find((p: { id: string }) => p.id === post.body.id);
      expect(found.deletedAt).not.toBeNull();

      const stillQueued = await as(creator).call("GET", `/api/groups/${groupId}/reports`);
      expect(stillQueued.body.reports).toHaveLength(0);
    });

    it("refuses to let someone report their own post", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Mine" });
      const res = await as(creator).call(
        "POST",
        `/api/groups/${groupId}/posts/${post.body.id}/report`,
        {}
      );
      expect(res.status).toBe(400);
    });

    it("notifies parish admins of a report even without group membership", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Flag me",
      });
      await as(member).call("POST", `/api/groups/${groupId}/posts/${post.body.id}/report`, {});

      const inbox = await as(parishAdmin).call("GET", "/api/notifications");
      expect(
        inbox.body.notifications.some((n: { type: string }) => n.type === "GROUP_POST_REPORT")
      ).toBe(true);
    });
  });

  describe("notification defaults and exceptions", () => {
    async function joined(): Promise<string> {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      return groupId;
    }
    const notificationsFor = async (u: CreatedUser, type: string) =>
      (await as(u).call("GET", "/api/notifications")).body.notifications.filter(
        (n: { type: string }) => n.type === type
      ).length;

    it("starts a new membership as 'follow my default'", async () => {
      const groupId = await joined();
      const detail = await as(member).call("GET", `/api/groups/${groupId}`);
      expect(detail.body.notificationPref).toBeNull();
      expect(detail.body.notificationPrefDefault).toBe("ALL");
    });

    it("notifies a member with no exception and no preferences row (the sparse default)", async () => {
      const groupId = await joined();
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Hi" });
      expect(await notificationsFor(member, "GROUP_POST")).toBe(1);
    });

    it("follows an account default of MENTIONS: no post notification, but a mention gets through", async () => {
      const groupId = await joined();
      await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "MENTIONS",
      });
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Plain" });
      expect(await notificationsFor(member, "GROUP_POST")).toBe(0);

      await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hi @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(await notificationsFor(member, "GROUP_MENTION")).toBe(1);
    });

    it("follows an account default of NONE, even for mentions", async () => {
      const groupId = await joined();
      await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "NONE",
      });
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hi @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(await notificationsFor(member, "GROUP_POST")).toBe(0);
      expect(await notificationsFor(member, "GROUP_MENTION")).toBe(0);
    });

    it("lets an ALL exception override a NONE default, and a NONE exception override ALL", async () => {
      const groupId = await joined();
      await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "NONE",
      });
      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: "ALL",
      });
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "One" });
      expect(await notificationsFor(member, "GROUP_POST")).toBe(1);

      await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "ALL",
      });
      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: "NONE",
      });
      await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Two @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(await notificationsFor(member, "GROUP_POST")).toBe(1);
      expect(await notificationsFor(member, "GROUP_MENTION")).toBe(0);
    });

    it("does not tell a NONE-default RSVPer that an event changed", async () => {
      const groupId = await joined();
      const event = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      await as(member).call("PUT", `/api/groups/${groupId}/posts/${event.body.id}/rsvp`, {
        response: "YES",
        guestCount: 0,
      });
      await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "NONE",
      });
      await as(creator).call("PATCH", `/api/groups/${groupId}/posts/${event.body.id}`, {
        event: { eventTitle: "Potluck", eventDate: "2030-01-02" },
      });
      expect(await notificationsFor(member, "GROUP_EVENT")).toBe(0);
    });

    it("lists exceptions with the preferences, and clears one with null or DELETE", async () => {
      const groupId = await joined();
      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: "MENTIONS",
      });
      const prefs = await as(member).call("GET", "/api/notifications/preferences");
      expect(prefs.body.groupNotificationPref).toBe("ALL");
      expect(prefs.body.groupExceptions).toEqual([
        { groupId, groupTitle: "Youth Group", organizationId: orgId, notificationPref: "MENTIONS" },
      ]);

      const changed = await as(member).call(
        "PUT",
        `/api/notifications/group-preferences/${groupId}`,
        {
          notificationPref: "NONE",
        }
      );
      expect(changed.body.groupExceptions[0].notificationPref).toBe("NONE");

      const cleared = await as(member).call(
        "DELETE",
        `/api/notifications/group-preferences/${groupId}`
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.groupExceptions).toEqual([]);

      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: "NONE",
      });
      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: null,
      });
      const after = await as(member).call("GET", "/api/notifications/preferences");
      expect(after.body.groupExceptions).toEqual([]);
    });

    it("refuses an exception for a group the caller is not in", async () => {
      const groupId = await createGroup(creator, "PUBLIC");
      const put = await as(outsider).call(
        "PUT",
        `/api/notifications/group-preferences/${groupId}`,
        {
          notificationPref: "NONE",
        }
      );
      expect(put.status).toBe(403);
      const del = await as(outsider).call(
        "DELETE",
        `/api/notifications/group-preferences/${groupId}`
      );
      expect(del.status).toBe(403);
    });

    it("changing the default leaves the prayer switches alone and keeps exceptions out of the audit log", async () => {
      const groupId = await joined();
      await as(member).call("PUT", `/api/groups/${groupId}/notification-preference`, {
        notificationPref: "NONE",
      });
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      const res = await as(member).call("PUT", "/api/notifications/preferences", {
        groupNotificationPref: "MENTIONS",
      });
      expect(res.body.prayerRequests).toBe(false);
      expect(res.body.groupNotificationPref).toBe("MENTIONS");

      const { rows } = await db().query<{ changes: Record<string, unknown> }>(
        "select changes from audit_log where action = 'user.changeNotifications'"
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.changes).not.toHaveProperty("groupExceptions");
    });
  });

  describe("people ids and editing mentions", () => {
    async function joined(): Promise<string> {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      return groupId;
    }
    const mentionNotifications = async (u: CreatedUser, type: string) =>
      (await as(u).call("GET", "/api/notifications")).body.notifications.filter(
        (n: { type: string }) => n.type === type
      ).length;

    it("carries the person id on mentions and the files author", async () => {
      const groupId = await joined();
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hi @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(post.body.mentions).toEqual([
        { appUserId: member.appUserId, personId: member.personId, name: "Mo Member" },
      ]);
    });

    it("notifies only newly added mentions, and removes dropped ones", async () => {
      const groupId = await joined();
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hi",
      });
      const url = `/api/groups/${groupId}/posts/${post.body.id}`;

      const add = await as(creator).call("PATCH", url, {
        body: "Hi @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(add.status).toBe(200);
      expect(add.body.mentions).toHaveLength(1);
      expect(await mentionNotifications(member, "GROUP_MENTION")).toBe(1);
      // The unread "new post" was retracted in favour of the mention.
      expect(await mentionNotifications(member, "GROUP_POST")).toBe(0);

      // Same mention again: nothing new.
      await as(creator).call("PATCH", url, {
        body: "Hi again @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      expect(await mentionNotifications(member, "GROUP_MENTION")).toBe(1);

      const clear = await as(creator).call("PATCH", url, { body: "Hi", mentionedAppUserIds: [] });
      expect(clear.body.mentions).toEqual([]);
    });

    it("leaves mentions alone when the field is omitted", async () => {
      const groupId = await joined();
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Hi @Mo Member",
        mentionedAppUserIds: [member.appUserId],
      });
      const res = await as(creator).call("PATCH", `/api/groups/${groupId}/posts/${post.body.id}`, {
        body: "Hi @Mo Member!",
      });
      expect(res.body.mentions).toHaveLength(1);
    });

    it("rejects mentioning a non-member in an edit", async () => {
      const groupId = await joined();
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Hi" });
      const res = await as(creator).call("PATCH", `/api/groups/${groupId}/posts/${post.body.id}`, {
        body: "Hi",
        mentionedAppUserIds: [outsider.appUserId],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("live updates", () => {
    async function joined(): Promise<string> {
      const groupId = await createGroup(creator, "PUBLIC");
      await as(creator).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      return groupId;
    }
    const live = async (u: CreatedUser, groupId: string) =>
      (await as(u).call("GET", `/api/groups/${groupId}/live`)).body as {
        activityAt: string;
        typing: string[];
      };

    it("gives a member the stamp and an empty typing list", async () => {
      const groupId = await joined();
      const res = await as(member).call("GET", `/api/groups/${groupId}/live`);
      expect(res.status).toBe(200);
      expect(res.body.typing).toEqual([]);
      expect(Number.isNaN(Date.parse(res.body.activityAt))).toBe(false);
    });

    it("keeps a private group's pulse from non-members, and hides a secret one entirely", async () => {
      const priv = await createGroup(creator, "PRIVATE");
      expect((await as(outsider).call("GET", `/api/groups/${priv}/live`)).status).toBe(403);
      const secret = await createGroup(creator, "SECRET");
      expect((await as(outsider).call("GET", `/api/groups/${secret}/live`)).status).toBe(404);
    });

    it("lets a parish admin watch without logging each poll as a visit", async () => {
      const groupId = await createGroup(creator, "SECRET");
      await as(parishAdmin).call("GET", `/api/groups/${groupId}`);
      const { rows: before } = await db().query<{ n: string }>(
        "select count(*)::text as n from audit_log where action = 'group.adminView'"
      );
      for (let i = 0; i < 3; i++) {
        expect((await as(parishAdmin).call("GET", `/api/groups/${groupId}/live`)).status).toBe(200);
      }
      const { rows: after } = await db().query<{ n: string }>(
        "select count(*)::text as n from audit_log where action = 'group.adminView'"
      );
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it("moves the stamp for a post, a reply, an edit, a delete and an RSVP, and not for a read", async () => {
      const groupId = await joined();
      let last = (await live(member, groupId)).activityAt;
      const changed = async (): Promise<boolean> => {
        const now = (await live(member, groupId)).activityAt;
        const moved = now !== last;
        last = now;
        return moved;
      };

      expect(await changed()).toBe(false);
      const post = await as(creator).call("POST", `/api/groups/${groupId}/posts`, { body: "Hi" });
      expect(await changed()).toBe(true);
      expect(await changed()).toBe(false);

      await as(member).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Reply",
        parentPostId: post.body.id,
      });
      expect(await changed()).toBe(true);

      await as(creator).call("PATCH", `/api/groups/${groupId}/posts/${post.body.id}`, {
        body: "Hi!",
      });
      expect(await changed()).toBe(true);

      const event = await as(creator).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Potluck", eventDate: "2030-01-01" },
      });
      await changed();
      await as(member).call("PUT", `/api/groups/${groupId}/posts/${event.body.id}/rsvp`, {
        response: "YES",
        guestCount: 0,
      });
      expect(await changed()).toBe(true);

      await as(creator).call("DELETE", `/api/groups/${groupId}/posts/${post.body.id}`);
      expect(await changed()).toBe(true);
    });

    it("shows who else is typing, never the caller, and not for long", async () => {
      const groupId = await joined();
      expect((await as(member).call("POST", `/api/groups/${groupId}/typing`)).status).toBe(204);

      expect((await live(creator, groupId)).typing).toEqual(["Mo Member"]);
      expect((await live(member, groupId)).typing).toEqual([]);

      await db().query(
        "update group_typing set typed_at = now() - interval '10 seconds' where group_id = $1",
        [groupId]
      );
      expect((await live(creator, groupId)).typing).toEqual([]);
    });

    it("clears somebody's typing when their message lands", async () => {
      const groupId = await joined();
      await as(member).call("POST", `/api/groups/${groupId}/typing`);
      expect((await live(creator, groupId)).typing).toEqual(["Mo Member"]);
      await as(member).call("POST", `/api/groups/${groupId}/posts`, { body: "Done" });
      expect((await live(creator, groupId)).typing).toEqual([]);
    });

    it("sweeps stale typing markers when the next one arrives, and keeps one row each", async () => {
      const groupId = await joined();
      await as(member).call("POST", `/api/groups/${groupId}/typing`);
      await db().query(
        "update group_typing set typed_at = now() - interval '5 minutes' where group_id = $1",
        [groupId]
      );
      await as(creator).call("POST", `/api/groups/${groupId}/typing`);
      await as(creator).call("POST", `/api/groups/${groupId}/typing`);
      const { rows } = await db().query<{ app_user_id: string }>(
        "select app_user_id from group_typing where group_id = $1",
        [groupId]
      );
      expect(rows.map((r) => r.app_user_id)).toEqual([creator.appUserId]);
    });

    it("refuses typing from someone who is not in the group, or who cannot post or reply", async () => {
      const groupId = await createGroup(creator, "PRIVATE");
      expect((await as(outsider).call("POST", `/api/groups/${groupId}/typing`)).status).toBe(403);
    });

    it("lists several typists oldest first", async () => {
      const groupId = await joined();
      await as(outsider).call("POST", `/api/groups/${groupId}/members`, {
        personId: outsider.personId,
      });
      await as(member).call("POST", `/api/groups/${groupId}/typing`);
      await db().query(
        "update group_typing set typed_at = now() - interval '2 seconds' where group_id = $1",
        [groupId]
      );
      await as(outsider).call("POST", `/api/groups/${groupId}/typing`);
      expect((await live(creator, groupId)).typing).toEqual(["Mo Member", "Ozzy Outsider"]);
    });
  });
});
