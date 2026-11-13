import type { Queryable } from "../db";
import { sendNotificationEmail, type NotificationEmailItem } from "../email";
import type { EmailContent, EmailEvent } from "../email-content";
import {
  NOTIFICATION_LABELS,
  formatEventDay,
  formatEventTimes,
  notificationPath,
  type GroupPostKind,
  type NotificationType,
} from "../types";
import { NOTIFICATION_VISIBLE } from "./notifications";

/**
 * Notification emails: the bell's rows, mailed to the members who asked.
 *
 * Nothing here decides *who* should hear about something. Every fan-out in
 * services/notifications.ts and services/group-notifications.ts has already
 * applied the topic switches and the per-group exceptions by the time a row
 * exists, so the rows are the answer. This only adds the email-specific rules:
 *
 *   - the account switched email on (`email_enabled`), and the row arrived
 *     after it did (`email_enabled_at`) -- switching on is not a backlog;
 *   - the row has not been emailed, has not been *read* (somebody who already
 *     saw it in the app does not need it in their inbox too), and still leads
 *     somewhere (`NOTIFICATION_VISIBLE`, the same fragment the bell uses, so a
 *     withdrawn request or an archived group's post is never mailed);
 *   - the row is less than a day old. A send that keeps failing -- a mailbox
 *     that no longer exists -- gives up rather than retrying forever, and an
 *     outage does not end in a flood of day-old news.
 *
 * Batched per person. A person's pending rows wait until the oldest is
 * `BATCH_WINDOW` old, then all of them go out together -- so three messages in
 * one group over a minute are one email, not three, and the first is never
 * more than a couple of minutes late.
 *
 * Run every minute by send-notification-emails.ts, with a reserved concurrency
 * of one so two runs never overlap. That, and stamping `emailed_at` the moment
 * each send succeeds, is what keeps a row from being mailed twice.
 */

/** How long a person's first pending notification waits for others to join it. */
export const BATCH_WINDOW_MS = 2 * 60 * 1000;

/** Older than this and a notification is never emailed. */
const MAX_AGE = "1 day";

/**
 * The most of a message or prayer request one email carries. Posts are shown
 * in full; this is only a guard against something enormous, far past anything
 * a member types, with the rest left to the app.
 */
export const BODY_LIMIT = 5000;

/**
 * Sends per second. SES's default production quota is 14; staying under it
 * leaves room for the sign-in codes and invitations sent at the same moment,
 * which share it. Anything left over goes out on the next run, a minute later.
 */
const SENDS_PER_SECOND = 10;

interface PendingRow {
  id: string;
  app_user_id: string;
  email: string;
  unsubscribe_token: string;
  organization_name: string | null;
  type: NotificationType;
  created_at: Date | string;
  group_id: string | null;
  group_post_id: string | null;
  group_post_parent_id: string | null;
  group_post_parent_kind: GroupPostKind | null;
  group_title: string | null;
  post_kind: GroupPostKind | null;
  post_body: string | null;
  post_author: string | null;
  post_deleted: boolean | null;
  event_title: string | null;
  event_description: string | null;
  event_date: Date | string | null;
  event_start: string | null;
  event_end: string | null;
  event_location: string | null;
  poll_question: string | null;
  signup_title: string | null;
  signup_description: string | null;
  poll_allows_multiple: boolean | null;
  poll_options: string[] | null;
  image_count: number;
  file_names: string[] | null;
  prayer_title: string | null;
  prayer_body: string | null;
  prayer_author: string | null;
  requester_name: string | null;
}

/** One person's email: who it goes to and what is in it. */
export interface PendingEmail {
  appUserId: string;
  to: string;
  organizationName: string;
  unsubscribeToken: string;
  notificationIds: string[];
  items: NotificationEmailItem[];
}

/**
 * Everyone with notifications ready to email, as of `now`, one entry per person.
 * Read-only: nothing is marked until the send succeeds.
 */
