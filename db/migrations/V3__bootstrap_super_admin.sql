-- The very first Super Admin. The database is private, so this cannot be a
-- psql insert from a laptop; it has to arrive with the migrations.
--
-- The row is inserted with a null cognito_sub because no Cognito user exists
-- yet. Create that separately (see the README's one-time setup), and on first
-- sign-in the claim-by-email fallback in api/src/auth.ts binds the two. Every
-- subsequent account is created from the admin UI, which calls AdminCreateUser
-- and stores the sub immediately.
--
-- Super admins are cross-organization, so organization_id stays null.

insert into app_users (email, role, organization_id, status)
values ('${superAdminEmail}', 'SUPER_ADMIN', null, 'INVITED')
on conflict (email) do nothing;
