-- The bell: an inbox of notifications, one row per recipient, plus the
-- per-account preferences that decide who gets one.
--
-- Rows rather than a high-water mark. "Show the number of notifications a user
-- currently has, and clear the badge once they are viewed" could be answered by
-- a single `notifications_seen_at` on app_users -- but the panel also has to
-- list each notification by title, and a timestamp cannot do that. It also
-- cannot represent the case that actually happens: the panel is open, a request
-- is approved, and that one notification is unread while the others are not.
--
-- Fanning out at approval time rather than deriving the list on read is what
-- makes "unread" per person at all. It costs one row per member per posted
-- request -- a few hundred narrow rows a week at parish scale.

create table notification_preferences (
  -- One row per account, keyed by it: there is nothing else to say about a
  -- preference, and this keeps app_users -- which every single request reads
  -- through the auth middleware -- unchanged.
  app_user_id    uuid        primary key references app_users (id) on delete cascade,
  prayer_requests boolean    not null default true,
  updated_at     timestamptz not null default now()
);

create trigger notification_preferences_set_updated_at
  before update on notification_preferences
  for each row execute function set_updated_at();

create table notifications (
  id                uuid        primary key default gen_random_uuid(),
  app_user_id       uuid        not null references app_users (id) on delete cascade,
  organization_id   uuid        not null references organizations (id) on delete restrict,
  type              text        not null,
  -- Nullable so a later notification type need not be about a prayer request.
  -- Cascades, so withdrawing a request takes its notifications with it rather
  -- than leaving a badge pointing at nothing.
  prayer_request_id uuid        references prayer_requests (id) on delete cascade,
  created_at        timestamptz not null default now(),
  read_at           timestamptz,

  constraint notifications_type_valid check (type in ('PRAYER_REQUEST')),
  -- Every type so far is about a prayer request; say so, so a row that forgot
  -- the reference cannot be inserted and then render as an empty panel entry.
  constraint notifications_prayer_request_present
    check (type <> 'PRAYER_REQUEST' or prayer_request_id is not null)
);

-- Both the badge count and the panel are this query, so it is the index the
-- feature runs on. Partial on unread: read rows are the ones that pile up, and
-- nothing counts them.
create index notifications_unread_idx
  on notifications (app_user_id, created_at desc)
  where read_at is null;

-- The panel also shows recently-read notifications, so it needs the unfiltered
-- order too.
create index notifications_recent_idx
  on notifications (app_user_id, created_at desc);

-- One notification per person per prayer request. A retried approval, or a
-- second fan-out from a race between two reviewers hitting the button at once,
-- must not deliver the same request twice -- and with `on conflict do nothing`
-- on the insert, this constraint is what makes the fan-out idempotent rather
-- than merely usually-correct.
--
-- Note that a future type with a null prayer_request_id would not be deduped by
-- this: in Postgres two NULLs do not collide. That is fine while PRAYER_REQUEST
-- is the only type, and the CHECK above guarantees it is never null for that
-- one; a second type will need its own thinking.
create unique index notifications_one_per_request_idx
  on notifications (app_user_id, type, prayer_request_id);
