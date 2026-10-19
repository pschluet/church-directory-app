-- Asking to be added to the directory, from the sign-in page.
--
-- Sign-up stays disabled on the user pool: a request is not an account, only a
-- note to the parish's administrators that somebody would like one. Approving
-- it is what invites them, through exactly the same path as "Invite someone" on
-- People & Accounts.
--
-- Written by an unauthenticated route, so nothing here may be trusted to have
-- come from who it says. That is why there is no app_users or persons row until
-- an administrator approves, and why the request carries its own copy of the
-- name and address rather than pointing at anything.

create table directory_requests (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        not null references organizations (id) on delete cascade,
  first_name              text        not null,
  last_name               text        not null,
  email                   citext      not null,
  status                  text        not null default 'PENDING',
  requested_at            timestamptz not null default now(),
  decided_at              timestamptz,
  decided_by_app_user_id  uuid        references app_users (id) on delete set null,
  -- The account an approval created. Set null rather than cascading if that
  -- account is later deleted: the request still happened.
  app_user_id             uuid        references app_users (id) on delete set null,

  constraint directory_requests_status_valid
    check (status in ('PENDING', 'APPROVED', 'DECLINED')),
  constraint directory_requests_decided_consistently
    check ((status = 'PENDING') = (decided_at is null)),
  constraint directory_requests_first_name_not_blank check (btrim(first_name) <> ''),
  constraint directory_requests_last_name_not_blank check (btrim(last_name) <> ''),
  constraint directory_requests_email_not_blank check (btrim(email) <> '')
);

-- One open request per address per parish. Submitting the form twice -- or a
-- script submitting it a thousand times -- leaves one row for an administrator
-- to look at, and the route's `on conflict do nothing` relies on this.
create unique index directory_requests_one_pending_idx
  on directory_requests (organization_id, email)
  where status = 'PENDING';

-- The People & Accounts list: a parish's pending requests, newest first.
create index directory_requests_org_status_idx
  on directory_requests (organization_id, status, requested_at desc);

-- ---------------------------------------------------------------------------
-- notifications -- one new type, and its reference.
--
-- Same drop-and-recreate as V11 and V16: Postgres cannot add a value to a
-- CHECK constraint.
--
-- Cascades from the request, though in practice a request is never deleted:
-- deciding it is what retires the notification (see NOTIFICATION_VISIBLE in
-- api/src/services/notifications.ts), the same way PRAYER_REQUEST_REVIEW stops
-- showing the moment anyone decides the request.
-- ---------------------------------------------------------------------------
alter table notifications
  add column directory_request_id uuid references directory_requests (id) on delete cascade;

alter table notifications drop constraint notifications_type_valid;
alter table notifications
  add constraint notifications_type_valid
    check (type in (
      'PRAYER_REQUEST', 'PRAYER_REQUEST_REVIEW',
      'GROUP_POST', 'GROUP_MENTION', 'GROUP_JOIN_REQUEST', 'GROUP_EVENT', 'GROUP_POST_REPORT',
      'DIRECTORY_REQUEST'
    ));

alter table notifications
  add constraint notifications_directory_request_reference_present
    check (type <> 'DIRECTORY_REQUEST' or directory_request_id is not null);

-- One notification per administrator per request, so the fan-out can be an
-- `on conflict do nothing` like every other one.
create unique index notifications_one_per_directory_request_idx
  on notifications (app_user_id, type, directory_request_id)
  where directory_request_id is not null;

-- ---------------------------------------------------------------------------
-- The administrator's switch. Defaults on, like prayer_request_reviews: being
-- told about work waiting for you should not need opting in to. Only an
-- administrator's value is ever read.
-- ---------------------------------------------------------------------------
alter table notification_preferences
  add column directory_requests boolean not null default true;
