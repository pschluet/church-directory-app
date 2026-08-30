-- The least-privilege Postgres role the API Lambda connects as.
--
-- On RDS the Lambda authenticates with IAM: `@aws-sdk/rds-signer` builds a
-- token by signing locally, so there is no Secrets Manager call and no network
-- dependency beyond Postgres itself. That requires the role to hold `rds_iam`,
-- which only exists on RDS -- locally we fall back to a password so the same
-- migration works against the Docker Postgres.

do $do$
begin
  if not exists (select 1 from pg_roles where rolname = '${appRole}') then
    execute format('create role %I login', '${appRole}');
  end if;

  if exists (select 1 from pg_roles where rolname = 'rds_iam') then
    execute format('grant rds_iam to %I', '${appRole}');
  else
    execute format('alter role %I password %L', '${appRole}', '${appRoleLocalPassword}');
  end if;
end
$do$;

grant usage on schema public to ${appRole};

grant select, insert, update, delete on all tables in schema public to ${appRole};
grant usage, select on all sequences in schema public to ${appRole};

-- Future migrations create tables as the master user; make sure the app role
-- picks those up too rather than needing a grant in every later migration.
alter default privileges in schema public
  grant select, insert, update, delete on tables to ${appRole};
alter default privileges in schema public
  grant usage, select on sequences to ${appRole};

-- The app role must never migrate the schema; Flyway runs as the master user.
revoke create on schema public from ${appRole};
