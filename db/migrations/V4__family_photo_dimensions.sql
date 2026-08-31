-- The intrinsic pixel size of a family's photo.
--
-- Person photos are cropped square and rendered into a box fixed by CSS, so
-- their aspect ratio is known ahead of time and needs no column. A family photo
-- is cropped free-form -- it shows as the whole photo rather than a circle -- so
-- its ratio is whatever rectangle the uploader dragged. Without the dimensions
-- the SPA cannot reserve the right box, and every family photo shifts the page
-- as it paints.
--
-- Null for the photos that predate cropping; the UI falls back to a fixed box
-- for those.

alter table families
  add column photo_width  int,
  add column photo_height int;

alter table families
  add constraint families_photo_dimensions_together
    check ((photo_width is null) = (photo_height is null)),
  add constraint families_photo_width_positive  check (photo_width  is null or photo_width  > 0),
  add constraint families_photo_height_positive check (photo_height is null or photo_height > 0);
