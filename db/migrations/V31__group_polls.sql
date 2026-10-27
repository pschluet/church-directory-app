-- Polls: a third kind of group post, beside MESSAGE and EVENT. A question,
-- two or more options, and a switch for whether a member may pick one option
-- or several.
--
-- Like an event, a poll keeps its content in its own table and leaves
-- group_posts.body null, so the "structured posts have no body" check widens
-- from EVENT to everything that is not a MESSAGE.
--
-- Votes are one row per (option, person). Single choice is not a constraint
-- here -- "at most one row per (post, person) when allows_multiple is false"
-- is a cross-table rule -- so the vote route enforces it by replacing the
-- caller's whole ballot in one transaction. The (post_id, app_user_id) index
-- is what that replacement deletes by.
--
-- A poll cannot be edited once posted: changing an option under somebody's
-- vote would change what they voted for. Everything cascades from the post,
-- so retention's hard delete takes the options and votes with it.

alter table group_posts drop constraint group_posts_kind_valid;
alter table group_posts
  add constraint group_posts_kind_valid check (kind in ('MESSAGE', 'EVENT', 'POLL'));

alter table group_posts drop constraint group_posts_event_has_no_body;
alter table group_posts
  add constraint group_posts_only_message_has_body check (kind = 'MESSAGE' or body is null);

create table group_polls (
  post_id         uuid    primary key references group_posts (id) on delete cascade,
  question        text    not null,
  allows_multiple boolean not null default false,

  constraint group_polls_question_not_blank check (btrim(question) <> '')
);

create table group_poll_options (
  id        uuid primary key default gen_random_uuid(),
  post_id   uuid not null references group_polls (post_id) on delete cascade,
  label     text not null,
  position  int  not null,

  constraint group_poll_options_label_not_blank check (btrim(label) <> ''),
  constraint group_poll_options_position_not_negative check (position >= 0),
  constraint group_poll_options_position_unique unique (post_id, position)
);

create table group_poll_votes (
  post_id      uuid        not null references group_polls (post_id) on delete cascade,
  option_id    uuid        not null references group_poll_options (id) on delete cascade,
  app_user_id  uuid        not null references app_users (id) on delete cascade,
  created_at   timestamptz not null default clock_timestamp(),

  constraint group_poll_votes_pkey primary key (option_id, app_user_id)
);

create index group_poll_votes_post_user_idx on group_poll_votes (post_id, app_user_id);

-- Voting moves the group's activity stamp so an open page's poll (see V20)
-- refetches and everyone watching sees the results change. Taking a vote back
-- counts too, the same reasoning V22 gives for reactions.
create function touch_group_activity_for_poll_vote() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp()
   where id = (select group_id from group_posts where id = coalesce(new.post_id, old.post_id));
  return coalesce(new, old);
end;
$fn$ language plpgsql;

create trigger group_poll_votes_touch_activity
  after insert or delete on group_poll_votes
  for each row execute function touch_group_activity_for_poll_vote();
