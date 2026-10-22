-- Emoji reactions on prayer requests, as on group posts (see V22): a person can
-- put any number of different emoji on a posted request, each at most once, and
-- sees who else did. Only an approved request can be reacted to -- the route
-- checks that -- since a pending or declined one is seen by its author and the
-- reviewers alone.
--
-- One row per (request, person, emoji), with the same reasoning as V22: the
-- primary key makes reacting idempotent and serves the per-request lookup, the
-- created_at index orders a request's reactions by who got there first, and the
-- emoji is the literal string, validated by the route.
--
-- Both keys cascade: a reaction means nothing without its request or its
-- person, and deleting a request is a hard delete that must not be blocked.
create table prayer_request_reactions (
  prayer_request_id uuid        not null references prayer_requests (id) on delete cascade,
  app_user_id       uuid        not null references app_users (id) on delete cascade,
  emoji             text        not null check (char_length(emoji) between 1 and 32),
  created_at        timestamptz not null default clock_timestamp(),

  constraint prayer_request_reactions_pkey primary key (prayer_request_id, app_user_id, emoji)
);

create index prayer_request_reactions_request_created_idx
  on prayer_request_reactions (prayer_request_id, created_at);

-- ---------------------------------------------------------------------------
-- organizations.prayer_requests_activity_at
--
-- What makes an open prayer requests page live, the way V20's
-- groups.activity_at makes an open group live: the page polls a small endpoint
-- (routes/prayer-requests.ts GET /live) for this stamp and refetches when it
-- differs from the last one it saw. One primary-key lookup, cheap enough to ask
-- every couple of seconds.
--
-- Per organization rather than per request, because the page is the whole
-- parish's list. The stamp says only that *something* changed, never what, so a
-- pending request moving it tells nobody anything they could not already learn
-- from the page refetching to the same result.
--
-- Bumped by trigger, so no write path can forget to; clock_timestamp() for the
-- reason V20 gives (a stamp that can run backwards is no stamp at all).
-- ---------------------------------------------------------------------------
alter table organizations
  add column prayer_requests_activity_at timestamptz not null default now();

-- Unlike a group, a delete counts here: a member withdrawing a request, or an
-- admin removing one, should see it vanish from every open page. Images need no
-- trigger -- they are written in the same transaction as their request.
create function touch_prayer_request_activity() returns trigger as $fn$
begin
  update organizations set prayer_requests_activity_at = clock_timestamp()
   where id = coalesce(new.organization_id, old.organization_id);
  return coalesce(new, old);
end;
$fn$ language plpgsql;

create trigger prayer_requests_touch_activity
  after insert or update or delete on prayer_requests
  for each row execute function touch_prayer_request_activity();

-- Reactions hang off the request, so the organization is looked up through it.
-- When the row is going away because its request was deleted, the request is
-- already gone, the lookup finds nothing, and that is fine: the request's own
-- delete trigger has moved the stamp.
create function touch_prayer_request_activity_for_reaction() returns trigger as $fn$
begin
  update organizations set prayer_requests_activity_at = clock_timestamp()
   where id = (select organization_id from prayer_requests
                where id = coalesce(new.prayer_request_id, old.prayer_request_id));
  return coalesce(new, old);
end;
$fn$ language plpgsql;

create trigger prayer_request_reactions_touch_activity
  after insert or delete on prayer_request_reactions
  for each row execute function touch_prayer_request_activity_for_reaction();
