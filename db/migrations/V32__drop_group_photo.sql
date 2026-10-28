-- Groups no longer have a cover photo. The groups page became a dense one-line
-- list with nowhere to show one, and the photo was already kept off the
-- group's own page (it pushed the messages down), so nothing displays it.
--
-- The stored images are not referenced from anywhere else: they live under
-- their own `photos/<org>/group/<groupId>/` prefix (distinct from the
-- `group-post/` attachments), so scripts/delete-group-photos.sh can remove
-- them by prefix whether it runs before or after this migration.

alter table groups
  drop constraint groups_photo_card_needs_key,
  drop constraint groups_photo_dimensions_together;

alter table groups
  drop column photo_key,
  drop column photo_width,
  drop column photo_height,
  drop column photo_has_card;
