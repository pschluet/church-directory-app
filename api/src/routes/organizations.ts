import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, requireRole, type AppEnv } from "../auth";
import { one } from "../db";
import { audit } from "../audit";
import {
  organizationAddressSchema,
  organizationWriteSchema,
  uuidSchema,
  type OrganizationAddressDto,
  type OrganizationDto,
} from "../types";
import { addressToLine, resolveAddress } from "../services/addresses";

/**
 * Organizations -- the tenants. A super admin creates them, renames them and
 * decides whether each one has Map View; everyone else only ever sees the one
 * they belong to, which they get from GET /api/me.
 *
 * The one exception is `PATCH /current`, which an admin may call to set their
 * own parish's church address. It exists because the map warns admins that the
 * address is missing, and a warning about something only a super admin can fix
 * is a dead end. It is deliberately a *narrower* schema rather than this file's
 * main one: an admin who could post `mapViewEnabled` through it could switch on
 * a billable Google integration for their parish.
 *
 * There is no blanket `routes.use("/*", requireRole("SUPER_ADMIN"))` for that
 * reason. Each route states its own floor, which is longer and is the only way
 * `/current` can sit beside the rest.
 */
const routes = new Hono<AppEnv>();

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  person_count: string;
  family_count: string;
  map_view_enabled: boolean;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  place_id: string | null;
  latitude: number | null;
  longitude: number | null;
}

const ORGANIZATION_SELECT = `
  select o.id,
         o.name,
         o.slug::text as slug,
         o.map_view_enabled,
         o.address_line1,
         o.address_line2,
         o.city,
         o.state,
         o.postal_code,
         o.country,
         o.place_id,
         g.latitude,
         g.longitude,
         (select count(*) from persons p
           where p.organization_id = o.id and p.deleted_at is null) as person_count,
         (select count(*) from families f where f.organization_id = o.id) as family_count
    from organizations o
    left join geocoded_addresses g on g.place_id = o.place_id
`;

function toOrganization(row: OrganizationRow): OrganizationDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personCount: Number(row.person_count),
    familyCount: Number(row.family_count),
    mapViewEnabled: row.map_view_enabled,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    placeId: row.place_id,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