export async function collectPendingEmails(
  q: Queryable,
  options: { now: Date; siteUrl: string }
): Promise<PendingEmail[]> {
  const { rows } = await q.query<PendingRow>(
    `select n.id,
            n.app_user_id,
            u.email,
            np.email_unsubscribe_token as unsubscribe_token,
            o.name as organization_name,
            n.type,
            n.created_at,
            n.group_id,
            n.group_post_id,
            gp.parent_post_id as group_post_parent_id,
            parent.kind as group_post_parent_kind,
            g.title as group_title,
            gp.kind as post_kind,
            gp.body as post_body,
            nullif(btrim(concat_ws(' ', gpa.first_name, gpa.last_name)), '') as post_author,
            gp.deleted_at is not null as post_deleted,
            ge.title as event_title,
            ge.description as event_description,
            ge.event_date::text as event_date,
            to_char(ge.start_time, 'HH24:MI') as event_start,
            to_char(ge.end_time, 'HH24:MI') as event_end,
            ge.location as event_location,
            gpoll.question as poll_question,
            gsu.title as signup_title,
            gsu.description as signup_description,
            gpoll.allows_multiple as poll_allows_multiple,
            (select array_agg(o.label order by o.position)
               from group_poll_options o where o.post_id = gpoll.post_id) as poll_options,
            -- Photos are counted and files named, never linked: both sit
            -- behind the app's signed cookies (see email-content.ts).
            case
              when gp.id is not null then
                (select count(*)::int from group_post_attachments a
                  where a.post_id = gp.id and a.kind = 'IMAGE')
              when pr.id is not null then
                (select count(*)::int from prayer_request_images i
                  where i.prayer_request_id = pr.id)
              else 0
            end as image_count,
            (select array_agg(a.filename order by a.position)
               from group_post_attachments a
              where a.post_id = gp.id and a.kind = 'FILE') as file_names,
            pr.title as prayer_title,
            pr.body as prayer_body,
            nullif(btrim(concat_ws(' ', pra.first_name, pra.last_name)), '') as prayer_author,
            dr.first_name || ' ' || dr.last_name as requester_name
       from notification_preferences np
       join app_users u on u.id = np.app_user_id
       -- notifications_unread_idx (app_user_id, created_at desc) where read_at
       -- is null is exactly this join: the few opted-in accounts, their unread.
       join notifications n on n.app_user_id = np.app_user_id and n.read_at is null
       join organizations o on o.id = n.organization_id
       left join prayer_requests pr on pr.id = n.prayer_request_id
       left join persons pra on pra.id = pr.author_person_id
       left join groups g on g.id = n.group_id
       left join group_posts gp on gp.id = n.group_post_id
       left join group_posts parent on parent.id = gp.parent_post_id
       left join group_events ge on ge.post_id = gp.id
       left join group_polls gpoll on gpoll.post_id = gp.id
       left join group_signups gsu on gsu.post_id = gp.id
       left join persons gpa on gpa.id = gp.author_person_id
       left join directory_requests dr on dr.id = n.directory_request_id
      where np.email_enabled
        and u.status = 'ACTIVE'
        and n.emailed_at is null
        and n.created_at >= np.email_enabled_at
        and n.created_at > $1::timestamptz - interval '${MAX_AGE}'
        and n.created_at <= $1::timestamptz
        and ${NOTIFICATION_VISIBLE}
      order by n.app_user_id, n.created_at`,
    [options.now]
  );

  const byUser = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.app_user_id) ?? [];
    list.push(row);
    byUser.set(row.app_user_id, list);
  }

  const due: PendingEmail[] = [];
  const cutoff = options.now.getTime() - BATCH_WINDOW_MS;
  for (const [appUserId, list] of byUser) {
    // Ordered by created_at, so the first is the oldest. Not yet its turn:
    // leave the whole batch for a later run, so whatever arrives meanwhile
    // joins it.
    if (new Date(list[0]!.created_at).getTime() > cutoff) continue;
    const first = list[0]!;
    due.push({
      appUserId,
      to: first.email,
      organizationName: first.organization_name ?? "Directory",
      unsubscribeToken: first.unsubscribe_token,
      notificationIds: list.map((row) => row.id),
      items: list.map((row) => toItem(row, options.siteUrl, options.now)),
    });
  }
  return due;
}

const NO_CONTENT: EmailContent = {
  body: null,
  bodyFormat: "plain",
  event: null,
  poll: null,
  attachments: { images: 0, files: [] },
  truncated: false,
};

