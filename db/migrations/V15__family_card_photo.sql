-- Whether a family's current photo_key has a third rendition framed for the
-- families-page card.
--
-- A family photo is cropped once, free-form, for the family's own page, and
-- that crop is what the families list used to show too -- centre-cropped into
-- a fixed 3:2 box, which is not what anyone framed. The card rendition is a
-- second, independent crop taken from the whole original and stored alongside
-- `thumb`/`full` under the same key prefix.
--
-- False for every row that predates this: those families keep rendering the
-- `thumb` rendition in the card box exactly as before, with no backfill.
-- Replacing or clearing a photo always rewrites this alongside `photo_key`, so
-- the flag can never describe an image that is no longer there.

alter table families
  add column photo_has_card boolean not null default false;

alter table families
  add constraint families_photo_card_needs_key
    check (not photo_has_card or photo_key is not null);
