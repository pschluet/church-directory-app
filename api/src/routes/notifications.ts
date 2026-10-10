import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { audit } from "../audit";
import { loadInbox, markAllRead } from "../services/notifications";
import { HTTPException } from "hono/http-exception";
import {
  groupNotificationPrefUpdateSchema,
  notificationPreferencesSchema,
  uuidSchema,
  type GroupNotificationExceptionDto,
  type GroupNotificationPref,
  type InboxDto,
  type NotificationPreferencesDto,
} from "../types";
import { one, type Queryable } from "../db";
import { loadGroupExceptions, setGroupNotificationPref } from "../services/group-notifications";

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
 *
 * Not audited. It is a read receipt, not a change -- nothing any other member
 * can see is different afterwards, and it fires every time the bell is opened.
 */
routes.post("/read", async (c) => {
  const caller = c.get("caller");
  const cleared = await markAllRead(c.get("db"), caller.appUserId);
  return c.json({ cleared });
});

interface PreferenceRow {
  prayer_requests: boolean;
  prayer_request_reviews: boolean;
  group_notification_pref: GroupNotificationPref;
}

/** No row means every default is on, which is why nothing needed backfilling. */
function toSwitches(
  row: PreferenceRow | null
): Pick<
  NotificationPreferencesDto,
  "prayerRequests" | "prayerRequestReviews" | "groupNotificationPref"
> {
  return {
    prayerRequests: row?.prayer_requests ?? true,
    prayerRequestReviews: row?.prayer_request_reviews ?? true,
    groupNotificationPref: row?.group_notification_pref ?? "ALL",
  };
}

function toPreferences(
  row: PreferenceRow | null,
  groupExceptions: GroupNotificationExceptionDto[]
): NotificationPreferencesDto {
  return { ...toSwitches(row), groupExceptions };
}

const PREFERENCE_COLUMNS = "prayer_requests, prayer_request_reviews, group_notification_pref";

async function loadPreferences(
  db: Queryable,
  appUserId: string
): Promise<NotificationPreferencesDto> {
  const row = await one<PreferenceRow>(
    db,
    `select ${PREFERENCE_COLUMNS} from notification_preferences where app_user_id = $1`,
    [appUserId]
  );
  return toPreferences(row, await loadGroupExceptions(db, appUserId));
}

routes.get("/preferences", async (c) => {
  const caller = c.get("caller");
  return c.json(await loadPreferences(c.get("db"), caller.appUserId));
});

routes.put("/preferences", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = notificationPreferencesSchema.parse(await c.req.json());

  /*
   * `coalesce` throughout, so a payload naming one switch leaves the others
   * exactly as they were -- the settings page sends only what the member just
   * touched, and an absent field must not be read as "off".
   */
  const row = await one<PreferenceRow>(
    db,
    `insert into notification_preferences
            (app_user_id, prayer_requests, prayer_request_reviews, group_notification_pref)
     values ($1, coalesce($2, true), coalesce($3, true), coalesce($4, 'ALL'))
     on conflict (app_user_id) do update
        set prayer_requests = coalesce($2, notification_preferences.prayer_requests),
            prayer_request_reviews =
              coalesce($3, notification_preferences.prayer_request_reviews),
            group_notification_pref =
              coalesce($4, notification_preferences.group_notification_pref)
     returning ${PREFERENCE_COLUMNS}`,
    [
      caller.appUserId,
      payload.prayerRequests ?? null,
      payload.prayerRequestReviews ?? null,
      payload.groupNotificationPref ?? null,
    ]
  );

  // Recorded from what the upsert returned, not what was sent: the `coalesce`
  // above means a payload naming one switch leaves the others untouched, and
  // the row says what the preferences now are rather than what was typed. Only
  // the switches -- the per-group exceptions are changed through their own
  // routes below and are not part of this change.
  await audit(db, caller, {
    action: "user.changeNotifications",
    entityType: "appUser",
    entityId: caller.appUserId,
    changes: toSwitches(row),
  });

  return c.json(toPreferences(row, await loadGroupExceptions(db, caller.appUserId)));
});

/*
 * A group's exception, from the Settings page. Account-scoped like everything
 * else here, and deliberately not the organization-scoped
 * `/groups/:id/notification-preference`: this list spans parishes (a super admin
 * can belong to groups in several), and that route would 404 for a group outside
 * the active one. Not audited, matching the group route -- it is the member's
 * own volume knob.
 */
routes.put("/group-preferences/:groupId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const groupId = uuidSchema.parse(c.req.param("groupId"));
  const { notificationPref } = groupNotificationPrefUpdateSchema.parse(await c.req.json());
  if (!(await setGroupNotificationPref(db, caller.appUserId, groupId, notificationPref))) {
    throw new HTTPException(403, { message: "You are not a member of this group" });
  }
  return c.json(await loadPreferences(db, caller.appUserId));
});

routes.delete("/group-preferences/:groupId", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const groupId = uuidSchema.parse(c.req.param("groupId"));
  if (!(await setGroupNotificationPref(db, caller.appUserId, groupId, null))) {
    throw new HTTPException(403, { message: "You are not a member of this group" });
  }
  return c.json(await loadPreferences(db, caller.appUserId));
});

export default routes;
