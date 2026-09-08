-- ---------------------------------------------------------------------------
-- Map View: coordinates for addresses, an address for each church, and a
-- per-organization switch.
--
-- Coordinates live in their own table keyed by Google's `place_id` rather than
-- in columns on `persons`, for three reasons. Google's terms allow `place_id`
-- to be stored indefinitely but only allow `lat`/`lng` to be cached for 30
-- days unless the value is isolated to the one end user who looked it up --
-- which a parish map showing every home to every member is not -- so the
-- coordinates are a refreshable cache with an age on them, and the durable key
-- is the `place_id`. A shared table means the refresh job walks distinct
-- addresses rather than distinct people, and a family of five at one address
-- costs one geocode instead of five. And "everyone at the same address shares
-- one pin" becomes a group by a primary key rather than a comparison of two
-- floating point numbers, which is never quite right.
-- ---------------------------------------------------------------------------
create table geocoded_addresses (
  place_id          text primary key,
  formatted_address text not null,
  -- Nullable together: a `place_id` Google no longer recognises keeps its row
  -- and loses its coordinates, so the address survives and the person simply
  -- falls off the map.
  latitude          double precision,
  longitude         double precision,
  geocoded_at       timestamptz not null default now(),
  constraint geocoded_addresses_coords_together
    check ((latitude is null) = (longitude is null))
);

-- The refresh job's only query: oldest first, up to a batch.
create index geocoded_addresses_stale_idx on geocoded_addresses (geocoded_at);

alter table persons add column place_id text references geocoded_addresses (place_id);
create index persons_place_id_idx on persons (place_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The church's own address. "We need to be able to associate an address for
-- the church with each organization" -- the map opens centred on it, and falls
-- back to the centroid of the parish when it is missing.
--
-- `map_view_enabled` is off until a super admin turns it on. Off is the right
-- default twice over: a parish that has just been created has no church
-- address either, so its map would open on a centroid with nothing to centre
-- on; and this flag is the one lever that reliably drives the Google bill, so
-- switching it on should be somebody's decision rather than an inheritance.
-- It gates four things -- the browser API key, the map endpoint, the page, and
-- geocoding itself -- so a parish with it off makes no calls to Google at all.
-- ---------------------------------------------------------------------------
alter table organizations
  add column address_line1    text,
  add column address_line2    text,
  add column city             text,
  add column state            text,
  add column postal_code      text,
  add column country          text,
  add column place_id         text references geocoded_addresses (place_id),
  add column map_view_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- persons_resolved has to be recreated: it enumerates its columns, so
-- `place_id` is invisible to every read path until it is listed here.
-- Reproduced verbatim from V6__family_member_order.sql with the one new column
-- appended -- `create or replace view` only accepts additions at the end.
--
-- `place_id` resolves through the same `ad` join as the six address columns,
-- because an address is inherited as a unit: a child who takes their parent's
-- address has to land on their parent's pin, not on none.
--
-- It is deliberately absent from `search_text`. That column backs "matches
-- anything in any data field", and a `place_id` is an opaque Google identifier
-- no member has ever seen -- a search term hitting one would be a match the
-- directory could not explain.
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
  p.family_order,
  case when p.inherit_address_from_person_id is not null then ad.place_id else p.place_id end
    as place_id
from persons p
  left join families f on f.id = p.family_id
  left join persons ln on ln.id = p.inherit_last_name_from_person_id
  left join persons em on em.id = p.inherit_email_from_person_id
  left join persons ph on ph.id = p.inherit_phone_from_person_id
  left join persons ap on ap.id = p.inherit_alt_phone_from_person_id
  left join persons ad on ad.id = p.inherit_address_from_person_id;
