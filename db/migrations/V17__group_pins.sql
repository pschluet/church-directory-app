-- Letting a signed-in account pin a group to the top of the groups page.
--
-- A pin is independent of membership: a Public group is readable without
-- joining it (see services/groups.ts's groupAccess), so someone following one
-- without having joined can still want it pinned. That is why this is its own
-- table keyed by (app_user_id, group_id) rather than a column on
-- group_members, which only exists for someone who has actually joined.
--
-- No organization_id column -- same choice group_members makes -- it is
-- implied by group_id, and nothing here ever needs to query pins across an
-- organization rather than for one caller.

create table group_pins (
  app_user_id  uuid        not null references app_users (id) on delete cascade,
  group_id     uuid        not null references groups (id) on delete cascade,
  pinned_at    timestamptz not null default now(),

  constraint group_pins_pkey primary key (app_user_id, group_id)
);

-- Every read of this table is "which of this caller's groups are pinned" --
-- GET /groups left-joins it by app_user_id for exactly that.
create index group_pins_app_user_idx on group_pins (app_user_id);
