import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv } from "../auth";
import { pushSubscribeSchema, pushUnsubscribeSchema, type PushSubscriptionDto } from "../types";

/**
 * Registering a browser for Web Push, and unregistering it.
 *
 * One row per device rather than per person -- see V10__push_subscriptions.sql.
 * The SPA re-subscribes on every load, so `POST` is an upsert on the endpoint
 * rather than a create: the browser normally hands back the identical
 * subscription, and a shared phone signed into a second account presents the
 * same endpoint under a different owner, where the row should move to whoever
 * is signed in now.
 */
const routes = new Hono<AppEnv>();

routes.post("/subscriptions", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = pushSubscribeSchema.parse(await c.req.json());

  await db.query(
    `insert into push_subscriptions
       (app_user_id, organization_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update
        set app_user_id = $1,
            organization_id = $2,
            p256dh = $4,
            auth = $5,
            user_agent = $6,
            last_seen_at = now()`,
    [
      caller.appUserId,
      organizationId,
      payload.endpoint,
      payload.keys.p256dh,
      payload.keys.auth,
      // Whatever the browser says, truncated: this is a label on the settings
      // page, not a decision input, and some of them are very long.
      c.req.header("user-agent")?.slice(0, 400) ?? null,
    ]
  );

  const body: PushSubscriptionDto = { subscribed: true };
  return c.json(body, 201);
});

/**
 * Takes the way in as a body rather than a path parameter: a push endpoint is a
 * URL, and URL-encoding one into a path is a good way to discover a proxy that
 * decodes it early.
 */
routes.delete("/subscriptions", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = pushUnsubscribeSchema.parse(await c.req.json());

  // Scoped to the caller's own rows, so knowing an endpoint is not enough to
  // silence somebody else's phone.
  const { rows } = await db.query<{ id: string }>(
    "delete from push_subscriptions where app_user_id = $1 and endpoint = $2 returning id",
    [caller.appUserId, payload.endpoint]
  );
  if (rows.length === 0) {
    throw new HTTPException(404, { message: "That device is not registered" });
  }

  const body: PushSubscriptionDto = { subscribed: false };
  return c.json(body);
});

export default routes;
