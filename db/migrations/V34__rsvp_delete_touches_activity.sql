-- Taking back an RSVP moves the group's activity stamp, so pages already open
-- see the answer disappear. V20 left deletes alone (retention and whole-group
-- deletes shouldn't wake anyone), but a member withdrawing their own answer is
-- something an open page should react to. A separate function: on delete there
-- is no `new` row.
create function touch_group_activity_for_rsvp_delete() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp()
   where id = (select group_id from group_posts where id = old.post_id);
  return old;
end;
$fn$ language plpgsql;

create trigger group_event_rsvps_touch_activity_on_delete
  after delete on group_event_rsvps
  for each row execute function touch_group_activity_for_rsvp_delete();