/** The event a row is about, ready to show; null when the row is not about one. */
function eventOf(row: PendingRow, now: Date): EmailEvent | null {
  if (!row.event_title || !row.event_date) return null;
  const day = formatEventDay(String(row.event_date), now);
  const times = formatEventTimes(row.event_start, row.event_end);
  return {
    title: row.event_title,
    when: times ? `${day} · ${times}` : day,
    location: row.event_location,
    description: row.event_description,
    // An event post is soft-deleted when it is cancelled (see V16__groups.sql).
    cancelled: row.post_deleted === true,
  };
}

/** Everything the email shows of the post itself. See email-content.ts. */
function contentOf(row: PendingRow, now: Date): EmailContent {
  if (row.type === "PRAYER_REQUEST" || row.type === "PRAYER_REQUEST_REVIEW") {
    const { body, truncated } = capBody(row.prayer_body);
    return {
      ...NO_CONTENT,
      body,
      truncated,
      attachments: { images: row.image_count, files: [] },
    };
  }
  if (!row.group_post_id) return NO_CONTENT;

  const attachments = { images: row.image_count, files: row.file_names ?? [] };
  if (row.post_kind === "EVENT") return { ...NO_CONTENT, event: eventOf(row, now), attachments };
  if (row.post_kind === "POLL" && row.poll_question) {
    return {
      ...NO_CONTENT,
      poll: {
        question: row.poll_question,
        options: row.poll_options ?? [],
        allowsMultiple: row.poll_allows_multiple === true,
      },
      attachments,
    };
  }
  if (row.post_kind === "SIGNUP" && row.signup_title) {
    // Plain text: the title, then what the organizer said about it.
    const text = [row.signup_title, row.signup_description].filter(Boolean).join("\n\n");
    const { body, truncated } = capBody(text);
    return { ...NO_CONTENT, body, truncated, attachments };
  }
  const { body, truncated } = capBody(row.post_body);
  return { ...NO_CONTENT, body, bodyFormat: "rich", truncated, attachments };
}

function toItem(row: PendingRow, siteUrl: string, now: Date): NotificationEmailItem {
  const url =
    siteUrl +
    notificationPath({
      type: row.type,
      groupId: row.group_id,
      groupPostId: row.group_post_id,
      groupPostParentId: row.group_post_parent_id,
      groupPostParentKind: row.group_post_parent_kind,
    });
  const label = NOTIFICATION_LABELS[row.type];
  const group = row.group_title ?? "your group";
  const author = row.post_author ?? "Somebody";
  const kind = row.post_kind;
  const what =
    kind === "EVENT"
      ? "an event"
      : kind === "POLL"
        ? "a poll"
        : kind === "SIGNUP"
          ? "a sign-up"
          : null;
  const openAction =
    kind === "EVENT"
      ? "Open the event"
      : kind === "POLL"
        ? "Vote in the app"
        : kind === "SIGNUP"
          ? "Sign up in the app"
          : "Open the message";

  switch (row.type) {
    case "PRAYER_REQUEST":
    case "PRAYER_REQUEST_REVIEW": {
      const title = row.prayer_title ?? "Prayer request";
      const review = row.type === "PRAYER_REQUEST_REVIEW";
      return {
        ...contentOf(row, now),
        label,
        heading: title,
        context: row.prayer_author ? `From ${row.prayer_author}` : null,
        subject: review ? `Needs your approval: ${title}` : `Prayer request: ${title}`,
        action: review ? "Review the request" : "Read the prayer request",
        url,
      };
    }
    case "GROUP_POST":
      return {
        ...contentOf(row, now),
        label,
        heading: group,
        context: what
          ? `${author} posted ${what}`
          : row.group_post_parent_id
            ? `${author} replied`
            : `${author} posted`,
        subject:
          kind === "EVENT"
            ? `New event in ${group}`
            : kind === "POLL"
              ? `New poll in ${group}`
              : kind === "SIGNUP"
                ? `New sign-up in ${group}`
                : `New message in ${group}`,
        action: openAction,
        url,
      };
    case "GROUP_MENTION":
      return {
        ...contentOf(row, now),
        label,
        heading: group,
        context: `${author} mentioned you`,
        subject: `${author} mentioned you in ${group}`,
        action: openAction,
        url,
      };
    case "GROUP_EVENT":
      // The event as it now stands -- what changed is the point of the email.
      return {
        ...NO_CONTENT,
        event: eventOf(row, now),
        label,
        heading: group,
        context: row.post_deleted ? "An event was cancelled" : "An event was changed",
        subject: row.post_deleted ? `Event cancelled in ${group}` : `Event changed in ${group}`,
        action: "Open the event",
        url,
      };
    case "GROUP_JOIN_REQUEST":
      return {
        ...NO_CONTENT,
        label,
        heading: group,
        context: "Somebody asked to join this group",
        subject: `Someone wants to join ${group}`,
        action: "Review the request",
        url,
      };
    case "GROUP_POST_REPORT":
      // The reported post is deliberately not quoted -- nor its poll, event or
      // attachments: the email would spread exactly what somebody flagged as
      // not belonging.
      return {
        ...NO_CONTENT,
        label,
        heading: group,
        context: "A member reported a post",
        subject: `A post in ${group} was reported`,
        action: "Review the post",
        url,
      };
    case "DIRECTORY_REQUEST": {
      const name = row.requester_name ?? "Somebody";
      return {
        ...NO_CONTENT,
        label,
        heading: name,
        context: null,
        subject: `${name} asked to be added to the directory`,
        action: "Review on People & Accounts",
        url,
      };
    }
  }
}

