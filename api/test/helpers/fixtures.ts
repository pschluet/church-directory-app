import type { Queryable } from "../../src/db";
import type { Role } from "../../src/types";

/**
 * Builders for the shapes these tests keep needing: a parish, some families,
 * people with and without accounts. Everything returns ids so tests can assert
 * against them directly.
 */

export async function createOrganization(
  db: Queryable,
  name = "All Saints",
  slug = "all-saints"
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into organizations (name, slug) values ($1, $2) returning id",
    [name, slug]
  );
  return rows[0]!.id;
}

export async function createFamily(
  db: Queryable,
  organizationId: string,
  name = "Schlueter"
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into families (organization_id, name) values ($1, $2) returning id",
    [organizationId, name]
  );
  return rows[0]!.id;
}

export interface CreatedUser {
  appUserId: string;
  /**
   * Null for a super admin with no organization -- they have no directory
   * record until they are given one, exactly as in the invite flow.
   */
  personId: string | null;
  cognitoSub: string;
  email: string;
}

/** An account plus its Person record, the way the invite flow creates them. */
export async function createUser(
  db: Queryable,
  options: {
    organizationId: string | null;
    role?: Role;
    email?: string;
    firstName?: string;
    lastName?: string | null;
    familyId?: string | null;
  }
): Promise<CreatedUser> {
  const role = options.role ?? "USER";
  const email =
    options.email ?? `${role.toLowerCase()}-${Date.now()}-${Math.random()}@test.example`;
  const cognitoSub = `sub-${email}`;

  const { rows: userRows } = await db.query<{ id: string }>(
    `insert into app_users (cognito_sub, email, role, organization_id, status)
     values ($1, $2, $3, $4, 'ACTIVE') returning id`,
    [cognitoSub, email, role, options.organizationId]
  );
  const appUserId = userRows[0]!.id;

  // A super admin with no organization has no directory record yet, which is
  // exactly what the invite flow in routes/admin.ts does.
  if (!options.organizationId) {
    return { appUserId, personId: null, cognitoSub, email };
  }

  const { rows: personRows } = await db.query<{ id: string }>(
    `insert into persons (organization_id, family_id, app_user_id, first_name, last_name, email)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      options.organizationId,
      options.familyId ?? null,
      appUserId,
      options.firstName ?? "Test",
      options.lastName ?? "User",
      email,
    ]
  );

  return { appUserId, personId: personRows[0]!.id, cognitoSub, email };
}

/** A family member with no account -- a child, for example. */
export async function createNonUserPerson(
  db: Queryable,
  options: {
    organizationId: string;
    familyId: string | null;
    firstName?: string;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    patronSaint?: string | null;
  }
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into persons (organization_id, family_id, first_name, last_name, email, phone, city, patron_saint)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      options.organizationId,
      options.familyId,
      options.firstName ?? "Child",
      options.lastName ?? null,
      options.email ?? null,
      options.phone ?? null,
      options.city ?? null,
      options.patronSaint ?? null,
    ]
  );
  return rows[0]!.id;
}

/**
 * A special date, inserted directly.
 *
 * `showYearCount` is the opt-in that decides whether an age or a number of
 * years married is visible at all, so it is the knob most of these tests turn.
 */
export async function createSpecialDate(
  db: Queryable,
  options: {
    organizationId: string;
    personId: string;
    type: "BIRTHDAY" | "ANNIVERSARY" | "FEAST_DAY";
    month: number;
    day: number;
    year?: number | null;
    showYearCount?: boolean;
    relatedPersonId?: string | null;
  }
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into special_dates
       (organization_id, person_id, related_person_id, type, month, day, year, show_year_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      options.organizationId,
      options.personId,
      options.relatedPersonId ?? null,
      options.type,
      options.month,
      options.day,
      options.year ?? null,
      options.showYearCount ?? false,
    ]
  );
  return rows[0]!.id;
}

export async function setInheritance(
  db: Queryable,
  personId: string,
  pointers: Partial<{
    email: string;
    phone: string;
    altPhone: string;
    lastName: string;
    address: string;
  }>
): Promise<void> {
  const columns: Record<string, string> = {
    email: "inherit_email_from_person_id",
    phone: "inherit_phone_from_person_id",
    altPhone: "inherit_alt_phone_from_person_id",
    lastName: "inherit_last_name_from_person_id",
    address: "inherit_address_from_person_id",
  };
  for (const [key, sourceId] of Object.entries(pointers)) {
    await db.query(`update persons set ${columns[key]} = $2 where id = $1`, [personId, sourceId]);
  }
}

/**
 * A pending merge request, inserted directly.
 *
 * `requestedByPersonId` is what decides which of the two routes the request is
 * on -- pass the account holder's own person id for route B, anyone else's for
 * route A. See V5__person_merge_requests.sql.
 */
export async function createMergeRequest(
  db: Queryable,
  options: {
    organizationId: string;
    accountPersonId: string;
    duplicatePersonId: string;
    requestedByPersonId: string;
  }
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into person_merge_requests
       (organization_id, account_person_id, duplicate_person_id, requested_by_person_id)
     values ($1, $2, $3, $4) returning id`,
    [
      options.organizationId,
      options.accountPersonId,
      options.duplicatePersonId,
      options.requestedByPersonId,
    ]
  );
  return rows[0]!.id;
}

