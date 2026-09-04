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

routes.get("/preferences", async (c) => {
  const caller = c.get("caller");
  const row = await one<{ prayer_requests: boolean }>(
    c.get("db"),
    "select prayer_requests from notification_preferences where app_user_id = $1",
    [caller.appUserId]
  );
  // No row means every default is on, which is why nothing had to be
  // backfilled when the table arrived.
  const body: NotificationPreferencesDto = { prayerRequests: row?.prayer_requests ?? true };
  return c.json(body);
});

routes.put("/preferences", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = notificationPreferencesSchema.parse(await c.req.json());

  const row = await one<{ prayer_requests: boolean }>(
    db,
    `insert into notification_preferences (app_user_id, prayer_requests)
     values ($1, coalesce($2, true))
     on conflict (app_user_id) do update
        set prayer_requests = coalesce($2, notification_preferences.prayer_requests)
     returning prayer_requests`,
    [caller.appUserId, payload.prayerRequests ?? null]
  );

  const body: NotificationPreferencesDto = { prayerRequests: row!.prayer_requests };
  return c.json(body);
});

export default routes;
