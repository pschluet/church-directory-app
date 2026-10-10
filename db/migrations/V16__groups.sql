-- Groups: member-created spaces for messaging, files and events.
--
-- This is the first feature with a second permission axis. Role (USER, ADMIN,
-- SUPER_ADMIN, ...) answers "what can this account do across the parish";
-- group role (ADMIN, MEMBER) answers "what can this account do inside this
-- one group", and the two are independent -- a parish ADMIN is not
-- automatically a group admin, and a group admin is not thereby a parish
-- ADMIN. api/src/services/groups.ts is where the two are combined into one
-- set of capability flags, the same shape canEditFamily already uses for
-- families.
--
-- See requirements/groups.md for the product rules this schema encodes, and
-- requirements/groups-plan.md for why each decision was made.

-- ---------------------------------------------------------------------------
-- groups
--
-- `visibility` only ever tightens, with one named exception (SECRET -> PRIVATE)
-- and never loosens back to PUBLIC once changed -- see assertCanConvertGroup in
-- services/groups.ts, which is where that matrix actually lives. A CHECK here
-- cannot express "given the previous value", so this is a service-layer rule
-- like the inheritance invariants in V1__init.sql.
--
-- The three `*_restricted` switches are admin-only toggles ("can only admins
-- post/invite/reply"), not a per-member allowlist -- booleans are all three
-- need.
-- ---------------------------------------------------------------------------
create table groups (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references organizations (id) on delete restrict,
  title                 text        not null,
  description           text,
  photo_key             text,
  -- A group photo is a free-form crop, like a family's -- see
  -- V4__family_photo_dimensions.sql for why the dimensions are stored rather
  -- than measured on read.
  photo_width           int,
  photo_height          int,
  visibility            text        not null default 'PUBLIC',
  posting_restricted    boolean     not null default false,
  invites_restricted    boolean     not null default false,
  replies_restricted    boolean     not null default false,
  archived_at           timestamptz,
  created_by_person_id  uuid        references persons (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint groups_title_not_blank check (btrim(title) <> ''),
  constraint groups_visibility_valid check (visibility in ('PUBLIC', 'PRIVATE', 'SECRET')),
  constraint groups_photo_dimensions_together check ((photo_width is null) = (photo_height is null))
);

create index groups_organization_idx on groups (organization_id, title);

create trigger groups_set_updated_at
  before update on groups
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- group_members
--
-- Keyed by app_user_id, not person_id: "only people with an account are
-- eligible for group membership" (requirements/groups.md), and every query that
-- checks membership is checking "can this signed-in caller do X", which is an
-- app_users question. person_id is carried alongside rather than joined for
-- every read, because a post's byline and the member list both want a name and
-- a photo, which live on persons_resolved.
--
-- `last_read_at` is what the per-group unread badge is computed from: posts
-- newer than this, minus the caller's own, are unread. No separate "read
-- receipt" table -- one timestamp per membership is enough, the same choice
-- V9__notifications.sql made the other way (there, the panel needs to name
-- *which* notification is unread, which a high-water mark cannot do; here the
-- badge is only ever a count).
-- ---------------------------------------------------------------------------
create table group_members (
  group_id           uuid        not null references groups (id) on delete cascade,
  app_user_id        uuid        not null references app_users (id) on delete cascade,
  person_id          uuid        not null references persons (id) on delete cascade,
  role               text        not null default 'MEMBER',
  notification_pref  text        not null default 'ALL',
  last_read_at       timestamptz,
  joined_at          timestamptz not null default now(),

  primary key (group_id, app_user_id),
  constraint group_members_role_valid check (role in ('ADMIN', 'MEMBER')),
  constraint group_members_notification_pref_valid
    check (notification_pref in ('ALL', 'MENTIONS', 'NONE'))
);

-- "What groups am I in" -- the groups list page, and every permission check
-- that starts from a caller rather than from a group.
create index group_members_app_user_idx on group_members (app_user_id);
create index group_members_person_idx on group_members (person_id);

-- ---------------------------------------------------------------------------
-- group_join_requests -- the same gated-approval shape as family_join_requests
-- in V1__init.sql, for Private groups: visible to everyone, but joinable only
-- by invitation or by a group admin approving a request.
-- ---------------------------------------------------------------------------
create table group_join_requests (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references organizations (id) on delete restrict,
  group_id              uuid        not null references groups (id) on delete cascade,
  person_id             uuid        not null references persons (id) on delete cascade,
  status                text        not null default 'PENDING',
  requested_at          timestamptz not null default now(),
  decided_at            timestamptz,
  decided_by_person_id  uuid        references persons (id) on delete set null,

  constraint group_join_requests_status_valid
    check (status in ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED')),
  constraint group_join_requests_decided_consistently
    check ((status = 'PENDING') = (decided_at is null))
);

create unique index group_join_requests_one_pending_idx
  on group_join_requests (group_id, person_id)
  where status = 'PENDING';
create index group_join_requests_group_idx on group_join_requests (group_id, status);
create index group_join_requests_person_idx on group_join_requests (person_id, status);

-- ---------------------------------------------------------------------------
-- group_posts
--
-- One table for both ordinary messages and event posts (`kind`), so the
-- Messages tab is a single feed query and the Files/Events tabs are "the same
-- feed, filtered" rather than separately maintained lists -- which is also
-- what requirements/groups.md asks for ("automatically populated ... so
-- members don't have to scroll back").
--
-- `parent_post_id` is a self-FK with `on delete cascade`: threading is exactly
-- one level, so a reply's parent must itself be a root. That "must be a root"
-- half cannot be written as a CHECK constraint -- Postgres CHECKs cannot
-- consult another row, let alone the same table -- so it is enforced in
-- services/groups.ts at post-creation time, the same way V1__init.sql's
-- inheritance invariants are. The cascade is what makes retention's "purge a
-- whole dormant thread" a single DELETE on the root: see
-- services/group-retention.ts.
--
-- `author_person_id` cascades on delete, like prayer_requests.author_person_id
-- -- the People & Accounts hard delete is for rows that should never have
-- existed, and a post with no author would read as an anonymous message to
-- the group.
--
-- Deletion is soft (`deleted_at`): "deleting a post leaves a placeholder...
-- only the content is removed" (requirements/groups.md), so replies keep their
-- anchor. The row is only ever hard-deleted by retention, five years out.
-- `body` is null exactly for an EVENT post, whose text lives in
-- `group_events` instead -- mirroring the posted_at/status pairing pattern in
-- V8__prayer_requests.sql rather than letting the two kinds disagree about
-- which column carries the content.
-- ---------------------------------------------------------------------------
create table group_posts (
  id                     uuid        primary key default gen_random_uuid(),
  group_id               uuid        not null references groups (id) on delete cascade,
  author_person_id       uuid        not null references persons (id) on delete cascade,
  parent_post_id         uuid        references group_posts (id) on delete cascade,
  kind                   text        not null,
  body                   text,
  edited_at              timestamptz,
  deleted_at             timestamptz,
  deleted_by_person_id   uuid        references persons (id) on delete set null,
  created_at             timestamptz not null default now(),

  constraint group_posts_kind_valid check (kind in ('MESSAGE', 'EVENT')),
  -- An EVENT's text lives in group_events (title/description); a MESSAGE's
  -- lives here. Neither kind stores it in both places.
  constraint group_posts_body_matches_kind check ((kind = 'MESSAGE') = (body is not null)),
  constraint group_posts_body_not_blank check (body is null or btrim(body) <> ''),
  -- Who deleted it is only ever known alongside *when* -- a tombstone with one
  -- but not the other would mean the write was interrupted halfway.
  constraint group_posts_deleted_consistently
    check ((deleted_at is null) = (deleted_by_person_id is null))
);

-- The feed itself, and the window retention scans over.
create index group_posts_group_created_idx on group_posts (group_id, created_at);
-- Replies for one root, for the expandable thread.
create index group_posts_parent_idx on group_posts (parent_post_id) where parent_post_id is not null;
-- Retention's "every root older than the cutoff" scan, across every group in
-- one pass rather than one query per group.
create index group_posts_root_created_idx on group_posts (created_at) where parent_post_id is null;

-- ---------------------------------------------------------------------------
-- group_post_attachments
--
-- A separate table rather than an array column, for the same reason
-- prayer_request_images is one: each attachment carries its own dimensions
-- (images only) and its own place in the order.
--
-- `photo_key` for an IMAGE is the rendition prefix uploads.ts already knows how
-- to presign and photos.ts how to serve (ending in "/", with thumb/full
-- renditions underneath). For a FILE it is a single object with no renditions
-- -- see the `group-post` passthrough case in photos.ts. `filename`,
-- `content_type` and `byte_size` are stored because the key itself is an
-- extensionless ULID; without them a downloaded PDF would have no name and the
-- browser could not set a sensible Content-Disposition.
-- ---------------------------------------------------------------------------
create table group_post_attachments (
  id            uuid        primary key default gen_random_uuid(),
  post_id       uuid        not null references group_posts (id) on delete cascade,
  photo_key     text        not null,
  kind          text        not null,
  filename      text        not null,
  content_type  text        not null,
  byte_size     int         not null,
  width         int,
  height        int,
  position      int         not null,
  created_at    timestamptz not null default now(),

  constraint group_post_attachments_kind_valid check (kind in ('IMAGE', 'FILE')),
  constraint group_post_attachments_dimensions_together check ((width is null) = (height is null)),
  -- Only an IMAGE has dimensions; a FILE is never decoded to a canvas.
  constraint group_post_attachments_dimensions_only_for_image
    check (kind = 'IMAGE' or (width is null and height is null)),
  constraint group_post_attachments_byte_size_positive check (byte_size > 0),
  constraint group_post_attachments_position_not_negative check (position >= 0),
  constraint group_post_attachments_position_unique unique (post_id, position)
);

create index group_post_attachments_post_idx on group_post_attachments (post_id, position);

-- ---------------------------------------------------------------------------
-- group_events -- one row per EVENT-kind post, 1:1 by construction (the primary
-- key is the post's own id, so a post can have at most one).
--
-- Naive local date/time, deliberately not timestamptz: a parish event is
-- always in the parish's own clock, there is no timezone column on
-- organizations to convert through, and round-tripping through UTC would shift
-- the displayed time for no reason requirements/groups.md ever asked for.
-- `end_time` requires `start_time` -- an event cannot end at 11:30 with no
-- stated start.
-- ---------------------------------------------------------------------------
create table group_events (
  post_id       uuid primary key references group_posts (id) on delete cascade,
  title         text not null,
  description   text,
  event_date    date not null,
  start_time    time,
  end_time      time,
  location      text,

  constraint group_events_title_not_blank check (btrim(title) <> ''),
  constraint group_events_end_time_needs_start check (end_time is null or start_time is not null)
);

-- Retention measures an event's lifetime from greatest(created_at, event_date)
-- (see services/group-retention.ts), so a far-future event is never purged
-- before it happens; this index is what that scan runs on.
create index group_events_date_idx on group_events (event_date);

-- ---------------------------------------------------------------------------
-- group_event_rsvps
--
-- References group_events, not group_posts directly, so an RSVP can only ever
-- exist against a post that is actually an event -- the database refuses the
-- illegal state rather than the API having to check `kind = 'EVENT'` itself.
-- ---------------------------------------------------------------------------
create table group_event_rsvps (
  post_id       uuid        not null references group_events (post_id) on delete cascade,
  app_user_id   uuid        not null references app_users (id) on delete cascade,
  response      text        not null,
  guest_count   int         not null default 0,
  updated_at    timestamptz not null default now(),

  primary key (post_id, app_user_id),
  constraint group_event_rsvps_response_valid check (response in ('YES', 'NO', 'MAYBE')),
  constraint group_event_rsvps_guest_count_not_negative check (guest_count >= 0)
);

create trigger group_event_rsvps_set_updated_at
  before update on group_event_rsvps
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- group_post_mentions -- who was @ mentioned in a post, driving both the
-- "mentions only" notification preference and the eventual GROUP_MENTION
-- notification. A member can only mention someone already in the group (see
-- services/groups.ts), so this is always a subset of that post's group's
-- membership at the time it was written -- membership afterwards may change,
-- which is why this is its own table rather than derived from current
-- group_members rows.
-- ---------------------------------------------------------------------------
create table group_post_mentions (
  post_id      uuid not null references group_posts (id) on delete cascade,
  app_user_id  uuid not null references app_users (id) on delete cascade,

  primary key (post_id, app_user_id)
);

-- ---------------------------------------------------------------------------
-- group_post_reports
--
-- `post_id` is `on delete set null`, not cascade: a report is evidence of a
-- moderation decision ("why was this removed"), so it must outlive the post it
-- was about. `post_excerpt` is captured at report time for exactly that
-- moment -- once the post is gone there is nothing left to join back to.
--
-- Eligibility to report mirrors read access (see services/groups.ts), so a
-- parish admin can report inside a Secret group. `reporter_app_user_id` is
-- `on delete set null` like every other "who did this" pointer in this schema,
-- so losing that account does not erase the report, only who filed it.
-- ---------------------------------------------------------------------------
create table group_post_reports (
  id                     uuid        primary key default gen_random_uuid(),
  group_id               uuid        not null references groups (id) on delete cascade,
  post_id                uuid        references group_posts (id) on delete set null,
  post_excerpt           text        not null,
  reporter_app_user_id   uuid        references app_users (id) on delete set null,
  reporter_person_id     uuid        references persons (id) on delete set null,
  reason                 text,
  status                 text        not null default 'PENDING',
  created_at             timestamptz not null default now(),
  decided_at             timestamptz,
  decided_by_person_id   uuid        references persons (id) on delete set null,

  constraint group_post_reports_status_valid check (status in ('PENDING', 'RESOLVED', 'DISMISSED')),
  constraint group_post_reports_decided_consistently
    check ((status = 'PENDING') = (decided_at is null))
);

-- One open report per person per post -- "can't submit duplicate reports
-- against the same post while one is still pending" (requirements/groups.md).
-- Scoped to PENDING like family_join_requests_one_pending_idx, so reporting
-- again is allowed once the first is resolved. NULLs are distinct in a unique
-- index, so this says nothing about reports whose post has since been
-- hard-deleted (post_id null) -- those are never PENDING by the time that can
-- happen, since resolving-by-deletion closes the report in the same
-- transaction.
create unique index group_post_reports_one_pending_idx
  on group_post_reports (post_id, reporter_app_user_id)
  where status = 'PENDING';
-- The moderation queue, per group and parish-wide.
create index group_post_reports_group_idx on group_post_reports (group_id, status);
create index group_post_reports_post_idx on group_post_reports (post_id);

-- ---------------------------------------------------------------------------
-- notifications -- five new types, and two new nullable references.
--
-- Postgres cannot add a value to a CHECK constraint, so notifications_type_valid
-- is dropped and recreated -- the same shape as V7__prayer_request_admin_role.sql
-- and V11__prayer_request_review_notifications.sql. Nothing to backfill: no
-- existing row can hold a new type.
--
-- notifications_prayer_request_present is renamed on the way: it never applied
-- to anything but the two prayer types, so the general name was already a
-- little wrong, and keeping it would read as covering groups too.
--
-- group_post_id is required for every new type except GROUP_JOIN_REQUEST,
-- which is about a request to join rather than about any one post. Rather than
-- widen notifications_one_per_request_idx's shape to accommodate a type with
-- no post, two narrower unique indexes replace it below: one keyed on
-- (app_user_id, type, group_post_id) for the four post-shaped types, one keyed
-- on (app_user_id, type, group_id) for GROUP_JOIN_REQUEST alone.
-- ---------------------------------------------------------------------------
alter table notifications
  add column group_id uuid references groups (id) on delete cascade,
  add column group_post_id uuid references group_posts (id) on delete cascade;

alter table notifications drop constraint notifications_type_valid;
alter table notifications
  add constraint notifications_type_valid
    check (type in (
      'PRAYER_REQUEST', 'PRAYER_REQUEST_REVIEW',
      'GROUP_POST', 'GROUP_MENTION', 'GROUP_JOIN_REQUEST', 'GROUP_EVENT', 'GROUP_POST_REPORT'
    ));

alter table notifications drop constraint notifications_prayer_request_present;
alter table notifications
  add constraint notifications_prayer_reference_present
    check (type not in ('PRAYER_REQUEST', 'PRAYER_REQUEST_REVIEW') or prayer_request_id is not null);

alter table notifications
  add constraint notifications_group_reference_present
    check (
      type not in ('GROUP_POST', 'GROUP_MENTION', 'GROUP_JOIN_REQUEST', 'GROUP_EVENT', 'GROUP_POST_REPORT')
      or group_id is not null
    );
alter table notifications
  add constraint notifications_group_post_reference_present
    check (
      type not in ('GROUP_POST', 'GROUP_MENTION', 'GROUP_EVENT', 'GROUP_POST_REPORT')
      or group_post_id is not null
    );

create unique index notifications_one_per_group_post_idx
  on notifications (app_user_id, type, group_post_id)
  where group_post_id is not null;
create unique index notifications_one_per_group_join_request_idx
  on notifications (app_user_id, type, group_id)
  where type = 'GROUP_JOIN_REQUEST';
