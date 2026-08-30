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
