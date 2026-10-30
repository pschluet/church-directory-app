-- A name day is usually a fixed day on the calendar (a saint whose feast falls
-- on the same month and day every year), but many Orthodox commemorations
-- move with Pascha -- "the Sunday of the Myrrh-bearing Women", "the Sunday
-- before Nativity". Those people have had no way to record a correct name
-- day at all.
--
-- A relative name day is stored as a *rule* -- a reference feast, a
-- direction, and either a day count or a weekday count -- rather than as a
-- resolved month/day. The actual date moves from year to year and is worked
-- out in TypeScript (see api/src/types.ts's moveable-feast helpers), not here:
-- a Postgres function would duplicate that algorithm in a second language for
-- no benefit, since every read already goes through the API.
--
-- So a row now has exactly one of two shapes: the existing (month, day) pair,
-- or (rule_reference, rule_direction, rule_unit, rule_count, rule_weekday).
-- Only a FEAST_DAY may take the second shape -- a birthday or anniversary is
-- always a fixed day.

alter table special_dates
  alter column month drop not null,
  alter column day   drop not null,
  add column rule_reference text,
  add column rule_direction text,
  add column rule_unit      text,
  add column rule_count     smallint,
  add column rule_weekday   smallint;

alter table special_dates
  drop constraint special_dates_month_valid,
  drop constraint special_dates_day_valid,
  drop constraint special_dates_real_date;

alter table special_dates
  add constraint special_dates_month_valid check (month is null or month between 1 and 12),
  add constraint special_dates_day_valid check (day is null or day between 1 and 31),
  -- Reject 31 April etc. Feb 29 is allowed with a null year (recurring) and
  -- validated against the year when one is given. Unchanged except for the
  -- new `month is null or day is null` escape for a relative row.
  add constraint special_dates_real_date check (
    month is null or day is null or
    case
      when month in (1, 3, 5, 7, 8, 10, 12) then day <= 31
      when month in (4, 6, 9, 11) then day <= 30
      when year is null then day <= 29
      else day <= 28 + (
        case when (year % 4 = 0 and year % 100 <> 0) or year % 400 = 0 then 1 else 0 end
      )
    end
  ),
  -- Exactly one shape: a fixed (month, day), or a rule. Never both, never
  -- neither.
  add constraint special_dates_shape_exclusive check (
    (month is not null and day is not null and rule_reference is null)
    or
    (month is null and day is null and rule_reference is not null)
  ),
  -- A rule is a day-only thing, same as the fixed shape it replaces.
  add constraint special_dates_rule_only_feast_day check (
    rule_reference is null or type = 'FEAST_DAY'
  ),
  add constraint special_dates_rule_reference_valid check (
    rule_reference is null or rule_reference in
      ('PASCHA', 'PALM_SUNDAY', 'ASCENSION', 'PENTECOST', 'NATIVITY', 'THEOPHANY')
  ),
  add constraint special_dates_rule_direction_valid check (
    rule_direction is null or rule_direction in ('BEFORE', 'AFTER')
  ),
  add constraint special_dates_rule_unit_valid check (
    rule_unit is null or rule_unit in ('DAYS', 'WEEKDAY')
  ),
  -- 0 = Sunday .. 6 = Saturday, set only when counting a weekday.
  add constraint special_dates_rule_weekday_valid check (
    (rule_unit = 'WEEKDAY') = (rule_weekday is not null)
    and (rule_weekday is null or rule_weekday between 0 and 6)
  ),
  -- A day offset may be 0 (the feast itself). Counting weekdays starts at 1 --
  -- "1 Sunday after Pascha" means the first Sunday strictly after it, not
  -- Pascha, which is itself always a Sunday.
  add constraint special_dates_rule_count_valid check (
    rule_count is null
    or (rule_unit = 'DAYS' and rule_count between 0 and 365)
    or (rule_unit = 'WEEKDAY' and rule_count between 1 and 52)
  ),
  -- A rule's other three fields are set exactly when the reference is.
  add constraint special_dates_rule_complete check (
    (rule_reference is null) = (rule_direction is null)
    and (rule_reference is null) = (rule_unit is null)
    and (rule_reference is null) = (rule_count is null)
  );

-- The upcoming-dates query's (month, day) filter can never match a relative
-- row, so the index that serves it only needs the fixed-shape rows.
drop index special_dates_upcoming_idx;
create index special_dates_upcoming_idx
  on special_dates (organization_id, month, day)
  where month is not null;

-- The handful of relative rows per organization, fetched once per
-- upcoming-dates request and resolved in TypeScript.
create index special_dates_relative_idx
  on special_dates (organization_id)
  where rule_reference is not null;
