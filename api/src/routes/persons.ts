import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv, type Caller } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { assertCanEditFamily, assertCanEditPerson } from "../services/access";
import { clearInheritanceFor, validateInheritance } from "../services/inheritance";
import { cancelPendingJoinRequests } from "../services/membership";
import { loadPerson, PERSON_WRITE_COLUMNS } from "../services/persons";
import { deletePhoto } from "../photos";
import { createPersonSchema, personWriteSchema, uuidSchema, type PersonWrite } from "../types";

/**
 * Person CRUD.
 *
 * `POST /` creates a family member who has no account -- "a family might have
 * children that don't have an account in the app". Accounts are never created
 * here; they only come from the invite flow in routes/admin.ts.
 */
const routes = new Hono<AppEnv>();

interface PersonFactsRow {
  id: string;
  organization_id: string;
  family_id: string | null;
  app_user_id: string | null;
  photo_key: string | null;
}

/**
 * Scoped by organization on purpose: a person in another parish must be
 * indistinguishable from one that does not exist. Looking them up first and
 * failing the permission check afterwards would answer "does this id exist?"
 * for every other tenant.
 */
async function loadFacts(
  q: Queryable,
  id: string,
  organizationId: string
): Promise<PersonFactsRow> {
  const row = await one<PersonFactsRow>(
    q,
    `select id, organization_id, family_id, app_user_id, photo_key
       from persons
      where id = $1 and organization_id = $2 and deleted_at is null`,
    [id, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Person not found" });
  return row;
}

function facts(row: PersonFactsRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    familyId: row.family_id,
    appUserId: row.app_user_id,
  };
}

async function assertFamilyIsEditable(
  q: Queryable,
  caller: Caller,
  familyId: string
): Promise<void> {
  const family = await one<{ id: string; organization_id: string }>(
    q,
    "select id, organization_id from families where id = $1",
    [familyId]
  );
  if (!family || family.organization_id !== caller.organizationId) {
    throw new HTTPException(404, { message: "Family not found" });
  }
  assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });
}

routes.get("/:id", async (c) => {
  const caller = c.get("caller");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const person = await loadPerson(c.get("db"), caller, id, organizationId);
  if (!person) throw new HTTPException(404, { message: "Person not found" });
  return c.json(person);
});

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = createPersonSchema.parse(await c.req.json());

  await assertFamilyIsEditable(db, caller, payload.familyId);
  await validateInheritance(
    db,
    { personId: null, organizationId, familyId: payload.familyId },
    payload
  );

  const { columns, values } = buildWrite(payload);
  const created = await one<{ id: string }>(
    db,
    `insert into persons (organization_id, ${columns.join(", ")})
     values ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")})
     returning id`,
    [organizationId, ...values]
  );
  if (!created) throw new HTTPException(500, { message: "Could not create that person" });

  await audit(db, caller, {
    action: "person.create",
    entityType: "person",
    entityId: created.id,
    changes: payload,
  });

  const person = await loadPerson(db, caller, created.id, organizationId);
  return c.json(person, 201);
});

routes.patch("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = personWriteSchema.partial().parse(await c.req.json());

  const existing = await loadFacts(db, id, organizationId);
  assertCanEditPerson(caller, facts(existing));

  // Moving between families needs permission on the destination too, and any
  // inheritance from the old family has to go: the resolution view would
  // otherwise keep serving an address from people who are no longer relatives.
  const movingFamily = "familyId" in payload && payload.familyId !== existing.family_id;
  if (movingFamily && payload.familyId) {
    await assertFamilyIsEditable(db, caller, payload.familyId);
  }

  const effectiveFamilyId = movingFamily ? (payload.familyId ?? null) : existing.family_id;

  await validateInheritance(
    db,
    { personId: id, organizationId, familyId: effectiveFamilyId },
    payload
  );

  const { columns, values } = buildWrite(payload);

  await db.transaction(async (tx) => {
    if (movingFamily) await clearInheritanceFor(tx, id);
    if (columns.length > 0) {
      await tx.query(
        `update persons
            set ${columns.map((col, i) => `${col} = $${i + 2}`).join(", ")}
          where id = $1`,
        [id, ...values]
      );
    }
    // Landing in a family settles the question everywhere else they asked.
    if (movingFamily) await cancelPendingJoinRequests(tx, id, effectiveFamilyId);
  });

  await audit(db, caller, {
    action: "person.update",
    entityType: "person",
    entityId: id,
    changes: payload,
  });

  const person = await loadPerson(db, caller, id, organizationId);
  return c.json(person);
});

/** Attaches a photo that has already been uploaded to the presigned URL. */
routes.put("/:id/photo", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const { photoKey } = (await c.req.json()) as { photoKey: string | null };

  const existing = await loadFacts(db, id, organizationId);
  assertCanEditPerson(caller, facts(existing));

  // The key encodes the organization and person, so a caller cannot point
  // their record at someone else's uploaded photo.
  if (photoKey && !photoKey.startsWith(`photos/${organizationId}/person/${id}/`)) {
    throw new HTTPException(400, { message: "That photo does not belong to this person" });
  }

  await db.query("update persons set photo_key = $2 where id = $1", [id, photoKey]);
  if (existing.photo_key && existing.photo_key !== photoKey) {
    await deletePhoto(existing.photo_key);
  }

  const person = await loadPerson(db, caller, id, organizationId);
  return c.json(person);
});

/**
 * Soft delete, because data is kept forever. Only family members without an
 * account can be removed this way -- deleting the Person behind an account
 * would leave the account with nothing to point at, so admins disable the
 * account instead (routes/admin.ts).
 */
routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const existing = await loadFacts(db, id, organizationId);
  assertCanEditPerson(caller, facts(existing));

  if (existing.app_user_id) {
    throw new HTTPException(400, {
      message: "This person has an account — disable the account instead of deleting them",
    });
  }

  await db.transaction(async (tx) => {
    await clearInheritanceFor(tx, id);
    await tx.query("update persons set deleted_at = now() where id = $1", [id]);
  });

  await audit(db, caller, { action: "person.delete", entityType: "person", entityId: id });
  return c.body(null, 204);
});

/**
 * Turns a validated payload into columns and values. Only keys actually
 * present are written, so a PATCH cannot accidentally null a field it never
 * mentioned.
 */
export function buildWrite(payload: Partial<PersonWrite>): {
  columns: string[];
  values: unknown[];
} {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PERSON_WRITE_COLUMNS)) {
    if (!(key in payload)) continue;
    columns.push(column);
    values.push((payload as Record<string, unknown>)[key] ?? null);
  }
  return { columns, values };
}

export default routes;
