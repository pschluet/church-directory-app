import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv } from "../auth";
import { one } from "../db";
import { photoUrls } from "../photos";
import { groupIntoLocations, type MapPersonRow } from "../services/map";
import { fullName, type MapDto } from "../types";

/**
 * Everything the map draws, in one request.
 *
 * Not paginated, unlike the directory. A pin has to exist before the map can
 * cluster it, so there is no viewport to page against on first load, and a
 * parish is hundreds of rows -- the response is smaller than one photo. The
 * directory's keyset cursor is for a list somebody scrolls; this is a whole
 * set or nothing.
 *
 * Readable by any signed-in member, with `requireOrganizationId` as the
 * boundary: the addresses on it are the same ones the directory already shows
 * to everyone in the parish.
 */
const routes = new Hono<AppEnv>();

interface ChurchRow {
  map_view_enabled: boolean;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
}

routes.get("/", async (c) => {
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const org = await one<ChurchRow>(
    db,
    `select o.map_view_enabled, g.formatted_address, g.latitude, g.longitude
       from organizations o
       left join geocoded_addresses g on g.place_id = o.place_id
      where o.id = $1`,
    [organizationId]
  );
  if (!org) throw new HTTPException(404, { message: "Organization not found" });

  /*
   * 404 rather than 403. The honest answer is that this parish has no map page,
   * not that this member lacks a privilege -- a 403 would send them off to ask
   * an administrator for access nobody can grant them, since the switch is a
   * super admin's and is about the Google bill rather than about them.
   */
  if (!org.map_view_enabled) throw new HTTPException(404, { message: "Map view is not enabled" });

  /*
   * The ordering is three levels, and each one is load-bearing.
   *
   * Family name first with nulls last: the grouper preserves insertion order,
   * so this is what puts families in alphabetical order at a shared address and
   * leaves people with no family after them. It already concatenates families
   * before individuals, so this makes the SQL agree rather than relying on it.
   *
   * Then family_order, so a household's members come back in the order somebody
   * dragged them into on the family page -- the same order the families list
   * previews. Without it a pin listed a family by surname and disagreed with
   * every other page about it. Note it is ordered by but not selected, which
   * Postgres allows: it never has to reach TypeScript.
   *
   * Then names, which is the order individuals end up in.
   */
  const { rows } = await db.query<MapPersonRow>(
    `select r.id,
            r.first_name,
            r.last_name,
            r.family_id,
            r.family_name,
            r.photo_key,
            r.place_id,
            g.formatted_address,
            g.latitude,
            g.longitude
       from persons_resolved r
       join geocoded_addresses g on g.place_id = r.place_id
      where r.organization_id = $1
        and r.deleted_at is null
        and g.latitude is not null
      order by r.family_name asc nulls last,
               r.family_order asc nulls last,
               r.last_name asc nulls last, r.first_name asc, r.id asc`,
    [organizationId]
  );

  /*
   * People with an address that would not geocode, counted rather than listed.
   * Read from `persons_resolved` so that somebody inheriting a mappable
   * address is not counted as missing one.
   */
  const unmapped = await one<{ count: string }>(
    db,
    `select count(*) as count
       from persons_resolved r
      where r.organization_id = $1
        and r.deleted_at is null
        and r.address_line1 is not null
        and r.place_id is null`,
    [organizationId]
  );

  const locations = groupIntoLocations(rows, {
    thumbUrl: (key) => photoUrls(key).thumbUrl,
    fullName,
  });

  /*
   * The church when it has been geocoded, and otherwise nothing -- the SPA
   * falls back to the centroid and, for an admin, says why. Sending the
   * centroid as if it were the church would hide a missing address behind a
   * map that looks approximately right.
   */
  const church =
    org.latitude !== null && org.longitude !== null
      ? {
          latitude: org.latitude,
          longitude: org.longitude,
          formattedAddress: org.formatted_address ?? "",
        }
      : null;

  const body: MapDto = {
    church,
    locations,
    unmappedCount: Number(unmapped?.count ?? 0),
  };
  return c.json(body);
});

export default routes;
