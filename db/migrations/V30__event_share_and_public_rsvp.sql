-- Event share pages and public RSVP.
--
-- Every event gets a share URL, /e/<share_token>, that a bulletin, a QR code or
-- a printed flyer can carry. The SPA routes it by session: a signed-in reader
-- is sent to the event's page inside the app, where the group's own access
-- rules decide what they see; anybody else gets a public page -- but only if
-- the organizer ticked "Allow Public RSVP". With it off, the public endpoint
-- answers 404 exactly as it does for a made-up token.
--
-- These are the first anonymous writes against group data, so the abuse
-- controls live in the schema where they can: one row per address per event,
-- a sane guest count, and the flag defaulting off so nothing already posted
-- becomes publicly writable by deploying this.

-- ---------------------------------------------------------------------------
-- group_events.share_token, group_events.public_rsvp_enabled
--
-- The default exists only to backfill events that predate this migration.
-- gen_random_uuid() is VOLATILE, so adding the column rewrites the table and
-- evaluates it once per row, giving each a distinct value. The API supplies a
-- ULID for every event created from now on (26 characters of uppercase
-- Crockford base32 -- reads back cleanly off paper, and packs into a QR code
-- more densely than mixed case), so two formats coexist on purpose. Both are
-- opaque and unguessable, and nothing parses them.
--
-- The token is never rotated, not even on edit: a printed flyer has to keep
-- working for as long as the event does.
-- ---------------------------------------------------------------------------
alter table group_events
  add column share_token text not null
    default replace(gen_random_uuid()::text, '-', ''),
  add column public_rsvp_enabled boolean not null default false;

-- What /api/public/events/:token and /api/events/by-token/:token look up by.
create unique index group_events_share_token_key on group_events (share_token);

-- ---------------------------------------------------------------------------
-- group_event_public_rsvps -- a stranger's RSVP through the share page.
--
-- Keyed by address rather than by account, because there is no account. The
-- unique index is what makes a second submission a correction rather than a
-- duplicate (the route upserts against it), and it means flooding an event
-- takes a distinct address per row. citext, like directory_requests.email, so
-- "Maria@Example.com" and "maria@example.com" are the same person.
--
-- References group_events, not group_posts, exactly as group_event_rsvps does:
-- the database itself refuses a public RSVP against a message. Cascading from
-- it means the 5-year retention purge (services/group-retention.ts) takes these
-- rows with the event, with no change there.
--
-- There is no `response` column: the form only offers "I'll be there". A
-- stranger has no reason to tell a parish they are not coming.
--
-- `guest_count` has no default -- the form requires the field and 0 is a real
-- answer to it -- and is capped at 50 to match groupRsvpSchema, so a member and
-- a stranger are held to the same limit.
-- ---------------------------------------------------------------------------
create table group_event_public_rsvps (
  id           uuid        primary key default gen_random_uuid(),
  post_id      uuid        not null references group_events (post_id) on delete cascade,
  first_name   text        not null,
  last_name    text        not null,
  email        citext      not null,
  guest_count  int         not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint group_event_public_rsvps_names_not_blank
    check (btrim(first_name) <> '' and btrim(last_name) <> ''),
  constraint group_event_public_rsvps_email_not_blank check (btrim(email) <> ''),
  constraint group_event_public_rsvps_guest_count_sane
    check (guest_count between 0 and 50)
);

-- One per address per event, and the per-event lookup the roster and the
-- headcount both run on (post_id leads, so no second index is needed).
create unique index group_event_public_rsvps_one_per_email_idx
  on group_event_public_rsvps (post_id, email);

create trigger group_event_public_rsvps_set_updated_at
  before update on group_event_public_rsvps
  for each row execute function set_updated_at();

-- An open group page sees a public RSVP live, the same as a member's. V20's
-- function only reads new.post_id, which this table has too.
create trigger group_event_public_rsvps_touch_activity
  after insert or update on group_event_public_rsvps
  for each row execute function touch_group_activity_for_rsvp();
