-- A fourth role: PRAYER_REQUEST_ADMIN.
--
-- Prayer requests are reviewed before anyone else sees them, and the person who
-- reviews them is not necessarily an administrator -- the requirement is "the
-- same privileges as a member, plus the ability to approve prayer requests".
--
-- Modelled as a rung in the existing hierarchy rather than as a separate
-- permission column, because that is what it is: USER < PRAYER_REQUEST_ADMIN <
-- ADMIN < SUPER_ADMIN. `requireRole` in api/src/auth.ts already treats a role
-- as a floor rather than an exact match, so an admin inherits the privilege
-- with no extra check, and nothing in the app grows a second permission axis.
--
-- Postgres cannot add a value to a CHECK constraint, so it is dropped and
-- recreated. No data changes: nobody holds the new role yet.
--
-- app_users_org_required_unless_super_admin needs no amendment -- the new role
-- is not SUPER_ADMIN, so it already requires an organization, which is right.

alter table app_users drop constraint app_users_role_valid;

alter table app_users
  add constraint app_users_role_valid
    check (role in ('SUPER_ADMIN', 'ADMIN', 'PRAYER_REQUEST_ADMIN', 'USER'));
