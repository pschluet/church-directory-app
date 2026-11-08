import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";
import {
  BATCH_WINDOW_MS,
  collectPendingEmails,
  sendPendingEmails,
  shorten,
  SNIPPET_LENGTH,
} from "../src/services/notification-email";
import { renderNotificationEmail, type NotificationEmailItem } from "../src/email";

/**
 * Notification emails: who gets one, when, and what it says.
 *
 * The rules that decide who hears about something at all belong to the
 * fan-outs and are tested with them; this is everything email adds on top --
 * the opt-in, the batching, never mailing what was already read or has since
 * gone away, and never mailing the same thing twice.
 */

const hasDb = inject("hasDatabase");
const SITE = "https://directory.test";

/** A moment past the batch window, so anything just created is due. */
const later = () => new Date(Date.now() + BATCH_WINDOW_MS + 1000);

describe.skipIf(!hasDb)("notification emails", () => {
  const db = () => testDb();
  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  let org: string;
  let author: CreatedUser;
  let member: CreatedUser;
  let other: CreatedUser;
  let reviewer: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    org = await createOrganization(db(), "All Saints", "all-saints");
    author = await createUser(db(), {
      organizationId: org,
      email: "author@a.test",
      firstName: "Mary",
      lastName: "Smith",
    });
    member = await createUser(db(), { organizationId: org, email: "member@a.test" });
    other = await createUser(db(), { organizationId: org, email: "other@a.test" });
    reviewer = await createUser(db(), {
      organizationId: org,
      role: "PRAYER_REQUEST_ADMIN",
      email: "reviewer@a.test",
    });
  });

  afterAll(closeDatabase);

  const optIn = (u: CreatedUser) =>
    as(u).call("PUT", "/api/notifications/preferences", { emailNotifications: true });

  async function postPrayerRequest(title = "For my mother", body = "Surgery Thursday.") {
    const { body: created } = await as(author).call("POST", "/api/prayer-requests", {
      title,
      body,
    });
    await as(reviewer).call("POST", `/api/prayer-requests/${created.id}/approve`);
    return created.id as string;
  }

  const pending = (now = later()) => collectPendingEmails(db(), { now, siteUrl: SITE });

  describe("the switch", () => {
    it("is off until switched on", async () => {
      const { body } = await as(member).call("GET", "/api/notifications/preferences");
      expect(body.emailNotifications).toBe(false);
    });

    it("saves on its own, leaving the topic switches alone", async () => {
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      const { body } = await optIn(member);
      expect(body).toMatchObject({ emailNotifications: true, prayerRequests: false });
    });

    it("is recorded in the audit log like the other switches", async () => {
      await optIn(member);
      const { rows } = await db().query<{ changes: Record<string, unknown> }>(
        "select changes from audit_log where action = 'user.changeNotifications'"
      );
      expect(rows.at(-1)?.changes).toMatchObject({ emailNotifications: true });
    });

    it("only restamps when switched from off to on", async () => {
      await optIn(member);
      const stamp = async () =>
        (
          await db().query<{ at: Date }>(
            "select email_enabled_at as at from notification_preferences where app_user_id = $1",
            [member.appUserId]
          )
        ).rows[0]!.at;
      const first = await stamp();
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      await optIn(member);
      expect(await stamp()).toEqual(first);
    });
  });

  describe("who is emailed", () => {
    it("emails only the members who switched it on", async () => {
      await optIn(member);
      await postPrayerRequest();
      const due = await pending();
      expect(due.map((e) => e.to)).toEqual(["member@a.test"]);
    });

    it("does not mail what arrived before the switch went on", async () => {
      await postPrayerRequest("Before");
      await optIn(member);
      await postPrayerRequest("After");
      const due = await pending();
      expect(due).toHaveLength(1);
      expect(due[0]!.items.map((i) => i.heading)).toEqual(["After"]);
    });

    it("follows the topic switches -- prayer requests off means none by email either", async () => {
      await optIn(member);
      await as(member).call("PUT", "/api/notifications/preferences", { prayerRequests: false });
      await postPrayerRequest();
      expect(await pending()).toEqual([]);
    });

    it("skips what the member already read in the app", async () => {
      await optIn(member);
      await postPrayerRequest();
      await as(member).call("POST", "/api/notifications/read");
      expect(await pending()).toEqual([]);
    });

    it("skips a notification that no longer leads anywhere", async () => {
      await optIn(member);
      const id = await postPrayerRequest();
      await as(author).call("DELETE", `/api/prayer-requests/${id}`);
      expect(await pending()).toEqual([]);
    });

    it("skips a disabled account", async () => {
      await optIn(member);
      await postPrayerRequest();
      await db().query("update app_users set status = 'DISABLED' where id = $1", [
        member.appUserId,
      ]);
      expect(await pending()).toEqual([]);
    });

    it("gives up on a notification more than a day old", async () => {
      await optIn(member);
      await postPrayerRequest();
      const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
      expect(await pending(tomorrow)).toEqual([]);
    });
  });

  describe("batching", () => {
    it("holds a notification until the batch window has passed", async () => {
      await optIn(member);
      await postPrayerRequest();
      expect(await pending(new Date(Date.now() + 1000))).toEqual([]);
      expect(await pending()).toHaveLength(1);
    });

    it("sends everything that arrived meanwhile as one email", async () => {
      await optIn(member);
      await postPrayerRequest("First");
      await postPrayerRequest("Second");
      const due = await pending();
      expect(due).toHaveLength(1);
      expect(due[0]!.items.map((i) => i.heading)).toEqual(["First", "Second"]);
      expect(due[0]!.notificationIds).toHaveLength(2);
    });

    it("never sends the same notification twice", async () => {
      await optIn(member);
      await postPrayerRequest();
      const send = vi.fn().mockResolvedValue(undefined);
      const run = () =>
        sendPendingEmails(db(), {
          now: later(),
          siteUrl: SITE,
          deadline: Date.now() + 60_000,
          send,
          sleep: async () => {},
        });
      expect(await run()).toMatchObject({ sent: 1, notifications: 1 });
      expect(await run()).toMatchObject({ sent: 0 });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("leaves a failed send pending for the next run, without stopping the others", async () => {
      await optIn(member);
      await optIn(other);
      await postPrayerRequest();
      const send = vi.fn(async (to: string) => {
        if (to === "member@a.test") throw new Error("SES said no");
      });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await sendPendingEmails(db(), {
        now: later(),
        siteUrl: SITE,
        deadline: Date.now() + 60_000,
        send,
        sleep: async () => {},
      });
      quiet.mockRestore();
      expect(result).toMatchObject({ sent: 1, failed: 1 });
      expect((await pending()).map((e) => e.to)).toEqual(["member@a.test"]);
    });

    it("defers what it cannot reach before the deadline", async () => {
      await optIn(member);
      await postPrayerRequest();
      const send = vi.fn();
      const result = await sendPendingEmails(db(), {
        now: later(),
        siteUrl: SITE,
        deadline: Date.now() - 1,
        send,
      });
      expect(result).toMatchObject({ sent: 0, deferred: 1 });
      expect(send).not.toHaveBeenCalled();
    });

    it("hands the sender the unsubscribe and settings links", async () => {
      await optIn(member);
      await postPrayerRequest();
      const send = vi.fn().mockResolvedValue(undefined);
      await sendPendingEmails(db(), {
        now: later(),
        siteUrl: SITE,
        deadline: Date.now() + 60_000,
        send,
        sleep: async () => {},
      });
      const token = (
        await db().query<{ t: string }>(
          "select email_unsubscribe_token as t from notification_preferences where app_user_id = $1",
          [member.appUserId]
        )
      ).rows[0]!.t;
      expect(send.mock.calls[0]![1]).toMatchObject({
        organizationName: "All Saints",
        settingsUrl: `${SITE}/settings`,
        unsubscribeUrl: `${SITE}/unsubscribe?token=${token}`,
        oneClickUnsubscribeUrl: `${SITE}/api/public/email-unsubscribe?token=${token}`,
      });
    });
  });

  describe("what each email says", () => {
    it("quotes a prayer request, names its author, and links to the page", async () => {
      await optIn(member);
      await postPrayerRequest("For my mother", "Surgery Thursday.");
      const [item] = (await pending())[0]!.items;
      expect(item).toEqual({
        label: "Prayer request",
        heading: "For my mother",
        context: "From Mary Smith",
        snippet: "Surgery Thursday.",
        subject: "Prayer request: For my mother",
        action: "Read the prayer request",
        url: `${SITE}/prayer-requests`,
      });
    });

    it("asks a reviewer to review", async () => {
      await optIn(reviewer);
      await as(author).call("POST", "/api/prayer-requests", { title: "Waiting", body: "Please." });
      const [item] = (await pending())[0]!.items;
      expect(item).toMatchObject({
        label: "Needs your approval",
        subject: "Needs your approval: Waiting",
        action: "Review the request",
      });
    });

    it("quotes a group message as plain text and links to the message itself", async () => {
      const group = await as(author).call("POST", "/api/groups", {
        title: "Youth Group",
        visibility: "PUBLIC",
      });
      const groupId = group.body.id as string;
      await as(author).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      await optIn(member);
      const root = await as(author).call("POST", `/api/groups/${groupId}/posts`, {
        body: "**Pizza** on _Friday_ -- [details](https://example.com)",
      });
      const reply = await as(author).call("POST", `/api/groups/${groupId}/posts`, {
        body: "See you there",
        parentPostId: root.body.id,
      });

      const items = (await pending())[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        label: "New activity",
        heading: "Youth Group",
        context: "Mary Smith posted",
        snippet: "Pizza on Friday -- details",
        subject: "New message in Youth Group",
        url: `${SITE}/groups/${groupId}?message=${root.body.id}`,
      });
      // A reply lands on its thread, exactly as the bell entry would.
      expect(items[1]).toMatchObject({
        context: "Mary Smith replied",
        url: `${SITE}/groups/${groupId}/threads/${root.body.id}?message=${reply.body.id}`,
      });
    });

    it("tells a mentioned member they were mentioned", async () => {
      const group = await as(author).call("POST", "/api/groups", {
        title: "Choir",
        visibility: "PUBLIC",
      });
      const groupId = group.body.id as string;
      await as(author).call("POST", `/api/groups/${groupId}/members`, {
        personId: member.personId,
      });
      await optIn(member);
      await as(author).call("POST", `/api/groups/${groupId}/posts`, {
        body: "Can you sing Sunday?",
        mentionedAppUserIds: [member.appUserId],
      });
      const [item] = (await pending())[0]!.items;
      expect(item).toMatchObject({
        label: "You were mentioned",
        context: "Mary Smith mentioned you",
        subject: "Mary Smith mentioned you in Choir",
      });
    });

    it("shortens a long text at a word", () => {
      const long = `${"word ".repeat(100)}end`;
      const short = shorten(long)!;
      expect(short.length).toBeLessThanOrEqual(SNIPPET_LENGTH + 1);
      expect(short.endsWith("word…")).toBe(true);
      expect(shorten("   ")).toBeNull();
      expect(shorten("Short.")).toBe("Short.");
    });
  });

  describe("one-click unsubscribe", () => {
    async function tokenOf(u: CreatedUser): Promise<string> {
      const { rows } = await db().query<{ t: string }>(
        "select email_unsubscribe_token as t from notification_preferences where app_user_id = $1",
        [u.appUserId]
      );
      return rows[0]!.t;
    }
    const anonymous = () => client(db(), null);

    it("switches email off with nothing but the token", async () => {
      await optIn(member);
      const token = await tokenOf(member);
      const res = await anonymous().call("POST", `/api/public/email-unsubscribe?token=${token}`);
      expect(res.status).toBe(204);
      const { body } = await as(member).call("GET", "/api/notifications/preferences");
      expect(body.emailNotifications).toBe(false);
    });

    it("says the same thing about a token that does not exist", async () => {
      await optIn(member);
      const bogus = await anonymous().call(
        "POST",
        "/api/public/email-unsubscribe?token=00000000-0000-4000-8000-000000000000"
      );
      const garbage = await anonymous().call("POST", "/api/public/email-unsubscribe?token=x");
      expect(bogus.status).toBe(204);
      expect(garbage.status).toBe(204);
      const { body } = await as(member).call("GET", "/api/notifications/preferences");
      expect(body.emailNotifications).toBe(true);
    });

    it("does nothing on a GET, which link scanners send", async () => {
      await optIn(member);
      const token = await tokenOf(member);
      await anonymous().call("GET", `/api/public/email-unsubscribe?token=${token}`);
      const { body } = await as(member).call("GET", "/api/notifications/preferences");
      expect(body.emailNotifications).toBe(true);
    });
  });
});

