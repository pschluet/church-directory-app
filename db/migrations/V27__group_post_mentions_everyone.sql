-- @everyone: a post can mention every member of its group at once.
--
-- A flag on the post rather than one group_post_mentions row per member: the
-- client cannot know the whole membership's ids within the 50-id cap on
-- mentionedAppUserIds, and copying the roster into every such post would bloat
-- each one's mentions JSON for no gain. The flag means "whoever is a member
-- when it is sent" -- the fan-out reads group_members at that moment, which is
-- the same set a row-per-member copy would have captured.
--
-- It counts as a mention for notification preferences: a member on "mentions
-- only" is notified, a member who turned the group off is not (see
-- services/group-notifications.ts).
alter table group_posts
  add column mentions_everyone boolean not null default false;
