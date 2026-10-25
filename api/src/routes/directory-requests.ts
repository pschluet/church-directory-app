import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { one, type Queryable } from "../db";
import { fanOutDirectoryRequest, unreadNotificationCounts } from "../services/notifications";
import { sendToUsers, type PushPayload } from "../services/push";
import { directoryRequestSchema, type DirectoryRequestChurchDto } from "../types";

/**
 * "Request to be added", from the sign-in page -- the only routes anybody can
 * call without signing in apart from the health check. Both are listed in
 * PUBLIC_PATHS in api.ts and opted out of the authorizer in
 * infra/lib/church-directory-stack.ts; there is no `caller` on either.
 *
 * Built to tell an anonymous visitor nothing. The submit answers 202 whether
 * the request was stored, was a duplicate, was for an address that already has
 * an account, or tripped the honeypot -- otherwise this form would be a way to
 * check whether somebody is in a parish's directory. The administrators are
 * the ones who find out what it was.
 *
 * Not audited: `audit()` records a `Caller`, and there is none. The request row
 * is its own record, and approving or declining it is audited.
 *
 * The admin half -- listing, approving, declining -- is in routes/admin.ts.
 */
const routes = new Hono<AppEnv>();

/** Names only: this is readable by anyone on the internet. */
routes.get("/churches", async (c) => {
  const { rows } = await c
    .get("db")
    .query<DirectoryRequestChurchDto>("select id, name from organizations order by name");
  return c.json({ churches: rows });
});

const ACCEPTED = { ok: true } as const;

routes.post("/", async (c) => {
  const db = c.get("db");
  const payload = directoryRequestSchema.parse(await c.req.json());

  // Hidden from people, so only a script fills it in. Answered the same as a
  // real request so the script has nothing to learn from.
  if (payload.website) return c.json(ACCEPTED, 202);

  const org = await one<{ id: string }>(db, "select id from organizations where id = $1", [
    payload.organizationId,
  ]);
  // The one answer that is not 202: the picker only offers real churches, so
  // this is a stale page or a hand-written request, and saying so leaks
  // nothing that GET /churches does not already publish.
  if (!org) return c.json({ error: "Choose a church from the list" }, 400);

  await submitDirectoryRequest(db, { ...payload, organizationId: org.id });
  return c.json(ACCEPTED, 202);
});

/**
 * Files a request to be added to a parish's directory and tells its
 * administrators. Shared with the event share page's "Request to join"
 * (routes/public.ts), so both land in the one queue on People & Accounts.
 *
 * Says nothing about what happened, on purpose: a duplicate, an address that
 * already has an account and a new request all look the same to the caller.
 */
export async function submitDirectoryRequest(
  db: Queryable,
  request: { organizationId: string; firstName: string; lastName: string; email: string }
): Promise<void> {
  // Someone who can already sign in does not need an administrator's time.
  const existing = await one<{ id: string }>(db, "select id from app_users where email = $1", [
    request.email,
  ]);
  if (existing) return;

  const notified = await db.transaction(async (tx) => {
    // `on conflict do nothing` against directory_requests_one_pending_idx: a
    // second submission while the first is waiting is the same request.
    const created = await one<{ id: string }>(
      tx,
      `insert into directory_requests (organization_id, first_name, last_name, email)
       values ($1, $2, $3, $4)
       on conflict (organization_id, email) where status = 'PENDING' do nothing
       returning id`,
      [request.organizationId, request.firstName, request.lastName, request.email]
    );
    if (!created) return [];
    return fanOutDirectoryRequest(tx, {
      directoryRequestId: created.id,
      organizationId: request.organizationId,
    });
  });

  // After the commit, so a failed push never rolls back the request itself.
  await pushDirectoryRequest(db, notified);
}

/**
 * A count, never the name: a lock screen is not where somebody's request to
 * join should be legible, the same restraint the prayer request push shows.
 */
async function pushDirectoryRequest(db: Queryable, notified: string[]): Promise<void> {
  if (notified.length === 0) return;
  const counts = await unreadNotificationCounts(db, notified, "DIRECTORY_REQUEST");
  const payloads = new Map<string, PushPayload>(
    notified.map((appUserId) => {
      const count = counts.get(appUserId) ?? 1;
      return [
        appUserId,
        {
          title: "Directory Requests",
          body:
            count === 1
              ? "Someone asked to be added to the directory"
              : `${count} people asked to be added to the directory`,
          url: "/admin/users",
          tag: "directory-requests",
        },
      ];
    })
  );
  await sendToUsers(db, payloads);
}

export default routes;
