import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

/**
 * Sign-ups: the SIGNUP post kind, members' entries, and the public share page.
 *
 * The rules this file holds: a slot never takes more than its capacity, a
 * write-in belongs to the entry that made it, the public page never names
 * anybody, and a public entry can only be changed with its edit token.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("sign-ups", () => {
  const db = () => testDb();
  const anonymous = () => client(db(), null);
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let orgId: string;
  let organizer: CreatedUser;
  let member: CreatedUser;
  let other: CreatedUser;
  let groupId: string;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    organizer = await createUser(db(), {
      organizationId: orgId,
      firstName: "Cara",
      lastName: "Org",
    });
    member = await createUser(db(), { organizationId: orgId, firstName: "Mo", lastName: "Member" });
    other = await createUser(db(), { organizationId: orgId, firstName: "Ola", lastName: "Other" });
    const res = await as(organizer).call("POST", "/api/groups", {
      title: "Parish Life",
      visibility: "PUBLIC",
    });
    groupId = res.body.id;
    for (const u of [member, other]) {
      await as(organizer).call("POST", `/api/groups/${groupId}/members`, { personId: u.personId });
    }
  });
  afterAll(closeDatabase);

  async function createSignup(signup: Record<string, unknown> = {}) {
    const res = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, {
      kind: "SIGNUP",
      signup: {
        title: "Parish Potluck",
        template: "POTLUCK",
        noteMode: "REQUIRED",
        notePrompt: "What are you bringing?",
        slots: [
          { label: "Main dish", capacity: 2 },
          { label: "Dessert", capacity: 3 },
        ],
        ...signup,
      },
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; signup: any };
  }

  const entries = (postId: string) => `/api/groups/${groupId}/posts/${postId}/signup/entries`;

  it("creates a sign-up with its slots", async () => {
    const post = await createSignup();
    expect(post.signup.title).toBe("Parish Potluck");
    expect(post.signup.slots.map((s: any) => [s.label, s.capacity, s.taken])).toEqual([
      ["Main dish", 2, 0],
      ["Dessert", 3, 0],
    ]);
    expect(post.signup.shareToken).toHaveLength(26);
    expect(post.signup.canManage).toBe(true);
  });

  it("gives a sign-up with no slots one general unlimited slot", async () => {
    const post = await createSignup({ slots: [] });
    expect(post.signup.slots).toHaveLength(1);
    expect(post.signup.slots[0]).toMatchObject({ label: null, date: null, capacity: null });
  });

  it("refuses a sign-up as a reply", async () => {
    const parent = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, { body: "Hi" });
    const res = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, {
      kind: "SIGNUP",
      parentPostId: parent.body.id,
      signup: { title: "Nope" },
    });
    expect(res.status).toBe(400);
  });

  it("lets a member sign up with a quantity and holds the slot to capacity", async () => {
    const post = await createSignup();
    const main = post.signup.slots[0].id;

    const first = await as(member).call("POST", entries(post.id), {
      slotId: main,
      quantity: 1,
      note: "Lasagna",
    });
    expect(first.status).toBe(200);
    expect(first.body.signup.slots[0].taken).toBe(1);
    expect(first.body.signup.slots[0].entries[0]).toMatchObject({
      name: "Mo Member",
      note: "Lasagna",
      isMine: true,
    });

    const tooMany = await as(other).call("POST", entries(post.id), {
      slotId: main,
      quantity: 2,
      note: "Chili",
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe("Only 1 left in that slot");

    const fits = await as(other).call("POST", entries(post.id), {
      slotId: main,
      quantity: 1,
      note: "Chili",
    });
    expect(fits.status).toBe(200);

    const full = await as(organizer).call("POST", entries(post.id), {
      slotId: main,
      note: "Soup",
    });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("That slot is full");
  });

  it("requires the note when the sign-up says so, and drops it when it asks for none", async () => {
    const post = await createSignup();
    const missing = await as(member).call("POST", entries(post.id), {
      slotId: post.signup.slots[0].id,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("What are you bringing?");

    const flowers = await createSignup({
      title: "Altar flowers",
      noteMode: "NONE",
      slots: [{ date: "2099-12-06", capacity: 1 }],
    });
    const res = await as(member).call("POST", entries(flowers.id), {
      slotId: flowers.signup.slots[0].id,
      note: "ignored",
    });
    expect(res.status).toBe(200);
    expect(res.body.signup.slots[0].entries[0].note).toBeNull();
  });

  it("allows one entry per person per slot; a second is a change", async () => {
    const post = await createSignup();
    const main = post.signup.slots[0].id;
    await as(member).call("POST", entries(post.id), { slotId: main, note: "Lasagna" });
    const again = await as(member).call("POST", entries(post.id), { slotId: main, note: "Ziti" });
    expect(again.status).toBe(409);
  });

  it("lets a signer change and remove their own entry, but not someone else's", async () => {
    const post = await createSignup();
    const dessert = post.signup.slots[1].id;
    const created = await as(member).call("POST", entries(post.id), {
      slotId: dessert,
      note: "Pie",
    });
    const entryId = created.body.signup.slots[1].entries[0].id;

    const changed = await as(member).call("PATCH", `${entries(post.id)}/${entryId}`, {
      quantity: 3,
      note: "Three pies",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.signup.slots[1].entries[0]).toMatchObject({
      quantity: 3,
      note: "Three pies",
    });

    const over = await as(member).call("PATCH", `${entries(post.id)}/${entryId}`, { quantity: 4 });
    expect(over.status).toBe(409);

    const notMine = await as(other).call("PATCH", `${entries(post.id)}/${entryId}`, {
      note: "Cake",
    });
    expect(notMine.status).toBe(403);
    const notMineDelete = await as(other).call("DELETE", `${entries(post.id)}/${entryId}`);
    expect(notMineDelete.status).toBe(403);

    const removed = await as(member).call("DELETE", `${entries(post.id)}/${entryId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.signup.slots[1].taken).toBe(0);
  });

  it("lets the organizer remove anyone's entry, and audits it", async () => {
    const post = await createSignup();
    const created = await as(member).call("POST", entries(post.id), {
      slotId: post.signup.slots[0].id,
      note: "Lasagna",
    });
    const entryId = created.body.signup.slots[0].entries[0].id;
    const res = await as(organizer).call("DELETE", `${entries(post.id)}/${entryId}`);
    expect(res.status).toBe(200);
    const { rows } = await db().query(
      "select action from audit_log where action = 'group.signupEntry.delete'"
    );
    expect(rows).toHaveLength(1);
  });

  it("caps write-ins, and a write-in belongs to the entry that made it", async () => {
    const post = await createSignup({
      title: "Christmas stockings",
      noteMode: "NONE",
      writeInsEnabled: true,
      writeInMax: 1,
      slots: [{ label: "Oranges", capacity: 10 }],
    });

    const mine = await as(member).call("POST", entries(post.id), {
      writeIn: "Chocolate coins",
      quantity: 5,
    });
    expect(mine.status).toBe(200);
    const writeIn = mine.body.signup.slots.find((s: any) => s.isWriteIn);
    expect(writeIn).toMatchObject({ label: "Chocolate coins", capacity: 5, taken: 5 });
    expect(mine.body.signup.writeInCount).toBe(1);

    const full = await as(other).call("POST", entries(post.id), { writeIn: "Candy canes" });
    expect(full.status).toBe(409);
    const joinTheirs = await as(other).call("POST", entries(post.id), { slotId: writeIn.id });
    expect(joinTheirs.status).toBe(409);
    const duplicate = await as(other).call("POST", entries(post.id), { writeIn: "oranges" });
    expect(duplicate.status).toBe(409);

    const entryId = writeIn.entries[0].id;
    const renamed = await as(member).call("PATCH", `${entries(post.id)}/${entryId}`, {
      writeIn: "Gold coins",
      quantity: 6,
    });
    expect(renamed.body.signup.slots.find((s: any) => s.isWriteIn)).toMatchObject({
      label: "Gold coins",
      capacity: 6,
      taken: 6,
    });

    const removed = await as(member).call("DELETE", `${entries(post.id)}/${entryId}`);
    expect(removed.body.signup.slots.some((s: any) => s.isWriteIn)).toBe(false);
    expect(removed.body.signup.writeInCount).toBe(0);
  });

  it("refuses write-ins when the organizer did not allow them", async () => {
    const post = await createSignup();
    const res = await as(member).call("POST", entries(post.id), { writeIn: "Bread", note: "x" });
    expect(res.status).toBe(400);
  });

  it("closes past dates and past the closing day", async () => {
    const post = await createSignup({
      noteMode: "NONE",
      slots: [
        { date: "2000-01-02", capacity: 1 },
        { date: "2099-01-02", capacity: 1 },
      ],
    });
    expect(post.signup.slots[0].closed).toBe(true);
    const past = await as(member).call("POST", entries(post.id), {
      slotId: post.signup.slots[0].id,
    });
    expect(past.status).toBe(409);

    const closed = await createSignup({ title: "Closed", closesOn: "2000-01-01" });
    expect(closed.signup.closed).toBe(true);
    const res = await as(member).call("POST", entries(closed.id), {
      slotId: closed.signup.slots[0].id,
      note: "x",
    });
    expect(res.status).toBe(409);
  });

  it("lets the organizer edit slots, keeping entries, but not below what is taken", async () => {
    const post = await createSignup({ noteMode: "NONE" });
    const [main, dessert] = post.signup.slots;
    await as(member).call("POST", entries(post.id), { slotId: main.id, quantity: 2 });

    const tooSmall = await as(organizer).call("PATCH", `/api/groups/${groupId}/posts/${post.id}`, {
      signup: {
        title: "Parish Potluck",
        noteMode: "NONE",
        slots: [{ id: main.id, label: "Main dish", capacity: 1 }],
      },
    });
    expect(tooSmall.status).toBe(409);

    const res = await as(organizer).call("PATCH", `/api/groups/${groupId}/posts/${post.id}`, {
      signup: {
        title: "Potluck supper",
        noteMode: "NONE",
        slots: [
          { label: "Salad", capacity: 2 },
          { id: main.id, label: "Mains", capacity: 4 },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.signup.title).toBe("Potluck supper");
    expect(res.body.signup.slots.map((s: any) => [s.label, s.capacity, s.taken])).toEqual([
      ["Salad", 2, 0],
      ["Mains", 4, 2],
    ]);
    expect(res.body.signup.slots.some((s: any) => s.id === dessert.id)).toBe(false);
    expect(res.body.signup.shareToken).toBe(post.signup.shareToken);
  });

  it("links the recipient, who must be in the parish", async () => {
    const post = await createSignup({ recipientPersonId: member.personId });
    expect(post.signup.recipient).toEqual({ personId: member.personId, name: "Mo Member" });

    const otherOrg = await createOrganization(db(), "St. George", "st-george");
    const stranger = await createUser(db(), { organizationId: otherOrg });
    const res = await as(organizer).call("POST", `/api/groups/${groupId}/posts`, {
      kind: "SIGNUP",
      signup: { title: "Meals", recipientPersonId: stranger.personId },
    });
    expect(res.status).toBe(400);
  });

  describe("public share page", () => {
    it("404s unless the organizer opened it to the public", async () => {
      const post = await createSignup();
      const res = await anonymous().call("GET", `/api/public/signups/${post.signup.shareToken}`);
      expect(res.status).toBe(404);
      const made = await anonymous().call("GET", "/api/public/signups/01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(made.status).toBe(404);
      expect(made.body).toEqual(res.body);
    });

    it("shows what is being brought, never who", async () => {
      const post = await createSignup({ publicEnabled: true });
      await as(member).call("POST", entries(post.id), {
        slotId: post.signup.slots[0].id,
        note: "Lasagna",
      });
      const res = await anonymous().call("GET", `/api/public/signups/${post.signup.shareToken}`);
      expect(res.status).toBe(200);
      expect(res.body.slots[0]).toMatchObject({ label: "Main dish", taken: 1 });
      expect(res.body.slots[0].entries[0].note).toBe("Lasagna");
      expect(JSON.stringify(res.body)).not.toContain("Mo Member");
      expect(JSON.stringify(res.body)).not.toContain("Member");
    });

    it("signs up a stranger, who can change and cancel only with the edit token", async () => {
      const post = await createSignup({ publicEnabled: true });
      const token = post.signup.shareToken;
      const created = await anonymous().call("POST", `/api/public/signups/${token}/entries`, {
        slotId: post.signup.slots[1].id,
        quantity: 2,
        note: "Brownies",
        firstName: "Pat",
        lastName: "Public",
        email: "pat@example.com",
      });
      expect(created.status).toBe(201);
      const { entryId, editToken } = created.body;
      expect(editToken.length).toBeGreaterThan(20);
      const { rows } = await db().query<{ edit_token_hash: string }>(
        "select edit_token_hash from group_signup_entries where id = $1",
        [entryId]
      );
      expect(rows[0]!.edit_token_hash).not.toBe(editToken);

      // The organizer sees the name and address; a plain member sees the name only.
      const forOrganizer = await as(organizer).call(
        "GET",
        `/api/groups/${groupId}/posts/${post.id}`
      );
      const seen = forOrganizer.body.signup.slots[1].entries[0];
      expect(seen).toMatchObject({ name: "Pat Public", isPublic: true, email: "pat@example.com" });

      const wrong = await anonymous().call(
        "PATCH",
        `/api/public/signups/${token}/entries/${entryId}`,
        {
          editToken: "x".repeat(32),
          note: "Cookies",
        }
      );
      expect(wrong.status).toBe(404);

      const changed = await anonymous().call(
        "PATCH",
        `/api/public/signups/${token}/entries/${entryId}`,
        { editToken, note: "Cookies", quantity: 1 }
      );
      expect(changed.status).toBe(204);
      const page = await anonymous().call("GET", `/api/public/signups/${token}`);
      expect(page.body.slots[1].entries[0]).toEqual({ id: entryId, quantity: 1, note: "Cookies" });

      const cancelled = await anonymous().call(
        "DELETE",
        `/api/public/signups/${token}/entries/${entryId}`,
        { editToken }
      );
      expect(cancelled.status).toBe(204);
      const after = await anonymous().call("GET", `/api/public/signups/${token}`);
      expect(after.body.slots[1].taken).toBe(0);
    });

    it("holds public sign-ups to the same capacity", async () => {
      const post = await createSignup({ publicEnabled: true, noteMode: "NONE" });
      const res = await anonymous().call(
        "POST",
        `/api/public/signups/${post.signup.shareToken}/entries`,
        {
          slotId: post.signup.slots[0].id,
          quantity: 3,
          firstName: "Pat",
          lastName: "Public",
          email: "pat@example.com",
        }
      );
      expect(res.status).toBe(409);
    });

    it("resolves the token for a signed-in reader", async () => {
      const post = await createSignup();
      const res = await as(member).call(
        "GET",
        `/api/events/signups/by-token/${post.signup.shareToken}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ groupId, postId: post.id });
    });
  });
});
