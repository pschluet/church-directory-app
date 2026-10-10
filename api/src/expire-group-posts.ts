import { db } from "./db";
import { expireGroupPosts, type ExpireGroupPostsResult } from "./services/group-retention";

/**
 * The daily retention purge for group posts -- see services/group-retention.ts
 * for the rule itself (five years, measured per-thread) and
 * requirements/groups.md's Retention section for why it exists.
 *
 * A separate function from the API for the same reason refresh-geocodes.ts is:
 * the API sits behind a JWT authorizer with no claims for EventBridge to
 * present, and this needs no request/response shape at all. Same subnets, same
 * security group, same database grant as refresh-geocodes.ts -- the only new
 * permission this function needs is `s3:DeleteObject` on the photos bucket, for
 * the attachments it purges alongside the rows.
 *
 * Invoked daily with no payload. Nothing reads the return value of a scheduled
 * invocation -- CloudWatch is the only place a run is ever looked at -- so this
 * logs the summary as well as returning it.
 */
export async function handler(): Promise<
  Record<string, { posts: number; attachments: number; bytes: number }>
> {
  const result: ExpireGroupPostsResult = await expireGroupPosts(db, { now: new Date() });
  const summary = Object.fromEntries(result.byOrganization);
  console.log("Group post retention finished", summary);
  return summary;
}
