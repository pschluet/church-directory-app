-- Merging a person who exists twice.
--
-- A family creates a `persons` row for a member with no login -- a child, a
-- spouse who never signed up. If that person is later invited, the invite flow
-- inserts a *second* row carrying `app_user_id`, and the directory now lists
-- the same human twice with no way to reconcile them.
--
-- The merge is gated by approval from the other side, because either half of it
-- is a claim about somebody else. Two routes in, and the approver is always
-- whichever side did not ask:
--
--   A  a family member of the account-less duplicate names an account holder
--      -> that account holder approves
--   B  the account holder names an account-less person
--      -> any *other* account holder in that person's family approves
--
-- One row serves both, because `requested_by_person_id` is what tells them
-- apart: it equals `account_person_id` on route B and does not on route A. An
-- admin needs no approval at all and writes no row here.

create table person_merge_requests (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        not null references organizations (id) on delete restrict,
  -- The row that survives, and the only one of the two with an account. It is
  -- kept rather than the duplicate so that `persons.app_user_id` -- unique, and
  -- what auth.ts joins on -- never has to be reassigned.
  account_person_id       uuid        not null references persons (id) on delete cascade,
  -- The account-less duplicate, soft-deleted once the merge goes through.
  duplicate_person_id     uuid        not null references persons (id) on delete cascade,
  requested_by_person_id  uuid        not null references persons (id) on delete cascade,
  status                  text        not null default 'PENDING',
  requested_at            timestamptz not null default now(),
  decided_at              timestamptz,
  decided_by_person_id    uuid        references persons (id) on delete set null,
  constraint person_merge_requests_status_valid
    check (status in ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED')),
  constraint person_merge_requests_decided_consistently
    check ((status = 'PENDING') = (decided_at is null)),
  constraint person_merge_requests_distinct_people
    check (account_person_id <> duplicate_person_id)
);

-- One pending merge per person, on either side. Two members of a family both
-- claiming the same duplicate, or one account holder claiming two duplicates,
-- are contradictory requests rather than a queue -- whichever was approved
-- first would silently invalidate the rest. Partial on PENDING, so a denied
-- request can be raised again later with no bookkeeping.
create unique index person_merge_requests_one_pending_account_idx
  on person_merge_requests (account_person_id)
  where status = 'PENDING';
create unique index person_merge_requests_one_pending_duplicate_idx
  on person_merge_requests (duplicate_person_id)
  where status = 'PENDING';

create index person_merge_requests_account_idx
  on person_merge_requests (account_person_id, status);
create index person_merge_requests_duplicate_idx
  on person_merge_requests (duplicate_person_id, status);
