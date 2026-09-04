import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, requireRole, type AppEnv } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { deletePhoto, prayerRequestImagePrefix } from "../photos";
import { fanOutPrayerRequest, unreadPrayerRequestCounts } from "../services/notifications";
import { sendToUsers, type PushPayload } from "../services/push";
import {
  PRAYER_REQUEST_SELECT,
  PRAYER_REQUEST_WINDOW,
  canDeletePrayerRequest,
  loadPrayerRequestRow,
  toPrayerRequest,
  type PrayerRequestRow,
} from "../services/prayer-requests";
import {
  prayerRequestCreateSchema,
  prayerRequestRejectSchema,
  uuidSchema,
  type PrayerRequestDto,
} from "../types";

/**
 * Prayer requests: writing one, reviewing one, and reading the page.
 *
 * Everything a member may see comes from `GET /` -- the posted requests plus
 * their own, in one response with per-row capability flags -- so the page needs
 * one query rather than three, and a member who is also a reviewer sees their
 * queue without a second round trip. `services/prayer-requests.ts` owns the
 * visibility rules; this file is about who may act.
 */
const routes = new Hono<AppEnv>();

/**
 * The push half of posting a request, for everyone the bell fan-out just told.
 *
 * Runs after the transaction has committed, deliberately. Inside it, this would
 * hold a database connection open across a few hundred HTTPS requests, and a
 * rollback could not un-send a notification anyway. So the durable half -- the
 * status change and the bell rows -- commits first, and this is the
 * best-effort half: `sendToUsers` swallows every failure, so a slow or
 * unreachable push service cannot turn a successful post into a 500 that
 * somebody retries.
 */
async function pushToNotified(db: Queryable, notified: string[]): Promise<void> {
  if (notified.length === 0) return;

  const counts = await unreadPrayerRequestCounts(db, notified);
  const payloads = new Map<string, PushPayload>(
    notified.map((appUserId) => {
      // At least one: the fan-out just inserted their row, so a zero here would
      // mean the count query and the insert disagree.
      const count = counts.get(appUserId) ?? 1;
      return [
        appUserId,
        {
          // Deliberately just the number, per the requirement -- a prayer
          // request can name somebody's illness, and a lock screen is not where
          // that should be legible to whoever picks the phone up.
          title: "Parish Directory",
          body: `${count} new prayer request${count === 1 ? "" : "s"}`,
          url: "/prayer-requests",
        },
      ];
    })
  );
  await sendToUsers(db, payloads);
}

/**
 * The page: approved requests from the last month, plus every request of the
 * caller's own whatever its status.
 *
 * Two lists in one query rather than two endpoints, because they are the same
 * rows with different reasons for being visible, and the SPA splits them on
 * `isMine` anyway. Ordered by `posted_at desc` with the caller's unposted rows
 * first: `posted_at` is null until approval, and `nulls first` on a descending
 * sort puts "waiting on a reviewer" at the top, which is where the author wants
 * to see it.
 */
routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = await db.query<PrayerRequestRow>(
    `${PRAYER_REQUEST_SELECT}
      where pr.organization_id = $1
        and (
          (pr.status = 'APPROVED' and pr.posted_at > now() - interval '${PRAYER_REQUEST_WINDOW}')
          or pr.author_person_id = $2::uuid
        )
      order by pr.posted_at desc nulls first, pr.submitted_at desc`,
    [organizationId, caller.personId]
  );

  return c.json({ prayerRequests: rows.map((row) => toPrayerRequest(row, caller)) });
});

/**
 * The review queue. Oldest first, so nothing waits behind a later submission.
 *
 * A separate endpoint from `GET /` even though a reviewer could filter that
 * response, because a reviewer's own pending request is in both and the queue
 * is the one place it must not be actionable by them.
 */
