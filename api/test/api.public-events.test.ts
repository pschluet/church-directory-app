import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";
import { PUBLIC_RSVP_MAX_PER_EVENT } from "../src/types";

/**
 * Event share pages: the anonymous /api/public routes, the signed-in token
 * resolver, and the authenticated side of public RSVPs on the groups routes.
 *
 * The rule this file exists to hold: with "Allow Public RSVP" off, nothing
 * about an event reaches an anonymous caller, and a real token cannot be told
 * apart from a made-up one.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("event share pages", () => {
  const db = () => testDb();
  const anonymous = () => client(db(), null);
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgId: string;
  let otherOrgId: string;
  let organizer: CreatedUser;
  let member: CreatedUser;
  let outsider: CreatedUser;
  let parishAdmin: CreatedUser;
  let foreigner: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");
    organizer = await createUser(db(), {
      organizationId: orgId,
      firstName: "Cara",
      lastName: "Org",
    });
    member = await createUser(db(), { organizationId: orgId, firstName: "Mo", lastName: "Member" });
    outsider = await createUser(db(), { organizationId: orgId, firstName: "Oz", lastName: "Out" });
    parishAdmin = await createUser(db(), { organizationId: orgId, role: "ADMIN" });
    foreigner = await createUser(db(), { organizationId: otherOrgId });
  });
  afterAll(closeDatabase);

  async function createGroup(visibility: "PUBLIC" | "PRIVATE" | "SECRET" = "PUBLIC") {
    const res = await as(organizer).call("POST", "/api/groups", {
      title: "Youth Group",
      visibility,
    });
    expect(res.status).toBe(201);
    const groupId = res.body.id as string;
    await as(organizer).call("POST", `/api/groups/${groupId}/members`, {
      personId: member.personId,
    });
    return groupId;
  }

  async function createEvent(
    groupId: string,
    event: Record<string, unknown> = {}
  ): Promise<{ postId: string; token: string }> {
    const res = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, {
      kind: "EVENT",
      event: {
        eventTitle: "Parish Picnic",
        eventDescription: "Bring a dish",
        eventDate: "2030-06-01",
        startTime: "12:00",
        endTime: "15:00",
        location: "The hall",
        publicRsvpEnabled: true,
        ...event,
      },
    });
    expect(res.status).toBe(201);
    return { postId: res.body.id, token: res.body.event.shareToken };
  }

  const rsvp = (overrides: Record<string, unknown> = {}) => ({
    firstName: "Sam",
    lastName: "Stranger",
    email: "Sam@Example.com",
    guestCount: 2,
    ...overrides,
  });

  async function publicRsvpRows() {
    const { rows } = await db().query<{ email: string; guest_count: number; first_name: string }>(
      "select email::text as email, guest_count, first_name from group_event_public_rsvps"
    );
    return rows;
  }

  describe("GET /api/public/events/:token", () => {
    it("shows an event without signing in when public RSVP is on", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId);
      const res = await anonymous().call("GET", `/api/public/events/${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        title: "Parish Picnic",
        description: "Bring a dish",
        eventDate: "2030-06-01",
        startTime: "12:00",
        endTime: "15:00",
        location: "The hall",
        cancelled: false,
        publicRsvpEnabled: true,
        organizationName: "All Saints",
        groupName: "Youth Group",
        rsvpCounts: { yes: 0, no: 0, maybe: 0, attending: 0 },
      });
    });

    it("404s with public RSVP off, exactly as for a made-up token", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId, { publicRsvpEnabled: false });
      const off = await anonymous().call("GET", `/api/public/events/${token}`);
      const bogus = await anonymous().call("GET", "/api/public/events/01HZZZZZZZZZZZZZZZZZZZZZZZ");
      expect(off.status).toBe(404);
      expect(bogus.status).toBe(404);
      expect(off.body).toEqual(bogus.body);
    });

    it("still answers for a cancelled event, saying so", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await as(organizer).call("DELETE", `/api/groups/${groupId}/posts/${postId}`);
      const res = await anonymous().call("GET", `/api/public/events/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
    });

    it.each(["PRIVATE", "SECRET"] as const)(
      "withholds a %s group's name but keeps the headcount",
      async (visibility) => {
        const groupId = await createGroup(visibility);
        const { postId, token } = await createEvent(groupId);
        await as(member).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
          response: "YES",
        });
        const res = await anonymous().call("GET", `/api/public/events/${token}`);
        expect(res.body.groupName).toBeNull();
        expect(res.body.rsvpCounts).toEqual({ yes: 1, no: 0, maybe: 0, attending: 1 });
        expect(JSON.stringify(res.body)).not.toContain("Youth Group");
      }
    );

    it("counts everyone attending: members going, their guests, and public RSVPs with theirs", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await as(member).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
        response: "YES",
        guestCount: 1,
      });
      // A maybe is not coming, and does not count.
      await as(organizer).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
        response: "MAYBE",
        guestCount: 3,
      });
      await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp({ guestCount: 2 }));
      await anonymous().call(
        "POST",
        `/api/public/events/${token}/rsvp`,
        rsvp({ email: "b@example.com", guestCount: 0 })
      );
      const res = await anonymous().call("GET", `/api/public/events/${token}`);
      expect(res.body.rsvpCounts).toEqual({ yes: 1, no: 0, maybe: 1, attending: 6 });
    });

    it("carries no names, of members or of strangers", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await as(member).call("PUT", `/api/groups/${groupId}/posts/${postId}/rsvp`, {
        response: "YES",
      });
      await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp());
      const text = JSON.stringify(
        (await anonymous().call("GET", `/api/public/events/${token}`)).body
      );
      for (const name of ["Mo", "Member", "Cara", "Sam", "Stranger", "example.com"]) {
        expect(text).not.toContain(name);
      }
    });
  });

  describe("POST /api/public/events/:token/rsvp", () => {
    it("404s with public RSVP off, even with a bad body", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId, { publicRsvpEnabled: false });
      expect(
        (await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp())).status
      ).toBe(404);
      expect((await anonymous().call("POST", `/api/public/events/${token}/rsvp`, {})).status).toBe(
        404
      );
      expect(await publicRsvpRows()).toEqual([]);
    });

    it("records an RSVP, and a second from the same address updates it", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId);
      const first = await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp());
      expect(first.status).toBe(204);
      expect(first.body).toBeNull();

      await anonymous().call(
        "POST",
        `/api/public/events/${token}/rsvp`,
        rsvp({ email: "sam@example.com", guestCount: 4, firstName: "Samuel" })
      );
      expect(await publicRsvpRows()).toEqual([
        { email: "sam@example.com", guest_count: 4, first_name: "Samuel" },
      ]);
    });

    it("accepts zero guests, and refuses a missing count, a blank name, a bad address", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId);
      const post = (body: unknown) =>
        anonymous().call("POST", `/api/public/events/${token}/rsvp`, body);
      expect((await post(rsvp({ guestCount: 0 }))).status).toBe(204);
      const { guestCount: _omit, ...noCount } = rsvp();
      expect((await post(noCount)).status).toBe(400);
      expect((await post(rsvp({ firstName: "  " }))).status).toBe(400);
      expect((await post(rsvp({ email: "not-an-email" }))).status).toBe(400);
      expect((await post(rsvp({ guestCount: 51 }))).status).toBe(400);
    });

    it("409s for a cancelled event and for one that has happened", async () => {
      const groupId = await createGroup();
      const cancelled = await createEvent(groupId);
      await as(organizer).call("DELETE", `/api/groups/${groupId}/posts/${cancelled.postId}`);
      expect(
        (await anonymous().call("POST", `/api/public/events/${cancelled.token}/rsvp`, rsvp()))
          .status
      ).toBe(409);

      const past = await createEvent(groupId, { eventDate: "2020-01-01" });
      expect(
        (await anonymous().call("POST", `/api/public/events/${past.token}/rsvp`, rsvp())).status
      ).toBe(409);
    });

    it("429s past the cap, but still takes a correction from somebody already on the list", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await db().query(
        `insert into group_event_public_rsvps (post_id, first_name, last_name, email, guest_count)
         select $1, 'P', 'Q', 'p' || n || '@example.com', 0 from generate_series(1, $2::int) n`,
        [postId, PUBLIC_RSVP_MAX_PER_EVENT]
      );
      const extra = await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp());
      expect(extra.status).toBe(429);
      const correction = await anonymous().call(
        "POST",
        `/api/public/events/${token}/rsvp`,
        rsvp({ email: "p1@example.com" })
      );
      expect(correction.status).toBe(204);
    });
  });

  describe("POST /api/public/events/:token/join-request", () => {
    const join = { firstName: "Jo", lastName: "Joiner", email: "jo@example.com" };

    async function requests() {
      const { rows } = await db().query<{ organization_id: string; status: string }>(
        "select organization_id, status from directory_requests"
      );
      return rows;
    }

    it("404s with public RSVP off", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId, { publicRsvpEnabled: false });
      const res = await anonymous().call("POST", `/api/public/events/${token}/join-request`, join);
      expect(res.status).toBe(404);
      expect(await requests()).toEqual([]);
    });

    it("files one pending request in the event's parish and tells its administrators", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId);
      const first = await anonymous().call(
        "POST",
        `/api/public/events/${token}/join-request`,
        join
      );
      const again = await anonymous().call(
        "POST",
        `/api/public/events/${token}/join-request`,
        join
      );
      expect(first.status).toBe(204);
      expect(again.status).toBe(204);
      expect(await requests()).toEqual([{ organization_id: orgId, status: "PENDING" }]);

      const adminInbox = (await as(parishAdmin).call("GET", "/api/notifications")).body;
      expect(
        adminInbox.notifications.filter((n: { type: string }) => n.type === "DIRECTORY_REQUEST")
      ).toHaveLength(1);
      const memberInbox = (await as(member).call("GET", "/api/notifications")).body;
      expect(
        memberInbox.notifications.filter((n: { type: string }) => n.type === "DIRECTORY_REQUEST")
      ).toHaveLength(0);
    });
  });

  describe("GET /api/events/by-token/:token", () => {
    it("needs a session", async () => {
      const groupId = await createGroup();
      const { token } = await createEvent(groupId);
      const res = await anonymous().call("GET", `/api/events/by-token/${token}`);
      expect(res.status).toBe(401);
    });

    it("404s for an unknown token", async () => {
      const res = await as(member).call("GET", "/api/events/by-token/01HZZZZZZZZZZZZZZZZZZZZZZZ");
      expect(res.status).toBe(404);
    });

    it("resolves for anyone signed in, whatever the membership, visibility or flag -- and says nothing else", async () => {
      const groupId = await createGroup("SECRET");
      const { postId, token } = await createEvent(groupId, { publicRsvpEnabled: false });
      for (const caller of [member, outsider, foreigner]) {
        const res = await as(caller).call("GET", `/api/events/by-token/${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ groupId, postId });
      }
    });

    it("leaves the reading to the group's routes, which refuse the wrong people", async () => {
      const groupId = await createGroup("SECRET");
      const { postId } = await createEvent(groupId);
      const path = `/api/groups/${groupId}/posts/${postId}`;
      expect((await as(member).call("GET", path)).status).toBe(200);
      expect((await as(outsider).call("GET", path)).status).toBe(404);
      expect((await as(foreigner).call("GET", path)).status).toBe(404);
    });
  });

  describe("on the groups routes", () => {
    it("gives every event its own share token, kept through edits, cancelling and restoring", async () => {
      const groupId = await createGroup();
      const a = await createEvent(groupId);
      const b = await createEvent(groupId);
      expect(a.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(a.token).not.toBe(b.token);

      const edited = await as(organizer).call("PATCH", `/api/groups/${groupId}/posts/${a.postId}`, {
        event: { eventTitle: "Renamed", eventDate: "2030-06-02" },
      });
      expect(edited.body.event.shareToken).toBe(a.token);
      // An edit that does not mention the flag leaves it alone.
      expect(edited.body.event.publicRsvpEnabled).toBe(true);

      await as(organizer).call("DELETE", `/api/groups/${groupId}/posts/${a.postId}`);
      const restored = await as(organizer).call(
        "POST",
        `/api/groups/${groupId}/posts/${a.postId}/restore`
      );
      expect(restored.body.event.shareToken).toBe(a.token);
    });

    it("round-trips the public RSVP flag, and turning it off closes the page", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId, { publicRsvpEnabled: false });
      const turnedOn = await as(organizer).call("PATCH", `/api/groups/${groupId}/posts/${postId}`, {
        event: { eventTitle: "Parish Picnic", eventDate: "2030-06-01", publicRsvpEnabled: true },
      });
      expect(turnedOn.body.event.publicRsvpEnabled).toBe(true);
      expect((await anonymous().call("GET", `/api/public/events/${token}`)).status).toBe(200);

      await as(organizer).call("PATCH", `/api/groups/${groupId}/posts/${postId}`, {
        event: { eventTitle: "Parish Picnic", eventDate: "2030-06-01", publicRsvpEnabled: false },
      });
      expect((await anonymous().call("GET", `/api/public/events/${token}`)).status).toBe(404);
    });

    it("defaults the flag off", async () => {
      const groupId = await createGroup();
      const res = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, {
        kind: "EVENT",
        event: { eventTitle: "Quiet", eventDate: "2030-06-01" },
      });
      expect(res.body.event.publicRsvpEnabled).toBe(false);
    });

    it("lists public RSVPs on the roster, with the address only for the organizer and moderators", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp());
      const path = `/api/groups/${groupId}/posts/${postId}/rsvps`;

      const forMember = await as(member).call("GET", path);
      expect(forMember.body.publicRsvps).toEqual([
        expect.objectContaining({
          firstName: "Sam",
          lastName: "Stranger",
          guestCount: 2,
          email: null,
        }),
      ]);
      expect(forMember.body.canManagePublicRsvps).toBe(false);
      for (const caller of [organizer, parishAdmin]) {
        const res = await as(caller).call("GET", path);
        expect(res.body.publicRsvps[0].email).toBe("sam@example.com");
        expect(res.body.canManagePublicRsvps).toBe(true);
      }
    });

    it("counts public RSVPs and their guests on the event", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp({ guestCount: 2 }));
      await anonymous().call(
        "POST",
        `/api/public/events/${token}/rsvp`,
        rsvp({ email: "b@example.com", guestCount: 0 })
      );
      const res = await as(member).call("GET", `/api/groups/${groupId}/posts/${postId}`);
      expect(res.body.event.rsvpCounts.publicAttending).toBe(4);
    });

    it("lets the organizer or a moderator remove a public RSVP, audited, and refuses a plain member", async () => {
      const groupId = await createGroup();
      const { postId, token } = await createEvent(groupId);
      await anonymous().call("POST", `/api/public/events/${token}/rsvp`, rsvp());
      const roster = await as(organizer).call(
        "GET",
        `/api/groups/${groupId}/posts/${postId}/rsvps`
      );
      const rsvpId = roster.body.publicRsvps[0].id as string;
      const path = `/api/groups/${groupId}/posts/${postId}/public-rsvps/${rsvpId}`;

      expect((await as(member).call("DELETE", path)).status).toBe(403);
      expect((await as(parishAdmin).call("DELETE", path)).status).toBe(204);
      expect(await publicRsvpRows()).toEqual([]);
      expect((await as(parishAdmin).call("DELETE", path)).status).toBe(404);

      const { rows } = await db().query<{ action: string; entity_id: string }>(
        "select action, entity_id::text from audit_log where action = 'group.publicRsvp.delete'"
      );
      expect(rows).toEqual([{ action: "group.publicRsvp.delete", entity_id: postId }]);
    });
  });
});
