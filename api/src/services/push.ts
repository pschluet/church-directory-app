import webpush, { WebPushError } from "web-push";
import type { Queryable } from "../db";

/**
 * Web Push.
 *
 * The one piece of this app that talks to a third party from inside the VPC,
 * which is worth spelling out because that VPC has no NAT gateway: its only
 * route out is IPv6 through an egress-only internet gateway (see the networking
 * comment in infra/lib/church-directory-stack.ts). All three push services --
 * `web.push.apple.com`, `fcm.googleapis.com` and
 * `updates.push.services.mozilla.com` -- publish AAAA records, so this reaches
 * them over IPv6 with no endpoint override and nothing to pay. `api/src/api.ts`
 * already sets `ipv6first` in Lambda, which applies here too: the A route goes
 * nowhere, and without that ordering every send would wait on Happy Eyeballs
 * timing the IPv4 attempt out.
 *
 * The VAPID private key arrives in a KMS-encrypted environment variable rather
 * than from Secrets Manager, for the same reason as CLOUDFRONT_PRIVATE_KEY:
 * both of those services are unreachable from here, and the Lambda runtime
 * decrypts an environment variable with no network call at all.
 *
 * PUSH_MODE=local turns sending into a no-op so the app runs end to end on a
 * laptop with no keys -- the same shape as PHOTO_STORAGE=local.
 */

const MODE = (process.env.PUSH_MODE ?? "web-push") as "web-push" | "local";
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const SUBJECT = process.env.VAPID_SUBJECT ?? "";

/**
 * How many sends are in flight at once.
 *
 * The fan-out is one HTTPS POST per device, and a parish is a few hundred of
 * them. Unbounded `Promise.all` would open every socket at the same moment --
 * from a Lambda with 512MB and a 20s timeout, against services that rate-limit.
 * Eight keeps the whole batch well inside the timeout while leaving the
 * function's memory and file descriptors alone.
 */
const SEND_CONCURRENCY = 8;

/**
 * Whether push is configured at all. Read rather than asserted, because a
 * parish running without keys should still be able to post prayer requests --
 * they simply arrive without a notification.
 */
export function isPushConfigured(): boolean {
  if (MODE === "local") return false;
  return Boolean(PUBLIC_KEY && PRIVATE_KEY && SUBJECT);
}

/** The key the browser needs to subscribe. Null when push is not configured. */
export function pushPublicKey(): string | null {
  return isPushConfigured() ? PUBLIC_KEY : null;
}

/**
 * Fails at start-up rather than at the first send, for the reason
 * `assertPhotoCookieConfig` does: a half-configured deployment is silent. A
 * push that never goes out leaves nothing on any screen and nothing in the
 * logs, so somebody would find out weeks later when a member asked why they
 * never hear about anything.
 *
 * Only a *partial* configuration is an error. All three unset is the local and
 * the not-yet-set-up case, and both are allowed.
 */
export function assertPushConfig(): void {
  if (MODE === "local") return;
  const entries: [string, string][] = [
    ["VAPID_PUBLIC_KEY", PUBLIC_KEY],
    ["VAPID_PRIVATE_KEY", PRIVATE_KEY],
    ["VAPID_SUBJECT", SUBJECT],
  ];
  const missing = entries.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0 && missing.length < entries.length) {
    throw new Error(
      `Web Push is half-configured: ${missing.join(", ")} must be set alongside the others`
    );
  }
}

let configured = false;
function configure(): void {
  if (configured) return;
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap lands. Read by the `notificationclick` handler in app/src/sw.ts. */
  url: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Sends one payload per recipient to every device that recipient has.
 *
 * Per recipient, because the body is a count of *their* unread requests -- "3
 * new prayer requests" means three they have not read, which is a different
 * number for everyone.
 *
 * Nothing here throws. A push that fails must not fail the approval that
 * triggered it: the request is posted either way, the in-app bell has already
 * been updated in the same transaction, and the notification is the
 * best-effort half. Same trade-off as `audit`.
 *
 * A 404 or 410 from a push service means the subscription is gone for good --
 * the app was uninstalled, or the browser dropped it. Those rows are deleted,
 * which is also how the table cleans itself up after a VAPID key rotation.
 */
export async function sendToUsers(
  q: Queryable,
  payloads: Map<string, PushPayload>
): Promise<{ sent: number; failed: number; pruned: number }> {
  const result = { sent: 0, failed: 0, pruned: 0 };
  if (!isPushConfigured() || payloads.size === 0) return result;

  const { rows } = await q.query<SubscriptionRow & { app_user_id: string }>(
    `select id, app_user_id, endpoint, p256dh, auth
       from push_subscriptions
      where app_user_id = any($1::uuid[])`,
    [[...payloads.keys()]]
  );
  if (rows.length === 0) return result;

  configure();

  const dead: string[] = [];
  for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
    const batch = rows.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const payload = payloads.get(row.app_user_id);
        if (!payload) return;
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify(payload)
          );
          result.sent += 1;
        } catch (err) {
          if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            dead.push(row.id);
          } else {
            result.failed += 1;
            console.error("Push send failed", row.endpoint, err);
          }
        }
      })
    );
  }

  if (dead.length > 0) {
    try {
      await q.query("delete from push_subscriptions where id = any($1::uuid[])", [dead]);
      result.pruned = dead.length;
    } catch (err) {
      // A subscription that could not be pruned is retried next time; it must
      // not turn into a failed approval either.
      console.error("Failed to prune dead push subscriptions", err);
    }
  }

  return result;
}
