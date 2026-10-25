-- ---------------------------------------------------------------------------
-- Changing the address an account signs in with, self-service.
--
-- A member can already have an admin change their sign-in email for them
-- (app_users.email, updated through PUT /admin/users/:id/email). This table is
-- what lets them do it themselves: a one-time code is emailed to the *new*
-- address and must be entered before the switch takes effect, which is the
-- same proof of mailbox control sign-in itself relies on (see
-- auth-challenge.ts) and is what keeps a mistyped address from locking someone
-- out -- the user pool's accountRecovery is NONE, so there is no other way
-- back in.
--
-- Primary key on app_user_id: at most one pending request per account, and a
-- second request before the first is confirmed simply replaces it rather than
-- stacking rows that would all need expiring separately.
--
-- The code itself is never stored in plaintext, only its hash, mirroring how a
-- password would be handled -- not because the code is long-lived (it is not;
-- see expires_at), but because there is no reason for anyone with database
-- access to be able to read it back.
-- ---------------------------------------------------------------------------
create table email_change_requests (
  app_user_id uuid primary key references app_users (id) on delete cascade,
  new_email citext not null,
  code_hash text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
