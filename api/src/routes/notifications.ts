import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { loadInbox, markAllRead } from "../services/notifications";
import { notificationPreferencesSchema, type InboxDto } from "../types";
import { one } from "../db";
import type { NotificationPreferencesDto } from "../types";

/**
 * The notification bell, and the preferences that decide what lands in it.
 *
 * Not scoped by the active organization, unlike almost everything else here:
 * notifications belong to an account, and the only account that can act outside
 * its own parish is a super admin, whose notifications still come from their
 * home one. Scoping the read by `?orgId=` would hide their own badge from them
 * whenever they were looking at another parish.
 */
const routes = new Hono<AppEnv>();

routes.get("/", async (c) => {
  const caller = c.get("caller");
  const body: InboxDto = await loadInbox(c.get("db"), caller.appUserId);
  return c.json(body);
});

/**
 * "When the notifications are viewed, the badge should go away."
 *
 * Everything unread at once rather than per notification: the badge is a count
 * of things not yet looked at, and opening the panel is looking at them.
 */
routes.post("/read", async (c) => {
  const caller = c.get("caller");
  const cleared = await markAllRead(c.get("db"), caller.appUserId);
  return c.json({ cleared });
});

interface PreferenceRow {
  prayer_requests: boolean;
  prayer_request_reviews: boolean;
}

/** No row means every default is on, which is why nothing needed backfilling. */
function toPreferences(row: PreferenceRow | null): NotificationPreferencesDto {
  return {
    prayerRequests: row?.prayer_requests ?? true,
    prayerRequestReviews: row?.prayer_request_reviews ?? true,
  };
}

routes.get("/preferences", async (c) => {
  const caller = c.get("caller");
  const row = await one<PreferenceRow>(
    c.get("db"),
    `select prayer_requests, prayer_request_reviews
       from notification_preferences where app_user_id = $1`,
    [caller.appUserId]
  );
  return c.json(toPreferences(row));
});

routes.put("/preferences", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = notificationPreferencesSchema.parse(await c.req.json());

  /*
   * `coalesce` twice over, so a payload naming one switch leaves the other
   * exactly as it was -- the settings page sends only what the member just
   * touched, and an absent field must not be read as "off".
   */
  const row = await one<PreferenceRow>(
    db,
    `insert into notification_preferences (app_user_id, prayer_requests, prayer_request_reviews)
     values ($1, coalesce($2, true), coalesce($3, true))
     on conflict (app_user_id) do update
        set prayer_requests = coalesce($2, notification_preferences.prayer_requests),
            prayer_request_reviews =
              coalesce($3, notification_preferences.prayer_request_reviews)
     returning prayer_requests, prayer_request_reviews`,
    [caller.appUserId, payload.prayerRequests ?? null, payload.prayerRequestReviews ?? null]
  );

  return c.json(toPreferences(row));
});

export default routes;
