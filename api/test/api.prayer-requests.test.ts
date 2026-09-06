import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";
import { PUSH_KINDS } from "../src/routes/prayer-requests";

/**
 * Prayer requests, and the moderation that gates them.
 *
 * The assertions that matter most are the negative ones. A request names a
 * third party and is written about them, so "nobody but the author sees it
 * until a reviewer approves it" is the feature -- a regression there is not a
 * cosmetic bug, it publishes something somebody asked to have reviewed first.
 */

const hasDb = inject("hasDatabase");

/**
 * The words on the lock screen.
 *
 * Pure copy, no database -- outside the skipIf below so it runs even with
 * Postgres down. It earns a test because every one of these strings is only
 * ever seen on a phone: the bug it guards against rendered as "Parish Directory
 * from Directory" on iOS and was completely invisible on a laptop.
 */
describe("push notification copy", () => {
  it("never puts the app's name in the title", () => {
    /*
     * iOS renders the bold line as "{title} from {app name}" and cannot be told
     * not to, so a title naming the app says it twice. The obvious "tidy-up" is
     * to put a friendly-looking app name back here, which is why this asserts
     * rather than trusting the comment.
     */
    for (const { title } of Object.values(PUSH_KINDS)) {
      expect(title).not.toMatch(/directory/i);
      expect(title).not.toMatch(/parish/i);
    }
  });

  it("says what each notification is about", () => {
    expect(PUSH_KINDS.posted.title).toBe("Prayer Requests");
    expect(PUSH_KINDS.review.title).toBe("Approval Needed");
  });

  it("keeps the two kinds distinct, so neither replaces the other", () => {
    // An approver can have something waiting *and* something newly posted, and
    // they are different things to do. A shared title or tag would collapse
    // them into one notification on the lock screen.
    expect(PUSH_KINDS.posted.title).not.toBe(PUSH_KINDS.review.title);
    expect(PUSH_KINDS.posted.tag).not.toBe(PUSH_KINDS.review.tag);
  });

  it("counts posted requests, singular and plural", () => {
    expect(PUSH_KINDS.posted.body(1)).toBe("1 new prayer request");
    expect(PUSH_KINDS.posted.body(3)).toBe("3 new prayer requests");
  });

  it("agrees the noun *and* the verb on the approval body", () => {
    // Two agreements, and getting one right while missing the other is the easy
    // mistake: "1 new prayer requests needs approval".
    expect(PUSH_KINDS.review.body(1)).toBe("1 new prayer request needs approval");
    expect(PUSH_KINDS.review.body(3)).toBe("3 new prayer requests need approval");
  });
});

