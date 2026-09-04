-- A second notification type: "a prayer request is waiting for your review".
--
-- Until now the fan-out only fired when a request was *posted*, so a member
-- could submit one and it would sit in the queue until a reviewer happened to
-- open the app. That is the one notification the feature most needs.
--
-- Postgres cannot add a value to a CHECK constraint, so both are dropped and
-- recreated -- the same shape as V7__prayer_request_admin_role.sql. Nothing to
-- backfill: no row can already hold the new type.

alter table notifications drop constraint notifications_type_valid;

alter table notifications
  add constraint notifications_type_valid
    check (type in ('PRAYER_REQUEST', 'PRAYER_REQUEST_REVIEW'));

alter table notifications drop constraint notifications_prayer_request_present;

-- Deliberately still a per-type rule rather than the simpler
-- `check (prayer_request_id is not null)`. Both types so far are about a prayer
-- request, but the column comment in V9 keeps it nullable on purpose -- "so a
-- later notification type need not be about a prayer request" -- and a
-- column-level rule would quietly foreclose that.
alter table notifications
  add constraint notifications_prayer_request_present
    check (type not in ('PRAYER_REQUEST', 'PRAYER_REQUEST_REVIEW')
           or prayer_request_id is not null);

-- ---------------------------------------------------------------------------
-- No index changes, and that is worth saying out loud.
--
-- notifications_one_per_request_idx is (app_user_id, type, prayer_request_id),
-- and `type` being in the key is load-bearing here: a reviewer can hold *both*
-- a PRAYER_REQUEST_REVIEW row (written when the request arrived) and a
-- PRAYER_REQUEST row (written when somebody else approved it) for the same
-- request, and neither can be delivered twice. Which of the two is visible is
-- decided by status rather than by deleting anything -- see NOTIFICATION_VISIBLE
-- in api/src/services/notifications.ts:
--
--   PENDING   -> the review row shows, the posted row does not exist yet
--   APPROVED  -> the posted row shows, the review row is hidden
--   REJECTED  -> neither shows
--
-- So a review notification disappears the moment anyone decides the request,
-- including when a *different* reviewer gets there first, and nothing has to go
-- back and mark it read.
--
-- V9 warned that "a future type with a null prayer_request_id would not be
-- deduped by this". That still holds, and this type is not one: the CHECK above
-- requires the reference for both.
-- ---------------------------------------------------------------------------
