-- # mentions of groups in messages.
--
-- A mention is stored in the post body as `<#group-id>`, never as the group's
-- name, because the body goes to every reader and a Secret group's name must
-- not. Each reader is told the names they may see when the post is read (see
-- api/src/services/group-mentions.ts), by the same rule as the groups list:
-- Public and Private groups by anyone in the parish, a Secret group by its
-- members and parish admins.
--
-- `deleted_groups` keeps what that rule needs once a group is gone -- its name,
-- visibility and who was in it -- so a message that mentioned a deleted group
-- still names it for the people who could see it. The delete route writes the
-- row in the same transaction as the delete. Nothing links to a deleted group.

create table deleted_groups (
  id                  uuid        primary key,
  organization_id     uuid        not null references organizations (id) on delete cascade,
  title               text        not null,
  visibility          text        not null,
  member_app_user_ids uuid[]      not null default '{}',
  deleted_at          timestamptz not null default now(),

  constraint deleted_groups_visibility_valid check (visibility in ('PUBLIC', 'PRIVATE', 'SECRET'))
);
