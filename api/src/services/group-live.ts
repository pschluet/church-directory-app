import { one, type Queryable } from "../db";
import { fullName } from "../types";

/**
 * What an open group page polls for: whether anything in the group changed, and
 * who is typing. See V20__group_live.sql for why this is a poll and why the
 * answer is a stamp on the group row rather than a scan of its posts.
 */

/** How long after their last keystroke signal somebody still counts as typing. */
export const TYPING_WINDOW_SECONDS = 5;

/** Rows older than this are noise; the next typing signal in the group sweeps them. */
const TYPING_SWEEP_MINUTES = 1;

export async function loadActivityAt(q: Queryable, groupId: string): Promise<string> {
  const row = await one<{ activity_at: Date | string }>(
    q,
    "select activity_at from groups where id = $1",
    [groupId]
  );
  return new Date(row?.activity_at ?? 0).toISOString();
}

/** Names of everyone but the caller who has signalled typing in the last few seconds, oldest first. */
export async function loadTypingNames(
  q: Queryable,
  groupId: string,
  callerAppUserId: string
): Promise<string[]> {
  const { rows } = await q.query<{ first_name: string; last_name: string | null }>(
    `select p.first_name, p.last_name
       from group_typing t
       join persons_resolved p on p.app_user_id = t.app_user_id
      where t.group_id = $1
        and t.app_user_id <> $2
        and t.typed_at > now() - make_interval(secs => $3)
      order by t.typed_at`,
    [groupId, callerAppUserId, TYPING_WINDOW_SECONDS]
  );
  return rows.map((row) => fullName({ firstName: row.first_name, lastName: row.last_name }));
}

/** Records "typing now", and sweeps this group's stale markers while it is there. */
export async function markTyping(q: Queryable, groupId: string, appUserId: string): Promise<void> {
  await q.query(
    `delete from group_typing
      where group_id = $1 and typed_at < now() - make_interval(mins => $2)`,
    [groupId, TYPING_SWEEP_MINUTES]
  );
  await q.query(
    `insert into group_typing (group_id, app_user_id) values ($1, $2)
     on conflict (group_id, app_user_id) do update set typed_at = now()`,
    [groupId, appUserId]
  );
}

/** Their message landed, so they are no longer typing. */
export async function clearTyping(q: Queryable, groupId: string, appUserId: string): Promise<void> {
  await q.query("delete from group_typing where group_id = $1 and app_user_id = $2", [
    groupId,
    appUserId,
  ]);
}
