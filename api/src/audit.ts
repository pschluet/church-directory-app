import type { Queryable } from "./db";
import type { Caller } from "./auth";

/**
 * A trail of who changed what. Admins can edit other people's records, and a
 * parish directory is exactly the sort of shared data where "who changed my
 * phone number?" comes up, so writes that affect someone else are recorded.
 *
 * Deliberately fire-and-forget: a failure to write the audit row must not fail
 * the user's save.
 */
export async function audit(
  q: Queryable,
  caller: Caller,
  entry: {
    action: string;
    entityType: string;
    entityId: string | null;
    changes?: unknown;
  }
): Promise<void> {
  try {
    await q.query(
      `insert into audit_log (organization_id, actor_app_user_id, action, entity_type, entity_id, changes)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        caller.organizationId,
        caller.appUserId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.changes === undefined ? null : JSON.stringify(entry.changes),
      ]
    );
  } catch (err) {
    console.error("Failed to write audit log entry", entry.action, err);
  }
}