describe.skipIf(!hasDb)("prayer requests", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgA: string;
  let orgB: string;
  let author: CreatedUser;
  let member: CreatedUser;
  let reviewer: CreatedUser;
  let admin: CreatedUser;
  let outsider: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgA = await createOrganization(db(), "All Saints", "all-saints");
    orgB = await createOrganization(db(), "St. George", "st-george");

    author = await createUser(db(), {
      organizationId: orgA,
      email: "author@a.test",
      firstName: "Anna",
      lastName: "Petrova",
    });
    member = await createUser(db(), {
      organizationId: orgA,
      email: "member@a.test",
      firstName: "Boris",
    });
    reviewer = await createUser(db(), {
      organizationId: orgA,
      role: "PRAYER_REQUEST_ADMIN",
      email: "reviewer@a.test",
      firstName: "Nikolai",
    });
    admin = await createUser(db(), {
      organizationId: orgA,
      role: "ADMIN",
      email: "admin@a.test",
      firstName: "Paul",
    });
    outsider = await createUser(db(), {
      organizationId: orgB,
      email: "outsider@b.test",
      firstName: "Elena",
    });
  });

  afterAll(closeDatabase);

  async function submit(
    who: CreatedUser = author,
    body: Record<string, unknown> = {}
  ): Promise<string> {
    const response = await as(who).call("POST", "/api/prayer-requests", {
      title: "For my mother",
      body: "She is having surgery on Thursday.",
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body.id;
  }

  const titles = (body: { prayerRequests: { title: string }[] }) =>
    body.prayerRequests.map((r) => r.title);

  describe("submitting", () => {
    it("creates a request that is pending and not yet posted", async () => {
      const { status, body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "She is having surgery on Thursday.",
      });
      expect(status).toBe(201);
      expect(body).toMatchObject({
        status: "PENDING",
        postedAt: null,
        decidedAt: null,
        authorName: "Anna Petrova",
        isMine: true,
        canDelete: true,
        // The author is not a reviewer, and their own request is not theirs to
        // wave through.
        canDecide: false,
      });
      expect(body.submittedAt).toBeTruthy();
    });

    it("trims the title and body, and rejects a blank one", async () => {
      const { body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "  For my mother  ",
        body: "  Surgery Thursday.  ",
      });
      expect(body.title).toBe("For my mother");
      expect(body.body).toBe("Surgery Thursday.");

      const blank = await as(author).call("POST", "/api/prayer-requests", {
        title: "   ",
        body: "Something",
      });
      expect(blank.status).toBe(400);
    });

    it("refuses an image key belonging to somebody else", async () => {
      const { status, body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [
          {
            photoKey: `photos/${orgA}/prayer-request/${member.personId}/01ABC/`,
            width: 800,
            height: 600,
          },
        ],
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/does not belong/i);
    });

    it("refuses an image key from another parish", async () => {
      const { status } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [
          {
            photoKey: `photos/${orgB}/prayer-request/${author.personId}/01ABC/`,
            width: 800,
            height: 600,
          },
        ],
      });
      expect(status).toBe(400);
    });

    it("stores images in the order they were given", async () => {
      const prefix = `photos/${orgA}/prayer-request/${author.personId}`;
      const { body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [
          { photoKey: `${prefix}/01FIRST/`, width: 800, height: 600 },
          { photoKey: `${prefix}/02SECOND/`, width: 640, height: 640 },
          { photoKey: `${prefix}/03THIRD/`, width: 1200, height: 900 },
        ],
      });
      expect(body.images.map((i: { thumbUrl: string }) => i.thumbUrl)).toEqual([
        `/${prefix}/01FIRST/thumb`,
        `/${prefix}/02SECOND/thumb`,
        `/${prefix}/03THIRD/thumb`,
      ]);
      expect(body.images[0]).toMatchObject({ width: 800, height: 600 });
      expect(body.images[2].fullUrl).toBe(`/${prefix}/03THIRD/full`);
    });

    it("caps the number of images", async () => {
      const prefix = `photos/${orgA}/prayer-request/${author.personId}`;
      const { status } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [1, 2, 3, 4, 5].map((n) => ({
          photoKey: `${prefix}/0${n}/`,
          width: 100,
          height: 100,
        })),
      });
      expect(status).toBe(400);
    });
  });

  describe("a reviewer posting their own request", () => {
    /*
     * No review, because they are the person who would do the reviewing.
     * Routing it through PENDING would only ask them to press a second button
     * on their own words -- the same reasoning as an admin's merge request,
     * which merges on the spot.
     */
    it("posts it straight away, with a posted time", async () => {
      const { status, body } = await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      expect(status).toBe(201);
      expect(body).toMatchObject({ status: "APPROVED", isMine: true });
      expect(body.postedAt).toBeTruthy();
      expect(body.decidedAt).toBeTruthy();
    });

    it("shows it to the parish immediately", async () => {
      await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      const { body } = await as(member).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["From the reviewer"]);
    });

    it("never puts it in the review queue", async () => {
      await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      const { body } = await as(reviewer).call("GET", "/api/prayer-requests/pending");
      expect(body.prayerRequests).toEqual([]);
    });

    it("does the same for an admin, since the role is a floor", async () => {
      const { body } = await as(admin).call("POST", "/api/prayer-requests", {
        title: "From the admin",
        body: "Posted straight away.",
      });
      expect(body.status).toBe("APPROVED");
      expect(body.postedAt).toBeTruthy();
    });

    it("still makes a plain member wait for review", async () => {
      const { body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
      });
      expect(body.status).toBe("PENDING");
      expect(body.postedAt).toBeNull();
      expect(body.decidedAt).toBeNull();
    });

    it("records the reviewer as the one who posted it", async () => {
      const { body: created } = await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      const { rows } = await db().query<{ decided_by_person_id: string }>(
        "select decided_by_person_id from prayer_requests where id = $1",
        [created.id]
      );
      expect(rows[0]!.decided_by_person_id).toBe(reviewer.personId);
    });

    it("cannot be reviewed again", async () => {
      const { body: created } = await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
      });
      const { status } = await as(admin).call("POST", `/api/prayer-requests/${created.id}/approve`);
      expect(status).toBe(409);
    });

    it("keeps its attachments", async () => {
      const prefix = `photos/${orgA}/prayer-request/${reviewer.personId}`;
      const { body } = await as(reviewer).call("POST", "/api/prayer-requests", {
        title: "From the reviewer",
        body: "Posted straight away.",
        images: [{ photoKey: `${prefix}/01ABC/`, width: 800, height: 600 }],
      });
      expect(body.status).toBe("APPROVED");
      expect(body.images).toHaveLength(1);
    });
  });

  describe("visibility before approval", () => {
    it("shows the author their own pending request", async () => {
      await submit();
      const { body } = await as(author).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["For my mother"]);
      expect(body.prayerRequests[0].isMine).toBe(true);
    });

    it("hides a pending request from every other member", async () => {
      await submit();
      const { body } = await as(member).call("GET", "/api/prayer-requests");
      expect(body.prayerRequests).toEqual([]);
    });

    it("hides a pending request from an admin's page as well", async () => {
      await submit();
      const { body } = await as(admin).call("GET", "/api/prayer-requests");
      expect(body.prayerRequests).toEqual([]);
    });

    it("puts it in the reviewer's queue", async () => {
      await submit();
      const { status, body } = await as(reviewer).call("GET", "/api/prayer-requests/pending");
      expect(status).toBe(200);
      expect(titles(body)).toEqual(["For my mother"]);
      expect(body.prayerRequests[0].canDecide).toBe(true);
    });

    it("refuses the queue to a plain member", async () => {
      const { status } = await as(member).call("GET", "/api/prayer-requests/pending");
      expect(status).toBe(403);
    });

    it("lets an admin see the queue, since the role is a floor", async () => {
      await submit();
      const { status, body } = await as(admin).call("GET", "/api/prayer-requests/pending");
      expect(status).toBe(200);
      expect(titles(body)).toEqual(["For my mother"]);
    });

    it("keeps another parish's request out of the queue", async () => {
      await submit();
      const { body } = await as(reviewer).call("GET", "/api/prayer-requests/pending", undefined);
      expect(body.prayerRequests).toHaveLength(1);
      const otherParish = await createUser(db(), {
        organizationId: orgB,
        role: "PRAYER_REQUEST_ADMIN",
        email: "reviewer@b.test",
        firstName: "Marko",
      });
      const { body: theirs } = await as(otherParish).call("GET", "/api/prayer-requests/pending");
      expect(theirs.prayerRequests).toEqual([]);
    });
  });

  describe("approving", () => {
    it("posts the request and shows it to the whole parish", async () => {
      const id = await submit();
      const { status, body } = await as(reviewer).call(
        "POST",
        `/api/prayer-requests/${id}/approve`
      );
      expect(status).toBe(200);
      expect(body.status).toBe("APPROVED");
      expect(body.postedAt).toBeTruthy();
      expect(body.decidedAt).toBeTruthy();

      const { body: seen } = await as(member).call("GET", "/api/prayer-requests");
      expect(titles(seen)).toEqual(["For my mother"]);
      expect(seen.prayerRequests[0].isMine).toBe(false);
      expect(seen.prayerRequests[0].canDelete).toBe(false);
      // Who reviewed it is not the parish's business: an approved request is in
      // everybody's list, so an ungated decidedByName would tell all of them
      // which reviewer posted each one.
      expect(seen.prayerRequests[0].decidedByName).toBeNull();
    });

    it("names the reviewer to the author and to other reviewers", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);

      const { body: mine } = await as(author).call("GET", "/api/prayer-requests");
      expect(mine.prayerRequests[0].decidedByName).toBe("Nikolai User");

      const { body: theirs } = await as(admin).call("GET", "/api/prayer-requests");
      expect(theirs.prayerRequests[0].decidedByName).toBe("Nikolai User");
    });

    it("still hides it from another parish", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);
      const { body } = await as(outsider).call("GET", "/api/prayer-requests");
      expect(body.prayerRequests).toEqual([]);
    });

    it("refuses a plain member", async () => {
      const id = await submit();
      const { status } = await as(member).call("POST", `/api/prayer-requests/${id}/approve`);
      expect(status).toBe(403);
    });

    it("conflicts on a second decision", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);
      const { status, body } = await as(reviewer).call(
        "POST",
        `/api/prayer-requests/${id}/approve`
      );
      expect(status).toBe(409);
      expect(body.error).toMatch(/already been reviewed/i);
    });

    it("404s on another parish's request rather than 403ing", async () => {
      const id = await submit();
      const otherParish = await createUser(db(), {
        organizationId: orgB,
        role: "PRAYER_REQUEST_ADMIN",
        email: "reviewer2@b.test",
        firstName: "Marko",
      });
      const { status } = await as(otherParish).call("POST", `/api/prayer-requests/${id}/approve`);
      expect(status).toBe(404);
    });

    it("orders the page by posted time, not by submitted time", async () => {
      const first = await submit(author, { title: "Submitted first" });
      const second = await submit(author, { title: "Submitted second" });

      // Approved in the opposite order, so the two orderings disagree.
      await as(reviewer).call("POST", `/api/prayer-requests/${second}/approve`);
      await as(reviewer).call("POST", `/api/prayer-requests/${first}/approve`);

      const { body } = await as(member).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["Submitted first", "Submitted second"]);
    });

    it("puts the author's own unposted requests above the posted ones", async () => {
      const posted = await submit(author, { title: "Posted" });
      await as(reviewer).call("POST", `/api/prayer-requests/${posted}/approve`);
      await submit(author, { title: "Still waiting" });

      const { body } = await as(author).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["Still waiting", "Posted"]);
    });
  });

  describe("rejecting", () => {
    it("tells the author, with the reason, and nobody else", async () => {
      const id = await submit();
      const { status, body } = await as(reviewer).call(
        "POST",
        `/api/prayer-requests/${id}/reject`,
        { reason: "The family asked us to wait." }
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "REJECTED",
        postedAt: null,
        rejectionReason: "The family asked us to wait.",
      });

      const { body: mine } = await as(author).call("GET", "/api/prayer-requests");
      expect(mine.prayerRequests[0]).toMatchObject({
        status: "REJECTED",
        rejectionReason: "The family asked us to wait.",
        decidedByName: "Nikolai User",
        canDelete: true,
      });

      const { body: theirs } = await as(member).call("GET", "/api/prayer-requests");
      expect(theirs.prayerRequests).toEqual([]);
    });

    it("withholds the reason from a member who is not the author", async () => {
      // Belt and braces: a rejected request is not in another member's list at
      // all, so this asserts the field itself is gated rather than relying on
      // the row being filtered out upstream.
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`, {
        reason: "Private note",
      });
      const { rows } = await db().query<{ rejection_reason: string }>(
        "select rejection_reason from prayer_requests where id = $1",
        [id]
      );
      expect(rows[0]!.rejection_reason).toBe("Private note");

      const { body } = await as(member).call("GET", "/api/prayer-requests");
      expect(body.prayerRequests).toEqual([]);
    });

    it("accepts a rejection with no reason and no body at all", async () => {
      const id = await submit();
      const { status, body } = await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`);
      expect(status).toBe(200);
      expect(body.status).toBe("REJECTED");
      expect(body.rejectionReason).toBeNull();
    });

    it("takes it out of the queue", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`);
      const { body } = await as(reviewer).call("GET", "/api/prayer-requests/pending");
      expect(body.prayerRequests).toEqual([]);
    });

    it("shows it to no reviewer but the one who decided it", async () => {
      // What the dialog's copy promises the reviewer. `admin` clears the
      // PRAYER_REQUEST_ADMIN floor, so the gate in toPrayerRequest would hand
      // them the note -- they never receive the row to carry it: GET / matches
      // on APPROVED-in-window or authorship, and /pending on PENDING.
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`, {
        reason: "The family asked us to wait.",
      });

      const { body: theirs } = await as(admin).call("GET", "/api/prayer-requests");
      expect(theirs.prayerRequests).toEqual([]);
      const { body: queue } = await as(admin).call("GET", "/api/prayer-requests/pending");
      expect(queue.prayerRequests).toEqual([]);
    });

    it("keeps the decision readable after the reviewer's record is deleted", async () => {
      // decided_by_person_id is `on delete set null`, so the name goes and the
      // decision stays. The join has to be a LEFT one for that to be true --
      // an inner join would drop the row and the author's declined request
      // would simply vanish from their list.
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/reject`, {
        reason: "The family asked us to wait.",
      });
      await db().query("delete from persons where id = $1", [reviewer.personId]);

      const { body } = await as(author).call("GET", "/api/prayer-requests");
      expect(body.prayerRequests).toHaveLength(1);
      expect(body.prayerRequests[0]).toMatchObject({
        status: "REJECTED",
        rejectionReason: "The family asked us to wait.",
        decidedByName: null,
      });
    });
  });

  describe("the one-month window", () => {
    async function post(title: string, postedDaysAgo: number): Promise<string> {
      const id = await submit(author, { title });
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);
      await db().query(
        "update prayer_requests set posted_at = now() - ($2 || ' days')::interval where id = $1",
        [id, postedDaysAgo]
      );
      return id;
    }

    it("drops a request posted more than a month ago", async () => {
      await post("Last week", 7);
      await post("Six weeks ago", 42);

      const { body } = await as(member).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["Last week"]);
    });

    it("keeps the aged-out row in the database", async () => {
      await post("Six weeks ago", 42);
      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from prayer_requests"
      );
      expect(rows[0]!.count).toBe("1");
    });

    it("still shows the author their own aged-out request", async () => {
      // Their own rows are theirs regardless of the window -- the window is
      // about what the parish sees on the page.
      await post("Six weeks ago", 42);
      const { body } = await as(author).call("GET", "/api/prayer-requests");
      expect(titles(body)).toEqual(["Six weeks ago"]);
    });
  });

  describe("deleting", () => {
    it("lets the author withdraw their own, images and all", async () => {
      const prefix = `photos/${orgA}/prayer-request/${author.personId}`;
      const { body: created } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [{ photoKey: `${prefix}/01ABC/`, width: 800, height: 600 }],
      });

      const { status } = await as(author).call("DELETE", `/api/prayer-requests/${created.id}`);
      expect(status).toBe(204);

      const { rows } = await db().query<{ count: string }>(
        "select count(*)::text as count from prayer_request_images"
      );
      expect(rows[0]!.count).toBe("0");
    });

    it("refuses another member", async () => {
      const id = await submit();
      const { status } = await as(member).call("DELETE", `/api/prayer-requests/${id}`);
      expect(status).toBe(403);
    });

    it("refuses a reviewer, whose power stops at deciding", async () => {
      const id = await submit();
      const { status } = await as(reviewer).call("DELETE", `/api/prayer-requests/${id}`);
      expect(status).toBe(403);
    });

    it("lets an admin remove any of them", async () => {
      const id = await submit();
      await as(reviewer).call("POST", `/api/prayer-requests/${id}/approve`);
      const { status } = await as(admin).call("DELETE", `/api/prayer-requests/${id}`);
      expect(status).toBe(204);
    });

    it("404s on another parish's request", async () => {
      const id = await submit();
      const { status } = await as(outsider).call("DELETE", `/api/prayer-requests/${id}`);
      expect(status).toBe(404);
    });
  });

  describe("presigning an attachment", () => {
    it("hands back a key scoped to the caller's own person record", async () => {
      const { status, body } = await as(author).call("POST", "/api/uploads/prayer-request-image", {
        contentType: "image/webp",
        renditions: { thumb: { contentLength: 20_000 }, full: { contentLength: 200_000 } },
      });
      expect(status).toBe(200);
      expect(body.photoKey).toMatch(
        new RegExp(`^photos/${orgA}/prayer-request/${author.personId}/[0-9A-Z]{26}/$`)
      );
      expect(body.uploadUrls.thumb).toBe(`/${body.photoKey}thumb`);
      expect(body.uploadUrls.full).toBe(`/${body.photoKey}full`);
    });

    it("is usable end to end: presign, then attach", async () => {
      const { body: presigned } = await as(author).call(
        "POST",
        "/api/uploads/prayer-request-image",
        {
          contentType: "image/webp",
          renditions: { thumb: { contentLength: 20_000 }, full: { contentLength: 200_000 } },
        }
      );
      const { status, body } = await as(author).call("POST", "/api/prayer-requests", {
        title: "For my mother",
        body: "Surgery Thursday.",
        images: [{ photoKey: presigned.photoKey, width: 1200, height: 900 }],
      });
      expect(status).toBe(201);
      expect(body.images).toHaveLength(1);
    });

    it("refuses a rendition larger than the cap", async () => {
      const { status } = await as(author).call("POST", "/api/uploads/prayer-request-image", {
        contentType: "image/webp",
        renditions: { thumb: { contentLength: 20_000 }, full: { contentLength: 50_000_000 } },
      });
      expect(status).toBe(400);
    });
  });
});