/**
 * One audit log entry, written directly.
 *
 * The read path is the only thing that reads this table, and it has to cope
 * with states no call site produces: two entries at the same instant, an
 * action nobody has added to `AUDIT_ACTIONS`, a null organization, a target
 * that no longer exists. Going through the routes that happen to write audit
 * rows would test those routes and give no control over `created_at`, which is
 * the whole axis the log is paginated on.
 */
export async function createAuditEntry(
  db: Queryable,
  options: {
    organizationId: string | null;
    actorAppUserId?: string | null;
    action?: string;
    entityType?: string;
    entityId?: string | null;
    changes?: unknown;
    /** An ISO instant, or omitted for `now()`. */
    createdAt?: string;
  }
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into audit_log (organization_id, actor_app_user_id, action, entity_type, entity_id,
                            changes, created_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
     returning id::text as id`,
    [
      options.organizationId,
      options.actorAppUserId ?? null,
      options.action ?? "person.update",
      options.entityType ?? "person",
      options.entityId ?? null,
      options.changes === undefined ? null : JSON.stringify(options.changes),
      options.createdAt ?? null,
    ]
  );
  return rows[0]!.id;
}

/**
 * A geocoded address, inserted directly.
 *
 * Direct rather than through a route because every route that writes one calls
 * Google, and `GEOCODING_MODE=local` refuses. What the map tests need is the
 * table populated, not the call exercised -- `geocoding.test.ts` covers the
 * call with a stubbed `fetch`.
 */
export async function createGeocode(
  db: Queryable,
  options: {
    placeId: string;
    formattedAddress?: string;
    latitude?: number | null;
    longitude?: number | null;
    /** Days in the past, for the staleness the refresh job selects on. */
    ageDays?: number;
  }
): Promise<string> {
  await db.query(
    `insert into geocoded_addresses
       (place_id, formatted_address, latitude, longitude, geocoded_at)
     values ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
    [
      options.placeId,
      options.formattedAddress ?? `${options.placeId} Street, Chicago, IL, USA`,
      options.latitude === undefined ? 41.9445 : options.latitude,
      options.longitude === undefined ? -87.7325 : options.longitude,
      String(options.ageDays ?? 0),
    ]
  );
  return options.placeId;
}

/** Points a person at an address that has already been geocoded. */
export async function setPlaceId(
  db: Queryable,
  personId: string,
  placeId: string | null
): Promise<void> {
  await db.query("update persons set place_id = $2 where id = $1", [personId, placeId]);
}

/** Switches Map View on for a parish, and optionally gives it a church address. */
export async function enableMapView(
  db: Queryable,
  organizationId: string,
  churchPlaceId?: string | null
): Promise<void> {
  await db.query(
    "update organizations set map_view_enabled = true, place_id = coalesce($2, place_id) where id = $1",
    [organizationId, churchPlaceId ?? null]
  );
}

/**
 * The order somebody dragged a family's members into on the family page.
 *
 * Null means nobody has ordered this family, which is why every read sorts
 * `family_order asc nulls last` and falls back to names.
 */
export async function setFamilyOrder(
  db: Queryable,
  order: { personId: string; position: number | null }[]
): Promise<void> {
  for (const { personId, position } of order) {
    await db.query("update persons set family_order = $2 where id = $1", [personId, position]);
  }
}
