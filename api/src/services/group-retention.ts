import type { Queryable } from "../db";
import { deleteGroupAttachmentFile, deletePhoto } from "../photos";
import { POST_RETENTION_YEARS } from "../types";

/**
 * The scheduled purge: a group post, and everything hung off it, is removed
 * five years after the thread around it has gone quiet. See
 * requirements/groups.md's Retention section for the product rule and
 * requirements/groups-plan.md for why a thread with a recent reply, or an
 * event that has not happened yet, is exempt.
 *
 * Only root posts are ever deleted directly -- `parent_post_id on delete
 * cascade` (V16__groups.sql) takes every reply, attachment, mention, RSVP and
 * the `group_events` row with it in one statement. A reply is never purged on
 * its own: the whole point of measuring a thread's *last* activity is that an
 * old opening post stays put as long as anything under it is still being
 * talked about.
 */

interface ExpiredRoot {
  id: string;
  group_id: string;
  organization_id: string;
}

interface AttachmentToDelete {
  photo_key: string;
  kind: "IMAGE" | "FILE";
}

export interface ExpireGroupPostsResult {
  /** Root posts (and therefore threads) removed, keyed by organization. */
  byOrganization: Map<string, { posts: number; attachments: number; bytes: number }>;
}

/**
 * `now` is a parameter rather than `now()` in SQL so tests can simulate five
 * years passing without waiting for them -- see api/test/group-retention.test.ts.
 */
export async function expireGroupPosts(
  db: Queryable,
  options: { now: Date }
): Promise<ExpireGroupPostsResult> {
  const cutoff = new Date(options.now);
  cutoff.setFullYear(cutoff.getFullYear() - POST_RETENTION_YEARS);

  /*
   * A thread's last activity is the latest of: the root's own creation, its
   * event date if it has one (so a far-future event is never caught by its own
   * *posting* date), and every reply's creation. `coalesce(..., gp.created_at)`
   * on each half means a root with no event and no replies falls back to just
   * its own timestamp, which is the ordinary case.
   */
  const { rows: candidates } = await db.query<ExpiredRoot>(
    `select gp.id, gp.group_id, g.organization_id
       from group_posts gp
       join groups g on g.id = gp.group_id
       left join group_events ge on ge.post_id = gp.id
       left join group_posts replies on replies.parent_post_id = gp.id
      where gp.parent_post_id is null
      group by gp.id, gp.group_id, g.organization_id, ge.event_date, gp.created_at
     having greatest(
              gp.created_at,
              coalesce(ge.event_date::timestamptz, gp.created_at),
              coalesce(max(replies.created_at), gp.created_at)
            ) < $1`,
    [cutoff]
  );

  const byOrganization = new Map<string, { posts: number; attachments: number; bytes: number }>();
  if (candidates.length === 0) return { byOrganization };

  const byOrg = new Map<string, string[]>();
  for (const row of candidates) {
    const list = byOrg.get(row.organization_id) ?? [];
    list.push(row.id);
    byOrg.set(row.organization_id, list);
  }

  // Collected across every organization's transaction, then deleted from S3
  // only once every one of them has committed -- see the comment below.
  const allAttachments: AttachmentToDelete[] = [];

  // One transaction per organization -- a purge spanning every parish at once
  // would hold a single transaction open far longer than any one of them
  // needs, for no benefit: the organizations are independent and a failure in
  // one must not roll back another's.
  for (const [organizationId, rootIds] of byOrg) {
    await db.transaction(async (tx) => {
      // Gathered before the delete: once the rows are gone, so are their keys.
      const { rows: attachmentRows } = await tx.query<{
        photo_key: string;
        kind: "IMAGE" | "FILE";
        byte_size: number;
      }>(
        `select a.photo_key, a.kind, a.byte_size
           from group_post_attachments a
           join group_posts p on p.id = a.post_id
          where p.id = any($1::uuid[]) or p.parent_post_id = any($1::uuid[])`,
        [rootIds]
      );
      allAttachments.push(...attachmentRows.map((r) => ({ photo_key: r.photo_key, kind: r.kind })));
      const bytes = attachmentRows.reduce((sum, r) => sum + r.byte_size, 0);

      const { rows: deleted } = await tx.query<{ id: string }>(
        `delete from group_posts where id = any($1::uuid[]) returning id`,
        [rootIds]
      );
      const threadCount = deleted.length;

      // Direct insert rather than the `audit()` helper: that function takes a
      // `Caller`, and this runs from a scheduled job with no signed-in actor --
      // the same reason refresh-geocodes.ts writes no audit row at all. This one
      // does anyway, as a deliberate exception: a silent, irreversible bulk
      // delete is exactly the kind of change an administrator would otherwise
      // have no way to learn happened. `actor_app_user_id` stays null.
      try {
        await tx.query(
          `insert into audit_log (organization_id, actor_app_user_id, action, entity_type, entity_id, changes)
           values ($1, null, 'group.post.expire', 'group', null, $2)`,
          [
            organizationId,
            JSON.stringify({ posts: threadCount, attachments: attachmentRows.length, bytes }),
          ]
        );
      } catch (err) {
        console.error("Failed to write group.post.expire audit entry", organizationId, err);
      }

      byOrganization.set(organizationId, {
        posts: threadCount,
        attachments: attachmentRows.length,
        bytes,
      });
    });
  }

  // After every transaction has committed, and best-effort -- the same
  // ordering `pushToNotified` uses and for the same reason: a rollback cannot
  // un-delete an S3 object, so the database rows are the one thing that must
  // commit first.
  for (const attachment of allAttachments) {
    if (attachment.kind === "IMAGE") {
      await deletePhoto(attachment.photo_key);
    } else {
      await deleteGroupAttachmentFile(attachment.photo_key);
    }
  }

  return { byOrganization };
}
