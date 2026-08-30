import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireRole, type AppEnv } from "../auth";
import { one } from "../db";
import { audit } from "../audit";
import { organizationWriteSchema, uuidSchema, type OrganizationDto } from "../types";

/**
 * Organizations -- the tenants. Only a super admin creates them or renames
 * them; everyone else only ever sees the one they belong to, which they get
 * from GET /api/me.
 */
const routes = new Hono<AppEnv>();

routes.use("/*", requireRole("SUPER_ADMIN"));

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  person_count: string;
  family_count: string;
}

const ORGANIZATION_SELECT = `
  select o.id,
         o.name,
         o.slug::text as slug,
         (select count(*) from persons p
           where p.organization_id = o.id and p.deleted_at is null) as person_count,
         (select count(*) from families f where f.organization_id = o.id) as family_count
    from organizations o
`;

function toOrganization(row: OrganizationRow): OrganizationDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personCount: Number(row.person_count),
    familyCount: Number(row.family_count),
  };
}

routes.get("/", async (c) => {
  const { rows } = await c
    .get("db")
    .query<OrganizationRow>(`${ORGANIZATION_SELECT} order by o.name`);
  return c.json({ organizations: rows.map(toOrganization) });
});

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = organizationWriteSchema.parse(await c.req.json());

  const clash = await one<{ id: string }>(db, "select id from organizations where slug = $1", [
    payload.slug,
  ]);
  if (clash) throw new HTTPException(409, { message: "That short name is already taken" });

  const created = await one<{ id: string }>(
    db,
    "insert into organizations (name, slug) values ($1, $2) returning id",
    [payload.name, payload.slug]
  );
  if (!created) throw new HTTPException(500, { message: "Could not create that organization" });

  await audit(db, caller, {
    action: "organization.create",
    entityType: "organization",
    entityId: created.id,
    changes: payload,
  });

  const row = await one<OrganizationRow>(db, `${ORGANIZATION_SELECT} where o.id = $1`, [
    created.id,
  ]);
  return c.json(row ? toOrganization(row) : { id: created.id }, 201);
});

routes.patch("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = organizationWriteSchema.parse(await c.req.json());

  const existing = await one<{ id: string }>(db, "select id from organizations where id = $1", [
    id,
  ]);
  if (!existing) throw new HTTPException(404, { message: "Organization not found" });

  const clash = await one<{ id: string }>(
    db,
    "select id from organizations where slug = $1 and id <> $2",
    [payload.slug, id]
  );
  if (clash) throw new HTTPException(409, { message: "That short name is already taken" });

  await db.query("update organizations set name = $2, slug = $3 where id = $1", [
    id,
    payload.name,
    payload.slug,
  ]);
  await audit(db, caller, {
    action: "organization.update",
    entityType: "organization",
    entityId: id,
    changes: payload,
  });

  const row = await one<OrganizationRow>(db, `${ORGANIZATION_SELECT} where o.id = $1`, [id]);
  return c.json(row ? toOrganization(row) : { id });
});

export default routes;
