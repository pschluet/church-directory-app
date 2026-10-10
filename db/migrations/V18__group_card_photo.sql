-- Whether a group's current photo_key has a third rendition framed for the
-- groups-page card -- the exact counterpart of V15__family_card_photo.sql,
-- now that a group's cover photo gets the same two-step crop a family's does
-- (see PhotoCropper.tsx). The groups list box is pixel-identical to the
-- families list box (both render --aspect-card-photo, 3:2), which is why this
-- reuses the same card rendition machinery in photos.ts rather than inventing
-- a second one.
--
-- False for every row that predates this: those groups keep rendering the
-- `thumb` rendition in the card box exactly as before, with no backfill.
-- Replacing or clearing a photo always rewrites this alongside `photo_key`, so
-- the flag can never describe an image that is no longer there.

alter table groups
  add column photo_has_card boolean not null default false;

alter table groups
  add constraint groups_photo_card_needs_key
    check (not photo_has_card or photo_key is not null);