describe("renderNotificationEmail", () => {
  const item = (overrides: Partial<NotificationEmailItem> = {}): NotificationEmailItem => ({
    label: "Prayer request",
    heading: "For my mother",
    context: "From Mary Smith",
    snippet: "Surgery Thursday.",
    subject: "Prayer request: For my mother",
    action: "Read the prayer request",
    url: `${SITE}/prayer-requests`,
    ...overrides,
  });
  const render = (items: NotificationEmailItem[]) =>
    renderNotificationEmail({
      organizationName: "All Saints",
      items,
      settingsUrl: `${SITE}/settings`,
      unsubscribeUrl: `${SITE}/unsubscribe?token=t`,
      oneClickUnsubscribeUrl: `${SITE}/api/public/email-unsubscribe?token=t`,
    });

  it("uses the item's own subject when there is one", () => {
    expect(render([item()]).subject).toBe("Prayer request: For my mother");
  });

  it("counts them when there are several", () => {
    expect(render([item(), item()]).subject).toBe("2 new notifications from All Saints");
  });

  it("escapes everything a member wrote", () => {
    const { html } = render([
      item({ heading: "<script>x</script>", snippet: `"quoted" & <b>bold</b>` }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  it("links each item and the footer back into the app", () => {
    const { html, text } = render([item()]);
    expect(html).toContain(`href="${SITE}/prayer-requests"`);
    expect(html).toContain(`href="${SITE}/settings"`);
    expect(html).toContain(`href="${SITE}/unsubscribe?token=t"`);
    expect(text).toContain(`Read the prayer request: ${SITE}/prayer-requests`);
    expect(text).toContain(`Stop these emails: ${SITE}/unsubscribe?token=t`);
  });

  it("offers one-click unsubscribe to the mail client", () => {
    expect(render([item()]).headers).toEqual([
      { name: "List-Unsubscribe", value: `<${SITE}/api/public/email-unsubscribe?token=t>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
  });
});
