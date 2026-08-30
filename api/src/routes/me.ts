import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { one } from "../db";
import { loadPerson } from "../services/persons";
import { fullName, type MeDto } from "../types";

/**
 * Everything the SPA needs on boot: who you are, what you may do, the
 * organization you are acting in, and -- for a super admin -- the list you may
 * switch between. The SPA reads role from here rather than from the token,
 * because role lives in Postgres.
 */
const routes = new Hono<AppEnv>();

routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");

  const [org, person] = await Promise.all([
    caller.organizationId
      ? one<{ id: string; name: string }>(db, "select id, name from organizations where id = $1", [
          caller.organizationId,
        ])
      : Promise.resolve(null),
    caller.personId && caller.organizationId
      ? loadPerson(db, caller, caller.personId, caller.organizationId)
      : Promise.resolve(null),
  ]);

  // Only super admins may act outside their own organization, so nobody else
  // gets a switcher list to render.
  const availableOrganizations = caller.isSuperAdmin
    ? (
        await db.query<{ id: string; name: string }>(
          "select id, name from organizations order by name"
        )
      ).rows
    : [];

  const body: MeDto = {
    appUser: {
      id: caller.appUserId,
      email: caller.email,
      role: caller.role,
      status: caller.status,
      organizationId: caller.homeOrganizationId,
      organizationName: caller.homeOrganizationId === org?.id ? (org?.name ?? null) : null,
      personId: caller.personId,
      personName: person ? fullName(person) : null,
    },
    person,
    organization: org,
    availableOrganizations,
  };

  return c.json(body);
});

export default routes;
