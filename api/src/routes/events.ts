import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth";
import { one } from "../db";
import type { EventTokenTargetDto } from "../types";

/**
 * Resolves an event share token for a signed-in reader, so /e/<token> can send
 * them to /groups/<groupId>/events/<postId>.
 *
 * Deliberately a lookup and not a gate. It does not call `groupAccess`, does
 * not filter by organization, and answers whatever the public-RSVP flag says:
 * the page it hands off to fetches GET /groups/:id/posts/:postId, which already
 * enforces both the caller's organization and the group's read rules. A second
 * copy of that check here would be two places deciding one question. It hands
 * back two ids and nothing else -- no title, no group name -- so resolving a
 * token teaches the caller nothing that the next request would not refuse.
 *
 * Mounted at /api/events rather than under /api/groups so the guidelines
 * middleware does not gate it: somebody who has not agreed yet should be sent
 * on to the event, where GroupGuidelinesGate asks them properly, rather than
 * see the link fail.
 */
const routes = new Hono<AppEnv>();

routes.get("/by-token/:token", async (c) => {
  const row = await one<EventTokenTargetDto>(
    c.get("db"),
    `select p.group_id as "groupId", ge.post_id as "postId"
       from group_events ge
       join group_posts p on p.id = ge.post_id
      where ge.share_token = $1`,
    [c.req.param("token")]
  );
  if (!row) throw new HTTPException(404, { message: "That event link is not valid" });
  return c.json(row);
});

export default routes;
