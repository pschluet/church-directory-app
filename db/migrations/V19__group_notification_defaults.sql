-- An account-level default for group notifications, with per-group exceptions.
--
-- Until now the only group preference was `group_members.notification_pref`,
-- `not null default 'ALL'`: a member of fifteen groups had to open fifteen
-- members-modals to turn the volume down, and nothing showed what they had set.
--
-- The model after this migration:
--
--   notification_preferences.group_notification_pref   the account's default
--   group_members.notification_pref                    null = follow the default;
--                                                      non-null = an exception
--
-- The effective preference is
-- `coalesce(gm.notification_pref, np.group_notification_pref, 'ALL')`. The
-- trailing 'ALL' covers an account with no notification_preferences row at all
-- -- that table is sparse, and a missing row has always meant "every default is
-- on" (see routes/notifications.ts), which is why nothing needs backfilling there.
--
-- Three-valued rather than a boolean, because the two group questions ("tell me
-- about everything" and "tell me only when I am mentioned") are different
-- things to want, exactly as V12 found for approval notifications.
--
-- Behaviour on the deploy that adds this is identical for every account, the
-- same promise V12 makes. Every existing membership either says 'MENTIONS' or
-- 'NONE' (a genuine choice, kept as an exception) or says 'ALL' -- which was
-- both the default and a deliberate choice, indistinguishable now. Those become
-- null ("follow my default"), and since every account's default starts at 'ALL'
-- they behave as before. The one accepted loss: somebody who had deliberately
-- chosen "all posts" will follow their default if they later change it.
--
-- The column default on group_members has to go. Joining a group inserts a row
-- without naming this column; with the default left at 'ALL' every new
-- membership would be a pinned exception and the account default would never
-- apply to any group joined after today. group_members_notification_pref_valid
-- needs no change: a CHECK passes when its expression is null.

alter table notification_preferences
  add column group_notification_pref text not null default 'ALL';

alter table notification_preferences
  add constraint notification_preferences_group_notification_pref_valid
    check (group_notification_pref in ('ALL', 'MENTIONS', 'NONE'));

alter table group_members
  alter column notification_pref drop default,
  alter column notification_pref drop not null;

update group_members
   set notification_pref = null
 where notification_pref = 'ALL';

-- The Settings page lists "this account's exceptions". Partial, because most
-- memberships follow the default and are never read by that query.
create index group_members_app_user_exception_idx
  on group_members (app_user_id)
  where notification_pref is not null;
