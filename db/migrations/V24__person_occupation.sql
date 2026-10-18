-- ---------------------------------------------------------------------------
-- Occupation: what a person does for a living, free text.
--
-- Free text rather than a lookup table because the suggestions are drawn from
-- what other members have already typed -- see GET /directory/occupations --
-- so the column is the vocabulary, and nobody has to curate a list.
--
-- Lower-cased in the index because the suggestion query groups on lower(): it
-- treats "Teacher" and "teacher" as one entry.
-- ---------------------------------------------------------------------------
alter table persons add column occupation text;

create index persons_occupation_idx
  on persons (organization_id, lower(occupation))
  where deleted_at is null and occupation is not null;

-- ---------------------------------------------------------------------------
-- persons_resolved has to be recreated: it enumerates its columns, so
-- `occupation` is invisible to every read path until it is listed here.
-- Reproduced verbatim from V14__map_view.sql with the one new column appended
-- -- `create or replace view` only accepts additions at the end.
--
-- Unlike `place_id`, occupation IS part of `search_text`: it is something a
-- member can see on the profile, so "matches anything in any data field" should
-- match it. Occupation is not inheritable, so it is read straight off `p`.
-- ---------------------------------------------------------------------------
create or replace view persons_resolved as
select
  p.id,
  p.organization_id,
  p.family_id,
  p.app_user_id,
  p.first_name,
  case when p.inherit_last_name_from_person_id is not null then ln.last_name else p.last_name end
    as last_name,
  case when p.inherit_email_from_person_id is not null then em.email else p.email end
    as email,
  case when p.inherit_phone_from_person_id is not null then ph.phone else p.phone end
    as phone,
  case when p.inherit_alt_phone_from_person_id is not null then ap.alt_phone else p.alt_phone end
    as alt_phone,
  case when p.inherit_address_from_person_id is not null then ad.address_line1 else p.address_line1 end
    as address_line1,
  case when p.inherit_address_from_person_id is not null then ad.address_line2 else p.address_line2 end
    as address_line2,
  case when p.inherit_address_from_person_id is not null then ad.city else p.city end
    as city,
  case when p.inherit_address_from_person_id is not null then ad.state else p.state end
    as state,
  case when p.inherit_address_from_person_id is not null then ad.postal_code else p.postal_code end
    as postal_code,
  case when p.inherit_address_from_person_id is not null then ad.country else p.country end
    as country,
  p.patron_saint,
  p.photo_key,
  p.inherit_email_from_person_id,
  p.inherit_phone_from_person_id,
  p.inherit_alt_phone_from_person_id,
  p.inherit_last_name_from_person_id,
  p.inherit_address_from_person_id,
  p.deleted_at,
  p.created_at,
  p.updated_at,
  concat_ws(' ',
    p.first_name,
    case when p.inherit_last_name_from_person_id is not null then ln.last_name else p.last_name end,
    case when p.inherit_email_from_person_id is not null then em.email else p.email end,
    case when p.inherit_phone_from_person_id is not null then ph.phone else p.phone end,
    case when p.inherit_alt_phone_from_person_id is not null then ap.alt_phone else p.alt_phone end,
    case when p.inherit_address_from_person_id is not null then ad.address_line1 else p.address_line1 end,
    case when p.inherit_address_from_person_id is not null then ad.address_line2 else p.address_line2 end,
    case when p.inherit_address_from_person_id is not null then ad.city else p.city end,
    case when p.inherit_address_from_person_id is not null then ad.state else p.state end,
    case when p.inherit_address_from_person_id is not null then ad.postal_code else p.postal_code end,
    case when p.inherit_address_from_person_id is not null then ad.country else p.country end,
    p.patron_saint,
    p.occupation,
    f.name
  ) as search_text,
  f.name as family_name,
  p.family_order,
  case when p.inherit_address_from_person_id is not null then ad.place_id else p.place_id end
    as place_id,
  p.occupation
from persons p
  left join families f on f.id = p.family_id
  left join persons ln on ln.id = p.inherit_last_name_from_person_id
  left join persons em on em.id = p.inherit_email_from_person_id
  left join persons ph on ph.id = p.inherit_phone_from_person_id
  left join persons ap on ap.id = p.inherit_alt_phone_from_person_id
  left join persons ad on ad.id = p.inherit_address_from_person_id;
