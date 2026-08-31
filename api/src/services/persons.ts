import { one, type Queryable } from "../db";
import type { Caller } from "../auth";
import { photoUrls } from "../photos";
import { canEditPerson } from "./access";
import { INHERIT_COLUMN } from "./inheritance";
import {
  INHERITABLE_ATTRIBUTES,
  fullName,
  type InheritableAttribute,
  type PersonDto,
  type PersonSummaryDto,
  type SpecialDateDto,
  type SpecialDateType,
} from "../types";

/**
 * Reading people out of the database.
 *
 * Everything here selects from `persons_resolved` rather than `persons`, so
 * inherited attributes are already applied -- one definition of "what is this
 * person's address", shared by browse, search, detail and the family page.
 */

export interface PersonRow {
  id: string;
  organization_id: string;
  family_id: string | null;
  family_name: string | null;
  app_user_id: string | null;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  alt_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  patron_saint: string | null;
  photo_key: string | null;
  inherit_email_from_person_id: string | null;
  inherit_phone_from_person_id: string | null;
  inherit_alt_phone_from_person_id: string | null;
  inherit_last_name_from_person_id: string | null;
  inherit_address_from_person_id: string | null;
}

export const PERSON_COLUMNS = `
  r.id,
  r.organization_id,
  r.family_id,
  r.family_name,
  r.app_user_id,
  r.first_name,
  r.last_name,
  r.email::text as email,
  r.phone,
  r.alt_phone,
  r.address_line1,
  r.address_line2,
  r.city,
  r.state,
  r.postal_code,
  r.country,
  r.patron_saint,
  r.photo_key,
  r.inherit_email_from_person_id,
  r.inherit_phone_from_person_id,
  r.inherit_alt_phone_from_person_id,
  r.inherit_last_name_from_person_id,
  r.inherit_address_from_person_id
`;

/**
 * Browse is "sorted by last name". People with no last name sort last rather
 * than first. Someone with no photo of their own falls back to their initials
 * in the UI, not to the family photo.
 */
export const PERSON_ORDER = `
  order by r.last_name asc nulls last, r.first_name asc, r.id asc
`;

export function toSummaries(caller: Caller, rows: PersonRow[]): PersonSummaryDto[] {
  return rows.map((row) => toSummary(caller, row));
}

export function toSummary(caller: Caller, row: PersonRow): PersonSummaryDto {
  const { thumbUrl, fullUrl } = photoUrls(row.photo_key);
  return {
    id: row.id,
    organizationId: row.organization_id,
    familyId: row.family_id,
    familyName: row.family_name,
    appUserId: row.app_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    altPhone: row.alt_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    patronSaint: row.patron_saint,
    // photoUrl is deprecated; it mirrors the thumbnail so a still-cached older
    // SPA bundle keeps rendering avatars until it is replaced.
    photoUrl: thumbUrl,
    thumbUrl,
    fullUrl,
    canEdit: canEditPerson(caller, {
      id: row.id,
      organizationId: row.organization_id,
      familyId: row.family_id,
      appUserId: row.app_user_id,
    }),
  };
}

const INHERIT_ROW_KEY: Record<InheritableAttribute, keyof PersonRow> = {
  email: "inherit_email_from_person_id",
  phone: "inherit_phone_from_person_id",
  altPhone: "inherit_alt_phone_from_person_id",
  lastName: "inherit_last_name_from_person_id",
  address: "inherit_address_from_person_id",
};

/**
 * The names behind the inheritance pointers, so the edit UI can say "inherited
 * from Paul Schlueter" rather than showing a uuid. Fetched in one extra query
 * instead of five more joins on the already wide resolution view.
 */
async function loadSourceNames(q: Queryable, row: PersonRow): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      INHERITABLE_ATTRIBUTES.map((a) => row[INHERIT_ROW_KEY[a]] as string | null).filter(
        (id): id is string => Boolean(id)
      )
    ),
  ];
  if (ids.length === 0) return new Map();

  const { rows } = await q.query<{ id: string; first_name: string; last_name: string | null }>(
    "select id, first_name, last_name from persons where id = any($1::uuid[])",
    [ids]
  );
  return new Map(
    rows.map((r) => [r.id, fullName({ firstName: r.first_name, lastName: r.last_name })])
  );
}

