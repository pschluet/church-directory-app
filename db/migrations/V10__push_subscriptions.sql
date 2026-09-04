-- Web Push subscriptions: one row per device, not per person.
--
-- A push subscription is issued by the browser, to the browser. Somebody with
-- the directory on a phone and on a laptop has two of them and expects a
-- notification on both, so `app_user_id` is not unique here. What is unique is
-- the endpoint: the push service mints it and it identifies exactly one
-- installed copy of the app.
--
-- Making the endpoint the natural key is what lets the subscribe endpoint be a
-- plain upsert. Two cases need it. A browser re-subscribing usually hands back
-- the identical subscription, so the same row must be updated rather than
-- rejected; and a shared phone signed into a second account presents the same
-- endpoint under a different `app_user_id`, where the *last* person to sign in
-- is the one who should get the notifications -- so the row moves.
--
-- Nothing is stored here that is not needed to send: the endpoint to POST to and
-- the two keys the payload is encrypted with (RFC 8291). `user_agent` is for a
-- human reading the settings page -- "iPhone" or "Mac" is the difference between
-- a list of devices and a list of opaque URLs.
--
-- Rotating the VAPID keypair (scripts/create-push-key.sh) invalidates every row
-- in this table: the subscriptions were issued against the old public key. The
-- dead ones clear themselves out, because a push to one answers 404 or 410 and
-- api/src/services/push.ts deletes it.

create table push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  app_user_id     uuid        not null references app_users (id) on delete cascade,
  organization_id uuid        not null references organizations (id) on delete restrict,
  endpoint        text        not null unique,
  p256dh          text        not null,
  auth            text        not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  -- Touched on every re-subscribe, which the SPA does on each load, so a row
  -- that has not been seen for months is a device that is gone.
  last_seen_at    timestamptz not null default now(),

  constraint push_subscriptions_endpoint_is_https check (endpoint like 'https://%')
);

create index push_subscriptions_app_user_idx on push_subscriptions (app_user_id);