routes.get("/pending", requireRole("PRAYER_REQUEST_ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const { rows } = await db.query<PrayerRequestRow>(
    `${PRAYER_REQUEST_SELECT}
      where pr.organization_id = $1 and pr.status = 'PENDING'
      order by pr.submitted_at`,
    [organizationId]
  );

  return c.json({ prayerRequests: rows.map((row) => toPrayerRequest(row, caller)) });
});

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = prayerRequestCreateSchema.parse(await c.req.json());

  if (!caller.personId) {
    throw new HTTPException(400, { message: "Your own directory record is missing" });
  }

  // Every attached key must be one this caller was given by
  // POST /uploads/prayer-request-image. Without this, a key from another
  // member's upload -- or from another parish -- could be attached here and
  // the image would then be served to the whole parish under this request.
  const prefix = prayerRequestImagePrefix(organizationId, caller.personId);
  for (const image of payload.images) {
    if (!image.photoKey.startsWith(prefix)) {
      throw new HTTPException(400, { message: "That photo does not belong to this request" });
    }
  }

  /*
   * A reviewer's own request needs no review: they are the person who would
   * approve it, so routing it through PENDING would only ask them to press a
   * second button on their own words. The same reasoning as an admin's merge
   * request in routes/merges.ts, which merges on the spot rather than waiting
   * for permission the caller already has.
   *
   * The row is written APPROVED with its timestamps in one go, so it never
   * exists in a state where a CHECK constraint would object and never appears
   * in anyone's review queue.
   */
  const postDirectly = caller.canApprovePrayerRequests;
  let notified: string[] = [];

  const created = await db.transaction(async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      `insert into prayer_requests
         (organization_id, author_person_id, title, body,
          status, posted_at, decided_at, decided_by_person_id)
       values ($1, $2, $3, $4,
               case when $5 then 'APPROVED' else 'PENDING' end,
               case when $5 then now() end,
               case when $5 then now() end,
               case when $5 then $2::uuid end)
       returning id`,
      [organizationId, caller.personId, payload.title, payload.body, postDirectly]
    );
    const id = row!.id;

    // One statement for all of them, with the array index as the position, so
    // the order the author arranged them in is the order everyone reads.
    if (payload.images.length > 0) {
      await tx.query(
        `insert into prayer_request_images (prayer_request_id, photo_key, width, height, position)
         select $1, key, width, height, position - 1
           from unnest($2::text[], $3::int[], $4::int[])
                with ordinality as t(key, width, height, position)`,
        [
          id,
          payload.images.map((image) => image.photoKey),
          payload.images.map((image) => image.width),
          payload.images.map((image) => image.height),
        ]
      );
    }

    // In the same transaction as the insert, for the same reason the approval
    // path does it: a posted request nobody was told about is indistinguishable
    // from one nobody has approved yet, and there is no second signal to
    // reconcile the two from later.
    if (postDirectly) {
      notified = await fanOutPrayerRequest(tx, {
        prayerRequestId: id,
        organizationId,
        actingPersonId: caller.personId,
      });
    }

    return id;
  });

  await audit(db, caller, {
    action: postDirectly ? "prayerRequest.post" : "prayerRequest.create",
    entityType: "prayerRequest",
    entityId: created,
    changes: { title: payload.title, images: payload.images.length },
  });

  await pushToNotified(db, notified);

  const row = await loadPrayerRequestRow(db, created, organizationId);
  const body: PrayerRequestDto = toPrayerRequest(row!, caller);
  return c.json(body, 201);
});

/**
 * Approve or reject, in one handler -- the same shape as the merge decision in
 * routes/merges.ts, because the two differ only in what approval does.
 *
 * Approving stamps `posted_at`, which is what makes the request visible and
 * where it sorts. A CHECK constraint ties the two together, so an approval that
 * somehow forgot the timestamp fails loudly rather than posting a request that
 * sits at the top of the page forever.
 */
routes.post("/:id/:decision{approve|reject}", requireRole("PRAYER_REQUEST_ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const approve = c.req.param("decision") === "approve";
  const payload = approve
    ? { reason: null }
    : prayerRequestRejectSchema.parse(await c.req.json().catch(() => ({})));

  const request = await loadPrayerRequestRow(db, id, organizationId);
  if (!request) throw new HTTPException(404, { message: "Prayer request not found" });
  if (request.status !== "PENDING") {
    throw new HTTPException(409, { message: "That request has already been reviewed" });
  }

  let notified: string[] = [];

  // The decision and the fan-out in one transaction, as on the create path.
  await db.transaction(async (tx) => {
    await tx.query(
      `update prayer_requests
          set status = $2,
              posted_at = case when $2 = 'APPROVED' then now() else null end,
              rejection_reason = $3,
              decided_at = now(),
              decided_by_person_id = $4
        where id = $1 and status = 'PENDING'`,
      [
        id,
        approve ? "APPROVED" : "REJECTED",
        approve ? null : (payload.reason ?? null),
        caller.personId,
      ]
    );

    if (approve) {
      // The author is included, and that is the point: being told your request
      // is now up is the most useful notification this app sends.
      notified = await fanOutPrayerRequest(tx, {
        prayerRequestId: id,
        organizationId,
        actingPersonId: caller.personId,
      });
    }
  });

  await pushToNotified(db, notified);

  await audit(db, caller, {
    action: approve ? "prayerRequest.approve" : "prayerRequest.reject",
    entityType: "prayerRequest",
    entityId: id,
    changes: { title: request.title, ...(approve ? {} : { reason: payload.reason ?? null }) },
  });

  const updated = await loadPrayerRequestRow(db, id, organizationId);
  return c.json(toPrayerRequest(updated!, caller));
});

/**
 * Withdrawing a request. The author may do this at any point; an admin may do
 * it to any of them.
 *
 * A hard delete, unlike a person: a prayer request is a short-lived message
 * that already disappears from the page after a month, and an author who asks
 * for it to be taken down means taken down. The image rows go with it through
 * the FK cascade, and their bytes through `deletePhoto`.
 */
routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const request = await loadPrayerRequestRow(db, id, organizationId);
  if (!request) throw new HTTPException(404, { message: "Prayer request not found" });
  if (!canDeletePrayerRequest(caller, request)) {
    throw new HTTPException(403, { message: "That request is not yours to remove" });
  }

  await db.query("delete from prayer_requests where id = $1", [id]);

  await audit(db, caller, {
    action: "prayerRequest.delete",
    entityType: "prayerRequest",
    entityId: id,
    changes: { title: request.title },
  });

  // After the row is gone, and best-effort: an S3 failure must not leave the
  // request undeletable. The same trade-off deletePhoto already makes for a
  // replaced person photo.
  for (const image of request.images ?? []) {
    await deletePhoto(image.photo_key);
  }

  return c.body(null, 204);
});

export default routes;
