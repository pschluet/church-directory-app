-- A Parish Wide group is Public: everyone in the parish is already a member,
-- so there is no one for Private ("ask to join") or Secret ("hidden from
-- non-members") to keep out. services/groups.ts also refuses the combination
-- up front with a readable message; this is the backstop.
alter table groups
  add constraint groups_parish_wide_public check (not parish_wide or visibility = 'PUBLIC');
