-- Parish Wide groups: a group every account in the parish belongs to, and
-- nobody can leave.
--
-- Membership is kept in step by a trigger on `persons` rather than by the
-- routes that create accounts. An account reaches a parish by several paths --
-- an invitation or an approved directory request (services/invitations.ts), a
-- move between parishes (services/membership.ts), a merge that hands an
-- account to the surviving record (services/merge.ts) -- and a new path added
-- later would otherwise have to remember to add itself to every parish-wide
-- group. A trigger cannot be forgotten.
--
-- Turning the flag *on* for a group is not covered here: that is a one-off
-- bulk insert done by services/groups.ts addEveryoneToGroup. Turning it off
-- changes no rows; everyone stays a member and may leave from then on.
alter table groups add column parish_wide boolean not null default false;

create function sync_parish_wide_membership() returns trigger as $fn$
begin
  -- A record moved to another parish no longer belongs in the old parish's
  -- parish-wide groups, and could not leave them on their own.
  if tg_op = 'UPDATE' and old.app_user_id is not null
     and (old.organization_id is distinct from new.organization_id
          or new.app_user_id is distinct from old.app_user_id
          or new.deleted_at is not null) then
    delete from group_members gm
     using groups g
     where gm.group_id = g.id
       and g.parish_wide
       and g.organization_id = old.organization_id
       and gm.app_user_id = old.app_user_id
       and (new.deleted_at is not null
            or new.app_user_id is distinct from old.app_user_id
            or new.organization_id is distinct from old.organization_id);
  end if;

  if new.app_user_id is not null and new.deleted_at is null then
    insert into group_members (group_id, app_user_id, person_id)
    select g.id, new.app_user_id, new.id
      from groups g
     where g.organization_id = new.organization_id
       and g.parish_wide
       and g.archived_at is null
    on conflict (group_id, app_user_id) do nothing;
  end if;
  return new;
end;
$fn$ language plpgsql;

create trigger persons_sync_parish_wide_membership
  after insert or update of app_user_id, organization_id, deleted_at on persons
  for each row execute function sync_parish_wide_membership();
