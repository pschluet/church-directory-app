-- Which version of the group guidelines each account has agreed to.
--
-- One row per account, keyed by it, for the same reason as
-- notification_preferences: app_users is read by the auth middleware on every
-- request and stays unchanged. A version rather than a boolean, so editing the
-- guidelines and bumping GROUP_GUIDELINES_VERSION asks everybody again.

create table group_guidelines_agreements (
  app_user_id uuid        primary key references app_users (id) on delete cascade,
  version     integer     not null check (version > 0),
  agreed_at   timestamptz not null default now()
);
