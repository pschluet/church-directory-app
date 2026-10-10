-- What an open group page needs to feel live: a stamp that says "something in
-- this group changed", and a record of who is typing right now.
--
-- The app polls a small endpoint while a group is open (see
-- routes/groups.ts GET /:id/live) rather than holding a connection open. The
-- API is one Lambda in a VPC with no NAT and no interface endpoints, chosen so
-- there is no fixed monthly cost; a WebSocket would need a new API, a
-- connections table, and a way for the Lambda to reach execute-api from inside
-- that VPC. A poll needs none of it, and what it asks has to be cheap enough to
-- ask every couple of seconds -- hence a stamp on the group row (one primary-key
-- lookup) instead of scanning the group's posts for the newest edit.

-- ---------------------------------------------------------------------------
-- groups.activity_at
--
-- Bumped by trigger, not by route code, so no write path can forget to: a new
-- post, a reply, an edit (edited_at), a soft delete (deleted_at), an event edit
-- (which also touches group_posts.edited_at), and an RSVP all move it. The
-- client only ever compares it for *difference* with the last value it saw.
--
-- clock_timestamp() rather than now(). now() is the start of the transaction,
-- so a slow transaction that began earlier but committed later would write an
-- older value over a newer one. The client would still see a difference, but a
-- stamp that can run backwards is a stamp nobody can reason about.
--
-- Not fired on delete: a hard delete is the retention job or a whole group
-- going away, and neither is something an open page should react to.
-- ---------------------------------------------------------------------------
alter table groups
  add column activity_at timestamptz not null default now();

create function touch_group_activity() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp() where id = new.group_id;
  return new;
end;
$fn$ language plpgsql;

create trigger group_posts_touch_activity
  after insert or update on group_posts
  for each row execute function touch_group_activity();

-- RSVPs hang off the event post, not the group, so the group is looked up.
create function touch_group_activity_for_rsvp() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp()
   where id = (select group_id from group_posts where id = new.post_id);
  return new;
end;
$fn$ language plpgsql;

create trigger group_event_rsvps_touch_activity
  after insert or update on group_event_rsvps
  for each row execute function touch_group_activity_for_rsvp();

-- ---------------------------------------------------------------------------
-- group_typing
--
-- One row per person per group, upserted each time their client says they are
-- typing, so the table is bounded by (people x groups) and never grows with
-- activity. "Typing" is whoever's typed_at is within the last few seconds; a row
-- nobody refreshes simply stops counting, which is why there is no explicit
-- "stopped typing" signal and no job to expire rows. Stale rows are swept
-- opportunistically by the upsert itself.
--
-- Both keys cascade: a typing marker has no meaning without the person or the
-- group, and nothing should block deleting either.
-- ---------------------------------------------------------------------------
create table group_typing (
  group_id     uuid        not null references groups (id) on delete cascade,
  app_user_id  uuid        not null references app_users (id) on delete cascade,
  typed_at     timestamptz not null default now(),

  constraint group_typing_pkey primary key (group_id, app_user_id)
);
