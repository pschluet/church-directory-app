import type { Queryable } from "./db";
import type { Caller } from "./auth";

/**
 * A trail of who changed what. Admins can edit other people's records, and a
 * parish directory is exactly the sort of shared data where "who changed my
 * phone number?" comes up, so every durable change a person makes is recorded
 * -- including to their own settings, not only to someone else's record.
 *
 * Deliberately fire-and-forget: a failure to write the audit row must not fail
 * the user's save.
 *
 * Deliberately *not* recorded, and why:
 *
 *   - `POST /notifications/read` -- a read receipt, not a change. It fires
 *     every time the bell is opened, and nothing any other member can see is
 *     different afterwards.
 *   - `POST`/`DELETE /push/subscriptions`, and the dead-subscription pruning
 *     in services/push.ts -- per-device plumbing. The SPA re-subscribes on
 *     every page load, so recording it would bury the trail under the act of
 *     opening the app.
 *   - `POST /uploads/photo` and `/uploads/prayer-request-image` -- mint a
 *     presigned URL and write no row. The `PUT .../photo` that follows is the
 *     change, and that one is recorded.
 *   - Binding the bootstrap super admin's `cognito_sub`, and flipping a
 *     first-sign-in account from INVITED to ACTIVE (both in auth.ts) -- the
 *     only actor is the subject, these run inside the auth middleware on
 *     requests that may be doing anything at all, and `app_users.status`
 *     already carries the fact.
 *   - refresh-geocodes.ts -- a scheduled job. `audit()` takes a `Caller`, and
 *     a nightly Lambda is not one.
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
