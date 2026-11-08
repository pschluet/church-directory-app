-- Email as a third way to hear about a notification, after the bell and push.
--
-- Opt in, per account, and off by default -- unlike every other switch on
-- notification_preferences. A bell badge and a push are things a member set up
-- the app to show them; an email lands in an inbox they share with the rest of
-- their life, and a parish that started mailing two hundred people about every
-- group message would be marked as spam within the week. Spam complaints
-- against this domain would also hold up the sign-in code, which goes out from
-- the same address.
--
-- What to email is not decided here. It is the `notifications` rows: every
-- fan-out already writes one per recipient after applying the topic switches
-- and the per-group exceptions, so "email me" means "email me whatever my bell
-- gets" and needs no second copy of those rules. A scheduled function (see
-- api/src/services/notification-email.ts) sends what is pending a few minutes
-- after it arrives, batched per person, and stamps `emailed_at`.

alter table notification_preferences
  add column email_enabled boolean not null default false,
  -- When email was last switched on. The sender never reaches back past it, so
  -- switching on does not mail a day's backlog of things already in the bell.
  add column email_enabled_at timestamptz,
  -- The only credential the one-click unsubscribe link carries. A random
  -- per-account value rather than a signature, so there is no new secret to
  -- get into the sender: it is looked up, and an unknown one matches nothing.
  add column email_unsubscribe_token uuid not null default gen_random_uuid();

create unique index notification_preferences_unsubscribe_token_idx
  on notification_preferences (email_unsubscribe_token);

-- Set once a notification has gone out by email, so the next run does not send
-- it again. Null forever for the many accounts that never switch email on --
-- which is why there is no index on it: the sender starts from the few accounts
-- with `email_enabled` and reaches their rows through notifications_unread_idx.
alter table notifications
  add column emailed_at timestamptz;
