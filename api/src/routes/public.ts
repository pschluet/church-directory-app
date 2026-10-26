import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth";
import { one, type Queryable } from "../db";
import {
  PUBLIC_RSVP_MAX_PER_EVENT,
  publicEventRsvpSchema,
  publicJoinRequestSchema,
  type GroupVisibility,
  type PublicEventDto,
} from "../types";
import { submitDirectoryRequest } from "./directory-requests";

/**
 * An event's public share page -- /e/<token> in the SPA, for somebody with no
 * session. Every route here is listed in PUBLIC_PREFIXES in api.ts and opted
 * out of the authorizer in infra/lib/church-directory-stack.ts. There is no
 * `caller`: the share token is the only authorization, and the organization
 * always comes out of the event's row, never the request.
 *
 * All three answer only for an event whose organizer ticked "Allow Public
 * RSVP". Otherwise they 404 -- the same 404, byte for byte, as a token nobody
 * ever issued -- so a valid link to a private event cannot be told apart from
 * a made-up one. 404 and never 403: a page that was never opened to the public
 * should not confirm the event exists.
 *
 * Signed-in readers do not come through here at all. The SPA resolves the
 * token with /api/events/by-token (routes/events.ts) and sends them into the
 * app, where the group's own access rules apply.
 *
 * Not audited: `audit()` records a `Caller`, and there is none. The RSVP and
 * request rows are their own record; removing an RSVP is audited.
 */
const routes = new Hono<AppEnv>();

interface PublicEventRow {
  post_id: string;
  title: string;
  description: string | null;
  event_date: Date | string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  deleted_at: Date | string | null;
  public_rsvp_enabled: boolean;
  organization_id: string;
  organization_name: string;
  group_title: string;
  group_visibility: GroupVisibility;
  /** Whether the event's day is over everywhere on earth -- see the query. */
  is_past: boolean;
  rsvp_yes: number;
  rsvp_no: number;
  rsvp_maybe: number;
  attending: number;
}

const NOT_FOUND = "Not found";

/**
 * The guard every route here shares, so none of them can forget it: an
 * unknown token and an event that is not public are the same 404.
 */
async function loadPublicEvent(db: Queryable, token: string): Promise<PublicEventRow> {
  // ULIDs are 26 characters and the backfilled tokens 32; anything far off
  // that is not worth a query.
  if (token.length < 16 || token.length > 64) throw new HTTPException(404, { message: NOT_FOUND });

  const row = await one<PublicEventRow>(
    db,
    `select ge.post_id,
            ge.title,
            ge.description,
            ge.event_date,
            ge.start_time,
            ge.end_time,
            ge.location,
            p.deleted_at,
            ge.public_rsvp_enabled,
            g.organization_id,
            o.name as organization_name,
            g.title as group_title,
            g.visibility as group_visibility,
            -- event_date is the parish's own naive local date, and there is no
            -- timezone to read it in (V16__groups.sql). So "past" is judged
            -- generously: only once that date is over in UTC-12, the last
            -- place on earth for any date to end. A late RSVP is harmless; a
            -- refused one on the evening of the event is not.
            ge.event_date < (now() at time zone 'UTC' - interval '12 hours')::date as is_past,
            (select count(*) filter (where r.response = 'YES')::int
               from group_event_rsvps r where r.post_id = ge.post_id) as rsvp_yes,
            (select count(*) filter (where r.response = 'NO')::int
               from group_event_rsvps r where r.post_id = ge.post_id) as rsvp_no,
            (select count(*) filter (where r.response = 'MAYBE')::int
               from group_event_rsvps r where r.post_id = ge.post_id) as rsvp_maybe,
            -- Everyone coming, guests included: what a flyer's reader wants
            -- to know, and the roster's "total attending".
            (select coalesce(sum(1 + r.guest_count), 0)::int
               from group_event_rsvps r
              where r.post_id = ge.post_id and r.response = 'YES')
              + (select coalesce(sum(1 + pr.guest_count), 0)::int
                   from group_event_public_rsvps pr where pr.post_id = ge.post_id)
              as attending
       from group_events ge
       join group_posts p on p.id = ge.post_id
       join groups g on g.id = p.group_id
       join organizations o on o.id = g.organization_id
      where ge.share_token = $1`,
    [token]
  );
  // The single most important line in this file: with the checkbox off,
  // nothing about the event reaches an anonymous caller.
  if (!row?.public_rsvp_enabled) throw new HTTPException(404, { message: NOT_FOUND });
  return row;
}

function toIsoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toHm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

/**
 * What the public page shows. No names, ever -- not the members', not other
 * strangers' -- which is exactly what the checkbox's warning promises. No
 * photos either: /photos/* needs signed cookies a visitor does not have.
 */
function toPublicEventDto(row: PublicEventRow): PublicEventDto {
  return {
    title: row.title,
    description: row.description,
    eventDate: toIsoDate(row.event_date),
    startTime: toHm(row.start_time),
    endTime: toHm(row.end_time),
    location: row.location,
    cancelled: row.deleted_at !== null,
    publicRsvpEnabled: row.public_rsvp_enabled,
    organizationName: row.organization_name,
    // A private or secret group's event can be advertised without naming the
    // group it came from; a secret group's existence must not leak at all.
    groupName: row.group_visibility === "PUBLIC" ? row.group_title : null,
    // A headcount is an event detail, and the organizer opted into showing
    // the event's details by ticking the box.
    rsvpCounts: {
      yes: row.rsvp_yes,
      no: row.rsvp_no,
      maybe: row.rsvp_maybe,
      attending: row.attending,
    },
  };
}

routes.get("/events/:token", async (c) => {
  const row = await loadPublicEvent(c.get("db"), c.req.param("token"));
  return c.json(toPublicEventDto(row));
});

/**
 * RSVP without an account. Always "going". A second submission from the same
 * address replaces the first rather than adding to it, which is what lets the
 * one confirmation message be right either way.
 *
 * Nothing is emailed to the address given: an unauthenticated endpoint that
 * sends mail to a caller-supplied address is a spam relay. The page confirms
 * on screen instead.
 */
routes.post("/events/:token/rsvp", async (c) => {
  const db = c.get("db");
  const row = await loadPublicEvent(db, c.req.param("token"));
  const payload = publicEventRsvpSchema.parse(await c.req.json());

  if (row.deleted_at) throw new HTTPException(409, { message: "That event was cancelled" });
  if (row.is_past) throw new HTTPException(409, { message: "That event has already happened" });

  // The cap counts rows, not people: a correction from an address already on
  // the list is always allowed, so an event at the cap can still be fixed.
  const capacity = await one<{ total: number; mine: boolean }>(
    db,
    `select count(*)::int as total, bool_or(email = $2) as mine
       from group_event_public_rsvps where post_id = $1`,
    [row.post_id, payload.email]
  );
  if (capacity && capacity.total >= PUBLIC_RSVP_MAX_PER_EVENT && !capacity.mine) {
    throw new HTTPException(429, { message: "This event is not taking more RSVPs online" });
  }

  await db.query(
    `insert into group_event_public_rsvps (post_id, first_name, last_name, email, guest_count)
     values ($1, $2, $3, $4, $5)
     on conflict (post_id, email) do update
       set first_name = excluded.first_name,
           last_name = excluded.last_name,
           guest_count = excluded.guest_count`,
    [row.post_id, payload.firstName, payload.lastName, payload.email, payload.guestCount]
  );

  // Nothing echoed back: the response must say nothing about anyone else.
  return c.body(null, 204);
});

/**
 * "Request to join" from the share page. Gated on the checkbox like the other
 * two: the option only ever appears on a public page, and an ungated endpoint
 * here would be an anonymous write any valid token could reach, whatever the
 * organizer chose.
 *
 * Lands in the same queue as the sign-in page's "Request to be added", in the
 * event's own parish. 204 whatever happened, so it cannot be used to find out
 * who already asked or who already has an account.
 */
routes.post("/events/:token/join-request", async (c) => {
  const db = c.get("db");
  const row = await loadPublicEvent(db, c.req.param("token"));
  const payload = publicJoinRequestSchema.parse(await c.req.json());

  await submitDirectoryRequest(db, {
    organizationId: row.organization_id,
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
  });

  return c.body(null, 204);
});

export default routes;
