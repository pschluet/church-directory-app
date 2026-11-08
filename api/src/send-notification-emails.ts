import { db } from "./db";
import { sendPendingEmails, type SendResult } from "./services/notification-email";

/**
 * The notification email sender -- see services/notification-email.ts for what
 * is sent to whom, and when.
 *
 * A separate function from the API for the same reason expire-group-posts.ts
 * is: it is invoked by an EventBridge schedule, every minute, with no request
 * to answer. Same subnets, security group and database grant as the API; the
 * one extra permission is `ses:SendEmail`, which the API already has for
 * invitations.
 *
 * Reserved concurrency is one (see the stack), so a slow run is never
 * overlapped by the next -- which is half of what keeps a notification from
 * being mailed twice. The other half is stamping each row once its email is
 * accepted.
 */

const SITE_URL = process.env.SITE_URL ?? "";

/** Stop starting sends this long after starting, well inside the 2-minute timeout. */
const RUN_BUDGET_MS = 75_000;

export async function handler(): Promise<SendResult> {
  const result = await sendPendingEmails(db, {
    now: new Date(),
    siteUrl: SITE_URL,
    deadline: Date.now() + RUN_BUDGET_MS,
  });
  // Quiet when there was nothing to do: this runs 1,440 times a day.
  if (result.sent || result.failed || result.deferred) {
    console.log("Notification emails", result);
  }
  return result;
}
