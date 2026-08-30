-- Church directory: initial schema.
--
-- Multi-tenant by `organization_id` on every domain table. A "Person" is the
-- central concept and covers both people with an account (`app_user_id` set)
-- and family members without one (children, for example).

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$ language plpgsql;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  slug        citext      not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint organizations_name_not_blank check (btrim(name) <> ''),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- app_users -- an account. Role and organization live here rather than in
-- Cognito groups: a group cannot express "which organization is this admin
-- scoped to", and mirroring roles into Cognito only creates drift.
--
-- `cognito_sub` is normally written when an admin invites the user (the API
-- calls AdminCreateUser and gets the sub back in the same request). It stays
-- null only for the bootstrap super admin, who is inserted by migration
-- before any Cognito user exists and bound by email on first sign-in.
-- ---------------------------------------------------------------------------
create table app_users (
  id              uuid primary key default gen_random_uuid(),
  cognito_sub     text        unique,
  email           citext      not null unique,
  role            text        not null,
  organization_id uuid        references organizations (id) on delete restrict,
  status          text        not null default 'INVITED',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint app_users_role_valid check (role in ('SUPER_ADMIN', 'ADMIN', 'USER')),
  constraint app_users_status_valid check (status in ('INVITED', 'ACTIVE', 'DISABLED')),
  -- "each admin must be assigned to an organization"; only super admins,
  -- who are cross-organization by definition, may have none.
  constraint app_users_org_required_unless_super_admin
    check (role = 'SUPER_ADMIN' or organization_id is not null)
);

create index app_users_organization_id_idx on app_users (organization_id);

create trigger app_users_set_updated_at
  before update on app_users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- families
-- ---------------------------------------------------------------------------
create table families (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid        not null references organizations (id) on delete restrict,
  name                 text        not null,
  photo_key            text,
  created_by_person_id uuid,  -- FK added after `persons` exists
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint families_name_not_blank check (btrim(name) <> '')
);

create index families_organization_id_idx on families (organization_id, name);

