-- ---------------------------------------------------------------------------
-- Custom ordering of family members.
--
-- "Custom ordering of family members (drag and drop) - only admins and family
-- members can set ordering". A plain integer per person rather than a
-- fractional index or a linked list: a family is a handful of people, so the
-- reorder endpoint rewrites the whole list in one statement and never has to
-- rebalance anything.
--
-- Null means "nobody has ordered this family yet", which is why every read
-- sorts `family_order asc nulls last` and falls back to the name ordering the
-- page used before this column existed. It is also why the column is not
-- `not null default 0`: that would claim an intentional order for every family
-- in the parish on the day this migration ran.
-- ---------------------------------------------------------------------------
alter table persons add column family_order int;

-- A position is meaningless without a family to hold it, and `family_order` is
-- cleared by the API wherever `family_id` changes -- this is the backstop.
alter table persons add constraint persons_family_order_requires_family
  check (family_order is null or family_id is not null);

create index persons_family_order_idx
  on persons (family_id, family_order) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- persons_resolved has to be recreated: it enumerates its columns, so
-- `family_order` is invisible to every read path until it is listed here.
-- Reproduced verbatim from V1__init.sql with the one new column appended --
-- `create or replace view` only accepts additions at the end.
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
    f.name
  ) as search_text,
  f.name as family_name,
  p.family_order
from persons p
  left join families f on f.id = p.family_id
  left join persons ln on ln.id = p.inherit_last_name_from_person_id
  left join persons em on em.id = p.inherit_email_from_person_id
  left join persons ph on ph.id = p.inherit_phone_from_person_id
  left join persons ap on ap.id = p.inherit_alt_phone_from_person_id
  left join persons ad on ad.id = p.inherit_address_from_person_id;
