-- Emoji reactions on group posts, as in Slack: a person can put any number of
-- different emoji on a message, each at most once, and sees who else did.
--
-- One row per (post, person, emoji). The primary key is what makes reacting
-- idempotent -- the route inserts with "on conflict do nothing" -- and its
-- leading column serves the per-post lookup the feed's SELECT does, so no
-- separate index on post_id alone is needed. The created_at index orders a
-- post's reactions (and each emoji's reactors) by who got there first.
--
-- The emoji is stored as the literal string, not a shortcode: the same emoji
-- can be spelled several ways in text but has one codepoint sequence, and the
-- client resolves names for display. The length check is a backstop only; the
-- route validates that the value is exactly one emoji.
--
-- Both keys cascade: a reaction means nothing without its post or its person,
-- and neither should be blocked from going away (retention hard-deletes posts).
create table group_post_reactions (
  post_id      uuid        not null references group_posts (id) on delete cascade,
  app_user_id  uuid        not null references app_users (id) on delete cascade,
  emoji        text        not null check (char_length(emoji) between 1 and 32),
  created_at   timestamptz not null default clock_timestamp(),

  constraint group_post_reactions_pkey primary key (post_id, app_user_id, emoji)
);

create index group_post_reactions_post_created_idx
  on group_post_reactions (post_id, created_at);

-- Reacting moves the group's activity stamp so an open page's poll (see V20)
-- picks it up, removing one included -- a reaction that vanishes on the other
-- screen is as much a change as one that appears. Like the RSVP trigger, the
-- group is looked up through the post. When the row is going away because its
-- post was hard-deleted (retention, or a whole group), that post is already
-- gone, the lookup finds nothing, and no stamp moves -- the same "a hard delete
-- is not something an open page reacts to" rule V20 sets.
create function touch_group_activity_for_reaction() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp()
   where id = (select group_id from group_posts where id = coalesce(new.post_id, old.post_id));
  return coalesce(new, old);
end;
$fn$ language plpgsql;

create trigger group_post_reactions_touch_activity
  after insert or delete on group_post_reactions
  for each row execute function touch_group_activity_for_reaction();