create trigger families_set_updated_at
  before update on families
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- persons
--
-- The five `inherit_*_from_person_id` columns implement "a Person that is a
-- member of a family can choose to inherit these attributes from another
-- family member". One nullable self-FK per inheritable attribute rather than a
-- generic (person, attribute, source) table: the set of inheritable
-- attributes is fixed by the requirements, and this keeps resolution a plain
-- join instead of a pivot. The six address columns share a single pointer
-- because an address is inherited as a unit.
--
-- The invariants on those pointers -- same family, same organization, not
-- self, and the source must not itself inherit that attribute (one hop only,
-- so no cycles) -- are enforced in the API service layer, which can return a
-- useful error message. See api/src/services/inheritance.ts.
-- ---------------------------------------------------------------------------
create table persons (
  id                                uuid primary key default gen_random_uuid(),
  organization_id                   uuid        not null references organizations (id) on delete restrict,
  family_id                         uuid        references families (id) on delete set null,
  app_user_id                       uuid        unique references app_users (id) on delete set null,

  first_name                        text        not null,
  last_name                         text,
  email                             citext,
  phone                             text,
  alt_phone                         text,

  address_line1                     text,
  address_line2                     text,
  city                              text,
  state                             text,
  postal_code                       text,
  country                           text,

  patron_saint                      text,
  photo_key                         text,

  inherit_email_from_person_id      uuid references persons (id) on delete set null,
  inherit_phone_from_person_id      uuid references persons (id) on delete set null,
  inherit_alt_phone_from_person_id  uuid references persons (id) on delete set null,
  inherit_last_name_from_person_id  uuid references persons (id) on delete set null,
  inherit_address_from_person_id    uuid references persons (id) on delete set null,

  deleted_at                        timestamptz,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),

  constraint persons_first_name_not_blank check (btrim(first_name) <> ''),
  constraint persons_phone_e164 check (phone is null or phone ~ '^\+[1-9][0-9]{1,14}$'),
  constraint persons_alt_phone_e164 check (alt_phone is null or alt_phone ~ '^\+[1-9][0-9]{1,14}$'),
  constraint persons_no_self_inheritance check (
    id <> coalesce(inherit_email_from_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and id <> coalesce(inherit_phone_from_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and id <> coalesce(inherit_alt_phone_from_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and id <> coalesce(inherit_last_name_from_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and id <> coalesce(inherit_address_from_person_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  -- Inheriting only makes sense inside a family.
  constraint persons_inheritance_requires_family check (
    family_id is not null
    or (inherit_email_from_person_id is null
        and inherit_phone_from_person_id is null
        and inherit_alt_phone_from_person_id is null
        and inherit_last_name_from_person_id is null
        and inherit_address_from_person_id is null)
  )
);

alter table families
  add constraint families_created_by_person_id_fkey
  foreign key (created_by_person_id) references persons (id) on delete set null;

-- Browse is "the entire directory, sorted by last name", always scoped to one
-- organization. Search is also organization-scoped, so filtering on
-- organization_id first reduces the ILIKE to a small subset -- see the note in
-- api/src/routes/directory.ts.
create index persons_browse_idx
  on persons (organization_id, last_name, first_name)
  where deleted_at is null;
create index persons_family_id_idx on persons (family_id) where deleted_at is null;
create index persons_inherit_email_idx on persons (inherit_email_from_person_id);
create index persons_inherit_phone_idx on persons (inherit_phone_from_person_id);
create index persons_inherit_alt_phone_idx on persons (inherit_alt_phone_from_person_id);
create index persons_inherit_last_name_idx on persons (inherit_last_name_from_person_id);
create index persons_inherit_address_idx on persons (inherit_address_from_person_id);

create trigger persons_set_updated_at
  before update on persons
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- persons_resolved -- inheritance applied once, in the database, so every read
-- path gets the same answer. Writes go to `persons`.
--
-- `search_text` backs "search for users where the search contents match
-- anything in any data field": it concatenates every resolved field so the
-- route can do a single ILIKE.
-- ---------------------------------------------------------------------------
create view persons_resolved as
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
  f.name as family_name
from persons p
  left join families f on f.id = p.family_id
  left join persons ln on ln.id = p.inherit_last_name_from_person_id
  left join persons em on em.id = p.inherit_email_from_person_id
  left join persons ph on ph.id = p.inherit_phone_from_person_id
  left join persons ap on ap.id = p.inherit_alt_phone_from_person_id
  left join persons ad on ad.id = p.inherit_address_from_person_id;

-- ---------------------------------------------------------------------------
-- family_join_requests -- "other users can associate themselves with any
-- family", gated by approval from someone already in that family (or an admin)
-- so that a parishioner cannot add themselves to your family and start editing
-- your children's records.
-- ---------------------------------------------------------------------------
create table family_join_requests (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid        not null references organizations (id) on delete restrict,
  family_id             uuid        not null references families (id) on delete cascade,
  person_id             uuid        not null references persons (id) on delete cascade,
  status                text        not null default 'PENDING',
  requested_at          timestamptz not null default now(),
  decided_at            timestamptz,
  decided_by_person_id  uuid        references persons (id) on delete set null,
  constraint family_join_requests_status_valid
    check (status in ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED')),
  constraint family_join_requests_decided_consistently
    check ((status = 'PENDING') = (decided_at is null))
);

create unique index family_join_requests_one_pending_idx
  on family_join_requests (family_id, person_id)
  where status = 'PENDING';
create index family_join_requests_family_idx on family_join_requests (family_id, status);
create index family_join_requests_person_idx on family_join_requests (person_id, status);

-- ---------------------------------------------------------------------------
-- special_dates
--
-- `year is null` means month/day only. `show_year_count` is the opt-in to
-- showing an age (birthdays) or a number of years (anniversaries), which is
-- why it requires a year.
--
-- A feast day is the person's patron saint's day, so it carries no label of
-- its own -- the name comes from persons.patron_saint.
-- ---------------------------------------------------------------------------
create table special_dates (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid        not null references organizations (id) on delete restrict,
  person_id          uuid        not null references persons (id) on delete cascade,
  related_person_id  uuid        references persons (id) on delete cascade,
  type               text        not null,
  month              smallint    not null,
  day                smallint    not null,
  year               smallint,
  show_year_count    boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint special_dates_type_valid check (type in ('BIRTHDAY', 'ANNIVERSARY', 'FEAST_DAY')),
  constraint special_dates_month_valid check (month between 1 and 12),
  constraint special_dates_day_valid check (day between 1 and 31),
  constraint special_dates_year_valid check (year is null or year between 1800 and 2200),
  -- Cannot show an age without a birth year.
  constraint special_dates_year_count_needs_year
    check (show_year_count = false or year is not null),
  -- "When someone creates a wedding anniversary, that special date must link
  -- two Persons", and it must be a full month/day/year.
  constraint special_dates_anniversary_shape check (
    type <> 'ANNIVERSARY' or (year is not null and related_person_id is not null)
  ),
  -- Feast days are month and day only.
  constraint special_dates_feast_day_shape check (
    type <> 'FEAST_DAY' or (year is null and related_person_id is null)
  ),
  constraint special_dates_birthday_shape check (
    type <> 'BIRTHDAY' or related_person_id is null
  ),
  constraint special_dates_related_person_differs check (
    related_person_id is null or related_person_id <> person_id
  ),
  constraint special_dates_real_date check (
    -- Reject 31 April etc. Feb 29 is allowed with a null year (recurring) and
    -- validated against the year when one is given.
    case
      when month in (1, 3, 5, 7, 8, 10, 12) then day <= 31
      when month in (4, 6, 9, 11) then day <= 30
      when year is null then day <= 29
      else day <= 28 + (
        case when (year % 4 = 0 and year % 100 <> 0) or year % 400 = 0 then 1 else 0 end
      )
    end
  )
);

-- The upcoming-dates query filters on (month, day) within one organization.
create index special_dates_upcoming_idx on special_dates (organization_id, month, day);
create index special_dates_person_idx on special_dates (person_id);
create index special_dates_related_person_idx on special_dates (related_person_id);

-- A couple's anniversary is one row, not one per spouse.
create unique index special_dates_anniversary_pair_idx
  on special_dates (least(person_id, related_person_id), greatest(person_id, related_person_id))
  where type = 'ANNIVERSARY';

-- One patron saint, one name day.
create unique index special_dates_one_feast_day_idx
  on special_dates (person_id)
  where type = 'FEAST_DAY';

-- One birthday per person.
create unique index special_dates_one_birthday_idx
  on special_dates (person_id)
  where type = 'BIRTHDAY';

create trigger special_dates_set_updated_at
  before update on special_dates
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log -- admins can edit other people's records, so keep a trail.
-- ---------------------------------------------------------------------------
create table audit_log (
  id                  bigserial primary key,
  organization_id     uuid        references organizations (id) on delete set null,
  actor_app_user_id   uuid        references app_users (id) on delete set null,
  action              text        not null,
  entity_type         text        not null,
  entity_id           uuid,
  changes             jsonb,
  created_at          timestamptz not null default now()
);

create index audit_log_org_created_idx on audit_log (organization_id, created_at desc);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);
