import type { Queryable } from "../db";
import { PRAYER_REQUEST_WINDOW } from "./prayer-requests";
import type { NotificationDto } from "../types";

/**
 * The notification inbox behind the bell.
 *
 * Fanned out when a prayer request is posted, one row per recipient, so
 * "unread" is a fact about a person rather than a guess from a timestamp. See
 * V9__notifications.sql for why it is rows and not a high-water mark.
 */

/** How many the panel shows. Past this it is a list nobody scrolls. */
export const NOTIFICATION_PAGE_SIZE = 30;

/**
 * Everything a notification needs to be readable, and the window that decides
 * whether it is still worth showing.
 *
 * The join is inner, not left, and repeats the one-month window from the feed:
 * a notification whose request has aged off the page is a link to nothing, so
 * it should neither be listed nor counted. Withdrawn requests take their
 * notifications with them through the FK cascade, so they need no clause here.
 */
const NOTIFICATION_SELECT = `
  select n.id,
         n.type,
         n.prayer_request_id,
         pr.title as prayer_request_title,
         n.created_at,
         n.read_at
    from notifications n
    join prayer_requests pr
      on pr.id = n.prayer_request_id
     and pr.status = 'APPROVED'
     and pr.posted_at > now() - interval '${PRAYER_REQUEST_WINDOW}'
   where n.app_user_id = $1
`;

interface NotificationRow {
  id: string;
  type: NotificationDto["type"];
  prayer_request_id: string | null;
  prayer_request_title: string | null;
  created_at: Date | string;
  read_at: Date | string | null;
}

export interface Inbox {
  unreadCount: number;
  notifications: NotificationDto[];
}

export async function loadInbox(q: Queryable, appUserId: string): Promise<Inbox> {
  const [{ rows }, counted] = await Promise.all([
    q.query<NotificationRow>(
      `${NOTIFICATION_SELECT} order by n.created_at desc limit ${NOTIFICATION_PAGE_SIZE}`,
      [appUserId]
    ),
    // Counted separately rather than by filtering the page above: the badge has
    // to be right even when the unread ones outnumber what the panel lists.
    q.query<{ count: string }>(
      `select count(*)::text as count from (${NOTIFICATION_SELECT} and n.read_at is null) c`,
      [appUserId]
    ),
  ]);

  return {
    unreadCount: Number(counted.rows[0]?.count ?? "0"),
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      // For a prayer request notification the title is the whole message --
      // "for each prayer request notification, this should just show the title".
      title: row.prayer_request_title ?? "",
      prayerRequestId: row.prayer_request_id,
      createdAt: new Date(row.created_at).toISOString(),
      read: row.read_at !== null,
    })),
  };
}

/** Everything unread, in one statement. Returns how many were cleared. */
export async function markAllRead(q: Queryable, appUserId: string): Promise<number> {
  const { rows } = await q.query<{ id: string }>(
    "update notifications set read_at = now() where app_user_id = $1 and read_at is null returning id",
    [appUserId]
  );
  return rows.length;
}

/**
 * Who is told about a newly posted prayer request.
 *
 * Everyone active in the parish except one person: whoever just posted it.
 *
 * That is deliberately "the person who acted" rather than "the author". An
 * author whose request is approved by somebody else *does* get told -- being
 * told your request is now up is arguably the most useful notification the app
 * sends, and until it arrives the author has no signal at all. What nobody
 * needs is a notification for something they personally just did, which is the
 * reviewer who approved it, or a reviewer posting their own request directly.
 * Both of those are the same person: the one in `actingPersonId`.
 *
 * Accounts that are INVITED (never signed in) or DISABLED get nothing.
 *
 * `coalesce(p.prayer_requests, true)` is what makes an absent preferences row
 * mean "opted in", so nothing had to be backfilled when the table was added.
 *
 * `on conflict do nothing` against notifications_one_per_request_idx makes this
 * idempotent: two reviewers racing on the same request, or a retried request,
 * deliver one notification each rather than two.
 *
 * Returns the accounts that were actually notified, which is what the push
 * fan-out then sends to -- so the two agree by construction rather than by
 * repeating the recipient rules in a second query.
 */
/**
 * How many unread prayer request notifications each of these people has.
 *
 * This is the number the push notification reads out -- "3 new prayer
 * requests". Per recipient and not a single figure, because it means "three you
 * have not read": somebody who last opened the app this morning sees 1 where
 * somebody who has been away all week sees 6, from the same approval.
 *
 * Repeats the feed's window through the same join as `loadInbox`, so the count
 * on the notification is the count the badge shows when they open the app. The
 * two disagreeing is the sort of thing nobody reports and everybody notices.
 */
export async function unreadPrayerRequestCounts(
  q: Queryable,
  appUserIds: string[]
): Promise<Map<string, number>> {
  if (appUserIds.length === 0) return new Map();

  const { rows } = await q.query<{ app_user_id: string; count: string }>(
    `select n.app_user_id, count(*)::text as count
       from notifications n
       join prayer_requests pr
         on pr.id = n.prayer_request_id
        and pr.status = 'APPROVED'
        and pr.posted_at > now() - interval '${PRAYER_REQUEST_WINDOW}'
      where n.app_user_id = any($1::uuid[])
        and n.type = 'PRAYER_REQUEST'
        and n.read_at is null
      group by n.app_user_id`,
    [appUserIds]
  );

  return new Map(rows.map((row) => [row.app_user_id, Number(row.count)]));
}

export async function fanOutPrayerRequest(
  q: Queryable,
  options: {
    prayerRequestId: string;
    organizationId: string;
    /** Whoever posted it -- the approving reviewer, or the author on a direct post. */
    actingPersonId: string | null;
  }
): Promise<string[]> {
  const { rows } = await q.query<{ app_user_id: string }>(
    `insert into notifications (app_user_id, organization_id, type, prayer_request_id)
     select u.id, $2, 'PRAYER_REQUEST', $1
       from app_users u
       left join notification_preferences p on p.app_user_id = u.id
      where u.organization_id = $2
        and u.status = 'ACTIVE'
        and coalesce(p.prayer_requests, true)
        -- "is distinct from" rather than "<>", because a null actingPersonId
        -- (an account with no directory record) must exclude nobody: plain
        -- inequality against null is null, which is not true, so it would
        -- silently notify no one at all. Likewise the subquery returning no
        -- rows yields null, which is distinct from every real id.
        and u.id is distinct from (
          select app_user_id
            from persons
           where id = $3::uuid and app_user_id is not null
        )
     on conflict do nothing
     returning app_user_id`,
    [options.prayerRequestId, options.organizationId, options.actingPersonId]
  );
  return rows.map((row) => row.app_user_id);
}
