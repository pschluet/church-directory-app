-- Prayer requests: a member asks the parish to pray for someone, and a
-- reviewer decides whether it is posted.
--
-- The moderation is the reason this is not just a table of messages. A prayer
-- request names a third party -- someone ill, someone travelling, someone who
-- has died -- and often says why, so it is the one thing in this directory that
-- a member writes *about somebody else* and everyone then reads. Every row
-- therefore starts PENDING and is invisible to the parish until a
-- PRAYER_REQUEST_ADMIN (see V7) approves it.
--
-- Two timestamps, deliberately:
--
--   submitted_at  when the author wrote it. Kept because the requirement asks
--                 for it ("just in case we need it later"); nothing reads it.
--   posted_at     when the reviewer approved it. This is the one that orders
--                 the page and defines the one-month window the app shows.
--
-- They are not interchangeable: a request submitted on Friday and approved on
-- Monday belongs at Monday's end of the list, because that is when the parish
-- could first see it. There is no separate created_at -- with no draft state it
-- would hold the same value as submitted_at, and the requirement names that one.

create table prayer_requests (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references organizations (id) on delete restrict,
  -- Cascade, like special_dates: the People & Accounts hard delete exists for
  -- rows that should never have existed, and leaving a request behind whose
  -- author no longer resolves would show the parish an anonymous message.
  author_person_id     uuid        not null references persons (id) on delete cascade,
  title                text        not null,
  body                 text        not null,
  status               text        not null default 'PENDING',
  submitted_at         timestamptz not null default now(),
  posted_at            timestamptz,
  decided_at           timestamptz,
  -- set null rather than cascade: losing the reviewer's account must not take
  -- the posted request down with it.
  decided_by_person_id uuid        references persons (id) on delete set null,
  rejection_reason     text,
  updated_at           timestamptz not null default now(),

  constraint prayer_requests_status_valid
    check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  constraint prayer_requests_title_not_blank check (btrim(title) <> ''),
  constraint prayer_requests_body_not_blank  check (btrim(body) <> ''),
  constraint prayer_requests_decided_consistently
    check ((status = 'PENDING') = (decided_at is null)),
  -- The load-bearing one. `posted_at` exists exactly when the row is approved,
  -- so "order by posted_at" and "only the last month by posted date" cannot be
  -- fooled: nothing unapproved carries a posting time, and nothing visible
  -- lacks one. Without this a NULL posted_at on an APPROVED row would sort
  -- first on `desc` and sit at the top of the page forever.
  constraint prayer_requests_posted_when_approved
    check ((status = 'APPROVED') = (posted_at is not null)),
  constraint prayer_requests_reason_only_when_rejected
    check (rejection_reason is null or status = 'REJECTED')
);

-- The member-facing page: one organization, approved only, within a window of
-- posted_at, newest first. Partial on APPROVED because that is the only status
-- this query ever asks for, and it keeps the index the size of what is actually
-- on screen rather than of every request ever written.
create index prayer_requests_posted_idx
  on prayer_requests (organization_id, posted_at desc)
  where status = 'APPROVED';

-- The review queue: oldest first, so nothing waits behind a later submission.
create index prayer_requests_queue_idx
  on prayer_requests (organization_id, submitted_at)
  where status = 'PENDING';

-- The author's own list, which includes the requests nobody else can see.
create index prayer_requests_author_idx
  on prayer_requests (author_person_id, submitted_at desc);

create trigger prayer_requests_set_updated_at
  before update on prayer_requests
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- prayer_request_images
--
-- A separate table rather than an array column on prayer_requests, because each
-- image carries its own dimensions and its own place in the order.
--
-- `photo_key` is a prefix ending in "/" under which the browser has already
-- uploaded a `thumb` and a `full` rendition -- the same layout person and family
-- photos use (api/src/photos.ts). Width and height are the `full` rendition's,
-- stored for the same reason V4 stores them for a family photo: an attachment is
-- free-form, so without them the page cannot reserve the box and every image
-- shifts the layout as it paints.
-- ---------------------------------------------------------------------------
create table prayer_request_images (
  id                uuid        primary key default gen_random_uuid(),
  prayer_request_id uuid        not null references prayer_requests (id) on delete cascade,
  photo_key         text        not null,
  width             int,
  height            int,
  position          int         not null,
  created_at        timestamptz not null default now(),

  -- Matches photoAttachSchema: a key that does not end in "/" is a single
  -- un-cropped original from before renditions existed, and nothing new should
  -- be written in that shape.
  constraint prayer_request_images_key_ends_in_slash check (photo_key like '%/'),
  constraint prayer_request_images_dimensions_together
    check ((width is null) = (height is null)),
  constraint prayer_request_images_width_positive  check (width  is null or width  > 0),
  constraint prayer_request_images_height_positive check (height is null or height > 0),
  constraint prayer_request_images_position_not_negative check (position >= 0),
  -- Two images cannot claim the same slot, so the order the author chose is the
  -- order everyone sees.
  constraint prayer_request_images_position_unique unique (prayer_request_id, position)
);

create index prayer_request_images_request_idx
  on prayer_request_images (prayer_request_id, position);