/**
 * The text in full, unless it passes BODY_LIMIT -- then cut at a word, with
 * `truncated` set so the email says the rest is in the app.
 */
export function capBody(text: string | null): { body: string | null; truncated: boolean } {
  const trimmed = text?.trim();
  if (!trimmed) return { body: null, truncated: false };
  if (trimmed.length <= BODY_LIMIT) return { body: trimmed, truncated: false };
  const cut = trimmed.slice(0, BODY_LIMIT);
  const space = cut.lastIndexOf(" ");
  return {
    body: (space > BODY_LIMIT * 0.8 ? cut.slice(0, space) : cut).trimEnd(),
    truncated: true,
  };
}

export interface SendResult {
  sent: number;
  failed: number;
  /** Due but not reached before the deadline; they go out on the next run. */
  deferred: number;
  notifications: number;
}

/**
 * Sends everything due, one person at a time, stamping each person's rows as
 * soon as their email is accepted -- so a run that dies halfway resends
 * nobody. A failure for one person is logged and left pending for the next
 * run; it never stops the others.
 */
export async function sendPendingEmails(
  q: Queryable,
  options: {
    now: Date;
    siteUrl: string;
    /** Stop starting new sends after this, so the function ends before its timeout. */
    deadline: number;
    send?: typeof sendNotificationEmail;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<SendResult> {
  const send = options.send ?? sendNotificationEmail;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const due = await collectPendingEmails(q, options);
  const result: SendResult = { sent: 0, failed: 0, deferred: 0, notifications: 0 };
  const interval = 1000 / SENDS_PER_SECOND;

  for (const [index, email] of due.entries()) {
    if (Date.now() >= options.deadline) {
      result.deferred = due.length - index;
      break;
    }
    const started = Date.now();
    try {
      await send(email.to, {
        organizationName: email.organizationName,
        items: email.items,
        settingsUrl: `${options.siteUrl}/settings`,
        unsubscribeUrl: `${options.siteUrl}/unsubscribe?token=${email.unsubscribeToken}`,
        oneClickUnsubscribeUrl: `${options.siteUrl}/api/public/email-unsubscribe?token=${email.unsubscribeToken}`,
      });
      await q.query(
        "update notifications set emailed_at = now() where id = any($1::uuid[]) and emailed_at is null",
        [email.notificationIds]
      );
      result.sent++;
      result.notifications += email.notificationIds.length;
    } catch (err) {
      result.failed++;
      console.error("Notification email failed", { appUserId: email.appUserId, err });
    }
    const wait = interval - (Date.now() - started);
    if (wait > 0 && index < due.length - 1) await sleep(wait);
  }
  return result;
}