export interface SpecialDateRow {
  id: string;
  person_id: string;
  person_first_name: string;
  person_last_name: string | null;
  person_patron_saint: string | null;
  type: SpecialDateType;
  month: number;
  day: number;
  year: number | null;
  show_year_count: boolean;
  related_person_id: string | null;
  related_first_name: string | null;
  related_last_name: string | null;
}

export const SPECIAL_DATE_SELECT = `
  select sd.id,
         sd.person_id,
         p.first_name  as person_first_name,
         p.last_name   as person_last_name,
         p.patron_saint as person_patron_saint,
         sd.type,
         sd.month,
         sd.day,
         sd.year,
         sd.show_year_count,
         sd.related_person_id,
         rp.first_name as related_first_name,
         rp.last_name  as related_last_name
    from special_dates sd
    join persons_resolved p on p.id = sd.person_id
    left join persons_resolved rp on rp.id = sd.related_person_id
`;

export function toSpecialDate(row: SpecialDateRow): SpecialDateDto {
  return {
    id: row.id,
    personId: row.person_id,
    personName: fullName({ firstName: row.person_first_name, lastName: row.person_last_name }),
    type: row.type,
    month: row.month,
    day: row.day,
    year: row.year,
    showYearCount: row.show_year_count,
    relatedPersonId: row.related_person_id,
    relatedPersonName:
      row.related_person_id && row.related_first_name
        ? fullName({ firstName: row.related_first_name, lastName: row.related_last_name })
        : null,
    // A feast day is the patron saint's day, so its label comes from the
    // person rather than from a column on the date itself.
    patronSaint: row.type === "FEAST_DAY" ? row.person_patron_saint : null,
  };
}

/**
 * A person's own dates plus any anniversary where they are the *other* half of
 * the pair -- an anniversary is stored once but belongs to both spouses.
 */
export async function loadSpecialDatesFor(
  q: Queryable,
  personId: string
): Promise<SpecialDateDto[]> {
  const { rows } = await q.query<SpecialDateRow>(
    `${SPECIAL_DATE_SELECT}
      where sd.person_id = $1 or sd.related_person_id = $1
      order by sd.month, sd.day, sd.type`,
    [personId]
  );
  return rows.map(toSpecialDate);
}

export async function loadPerson(
  q: Queryable,
  caller: Caller,
  personId: string,
  organizationId: string
): Promise<PersonDto | null> {
  const row = await one<PersonRow>(
    q,
    `select ${PERSON_COLUMNS}
       from persons_resolved r
      where r.id = $1
        and r.organization_id = $2
        and r.deleted_at is null`,
    [personId, organizationId]
  );
  if (!row) return null;

  const [sourceNames, specialDates] = await Promise.all([
    loadSourceNames(q, row),
    loadSpecialDatesFor(q, personId),
  ]);

  const inheritedFrom: PersonDto["inheritedFrom"] = {};
  for (const attribute of INHERITABLE_ATTRIBUTES) {
    const sourceId = row[INHERIT_ROW_KEY[attribute]] as string | null;
    if (!sourceId) continue;
    inheritedFrom[attribute] = {
      personId: sourceId,
      name: sourceNames.get(sourceId) ?? "",
    };
  }

  return { ...toSummary(caller, row), inheritedFrom, specialDates };
}

/** Columns on `persons` that a PersonWrite may set, and their payload keys. */
export const PERSON_WRITE_COLUMNS = {
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  altPhone: "alt_phone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  state: "state",
  postalCode: "postal_code",
  country: "country",
  patronSaint: "patron_saint",
  familyId: "family_id",
  inheritEmailFromPersonId: INHERIT_COLUMN.email,
  inheritPhoneFromPersonId: INHERIT_COLUMN.phone,
  inheritAltPhoneFromPersonId: INHERIT_COLUMN.altPhone,
  inheritLastNameFromPersonId: INHERIT_COLUMN.lastName,
  inheritAddressFromPersonId: INHERIT_COLUMN.address,
} as const satisfies Record<string, string>;
