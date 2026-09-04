-- Approvers can switch off "something needs your approval" on its own.
--
-- The two are genuinely different things to be told, so one switch could not
-- serve both: "a request was posted for the parish" is news, and "a request
-- needs you before anyone can see it" is a job. An approver might reasonably
-- want the second and not the first, or the first and not the second, and until
-- now `prayer_requests` governed both.
--
-- New rows default to true, so nobody has to opt in to being told about work
-- waiting for them.
--
-- Existing rows inherit whatever `prayer_requests` already said, which is the
-- point of doing this in three steps rather than one `add column ... default
-- true`. Somebody who had switched prayer request notifications off had, in
-- effect, switched approval notifications off too -- that is what the code did
-- before this migration -- and a schema change should not quietly start sending
-- them notifications they had already declined. Inheriting keeps every existing
-- account's behaviour identical on the deploy that adds the switch; they can
-- then split the two apart themselves.

alter table notification_preferences
  add column prayer_request_reviews boolean;

update notification_preferences
   set prayer_request_reviews = prayer_requests;

alter table notification_preferences
  alter column prayer_request_reviews set default true,
  alter column prayer_request_reviews set not null;
