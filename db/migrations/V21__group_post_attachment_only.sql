-- ---------------------------------------------------------------------------
-- A message may be nothing but pictures or files.
--
-- V16 tied `body` to the kind both ways: null exactly for an EVENT, present
-- exactly for a MESSAGE. That made a message with only an attachment
-- unrepresentable. Only the first half is kept: an EVENT's text still lives in
-- group_events and never here. Whether a MESSAGE has *something* to show (text
-- or at least one attachment) lives in the API, since a row-level check cannot
-- see another table. A present body is still never blank.
-- ---------------------------------------------------------------------------
alter table group_posts drop constraint group_posts_body_matches_kind;
alter table group_posts
  add constraint group_posts_event_has_no_body check (kind <> 'EVENT' or body is null);