/** Just the church address, for the routes an administrator may call. */
function toOrganizationAddress(row: OrganizationRow): OrganizationAddressDto {
  return {
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    placeId: row.place_id,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

/** The six address columns plus the resolved `place_id`, as a SET clause. */
const ADDRESS_SET = `
      address_line1 = $2,
      address_line2 = $3,
      city          = $4,
      state         = $5,
      postal_code   = $6,
      country       = $7,
      place_id      = $8
`;

type AddressPayload = Record<string, unknown> & {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

function addressParams(payload: AddressPayload, placeId: string | null): unknown[] {
  return [
    payload.addressLine1 ?? null,
    payload.addressLine2 ?? null,
    payload.city ?? null,
    payload.state ?? null,
    payload.postalCode ?? null,
    payload.country ?? null,
    placeId,
  ];
}

routes.get("/", requireRole("SUPER_ADMIN"), async (c) => {
  const { rows } = await c
    .get("db")
    .query<OrganizationRow>(`${ORGANIZATION_SELECT} order by o.name`);
  return c.json({ organizations: rows.map(toOrganization) });
});

routes.post("/", requireRole("SUPER_ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = organizationWriteSchema.parse(await c.req.json());

  const clash = await one<{ id: string }>(db, "select id from organizations where slug = $1", [
    payload.slug,
  ]);
  if (clash) throw new HTTPException(409, { message: "That short name is already taken" });

  const mapViewEnabled = payload.mapViewEnabled ?? false;
  // Geocoded before the insert so the foreign key has a row to point at, and
  // only when the parish is being created with a map -- see `resolveAddress`.
  const geocode = await resolveAddress(db, {
    placeId: payload.placeId ?? null,
    text: addressToLine(payload),
    mapViewEnabled,
  });

  const created = await one<{ id: string }>(
    db,
    `insert into organizations
       (name, slug, map_view_enabled, address_line1, address_line2, city, state,
        postal_code, country, place_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [payload.name, payload.slug, mapViewEnabled, ...addressParams(payload, geocode.placeId)]
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

/**
 * The church address, read by an admin for their own parish.
 *
 * Separate from `GET /` because that one is a super administrator's list of
 * every tenant. Without this an administrator's own settings page could not
 * show them the address it is asking them to fix.
 */
routes.get("/current", requireRole("ADMIN"), async (c) => {
  const organizationId = requireOrganizationId(c);
  const row = await one<OrganizationRow>(c.get("db"), `${ORGANIZATION_SELECT} where o.id = $1`, [
    organizationId,
  ]);
  if (!row) throw new HTTPException(404, { message: "Organization not found" });
  return c.json(toOrganizationAddress(row));
});

/**
 * The church address, set by an admin for their own parish.
 *
 * Registered before `/:id` so the static segment wins, and scoped to
 * `requireOrganizationId` so an admin cannot name somebody else's parish --
 * there is no id in the path to name one with.
 *
 * `organizationAddressSchema` and not `organizationWriteSchema`: name, slug and
 * `mapViewEnabled` are not an admin's to change, and leaving them out of the
 * schema is stronger than leaving them out of the SQL.
 */
routes.patch("/current", requireRole("ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = organizationAddressSchema.parse(await c.req.json());

  const existing = await one<{ map_view_enabled: boolean }>(
    db,
    "select map_view_enabled from organizations where id = $1",
    [organizationId]
  );
  if (!existing) throw new HTTPException(404, { message: "Organization not found" });

  const geocode = await resolveAddress(db, {
    placeId: payload.placeId ?? null,
    text: addressToLine(payload),
    mapViewEnabled: existing.map_view_enabled,
  });

  await db.query(`update organizations set ${ADDRESS_SET} where id = $1`, [
    organizationId,
    ...addressParams(payload, geocode.placeId),
  ]);
  await audit(db, caller, {
    action: "organization.updateAddress",
    entityType: "organization",
    entityId: organizationId,
    changes: { ...payload, placeId: geocode.placeId },
  });

  const row = await one<OrganizationRow>(db, `${ORGANIZATION_SELECT} where o.id = $1`, [
    organizationId,
  ]);
  return c.json({
    organization: row ? toOrganizationAddress(row) : null,
    geocodeWarning: geocode.warning,
  });
});

routes.patch("/:id", requireRole("SUPER_ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = organizationWriteSchema.parse(await c.req.json());

  const existing = await one<{ id: string; map_view_enabled: boolean }>(
    db,
    "select id, map_view_enabled from organizations where id = $1",
    [id]
  );
  if (!existing) throw new HTTPException(404, { message: "Organization not found" });

  const clash = await one<{ id: string }>(
    db,
    "select id from organizations where slug = $1 and id <> $2",
    [payload.slug, id]
  );
  if (clash) throw new HTTPException(409, { message: "That short name is already taken" });

  /*
   * Absent means "leave it alone" rather than "switch it off", because this
   * schema is not `.partial()` and a caller written before the map existed
   * sends neither field. Read against the value being *set* rather than the
   * stored one, so enabling the map and giving the church an address in one
   * request geocodes it.
   */
  const mapViewEnabled = payload.mapViewEnabled ?? existing.map_view_enabled;
  const geocode = await resolveAddress(db, {
    placeId: payload.placeId ?? null,
    text: addressToLine(payload),
    mapViewEnabled,
  });

  await db.query(
    `update organizations
        set name = $9,
            slug = $10,
            map_view_enabled = $11,
            ${ADDRESS_SET}
      where id = $1`,
    [id, ...addressParams(payload, geocode.placeId), payload.name, payload.slug, mapViewEnabled]
  );
  await audit(db, caller, {
    action: "organization.update",
    entityType: "organization",
    entityId: id,
    changes: { ...payload, mapViewEnabled, placeId: geocode.placeId },
  });

  const row = await one<OrganizationRow>(db, `${ORGANIZATION_SELECT} where o.id = $1`, [id]);
  return c.json(row ? toOrganization(row) : { id });
});

export default routes;
