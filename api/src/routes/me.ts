import { Hono } from "hono";
import { requireRole, type AppEnv, type Caller } from "../auth";
import { one } from "../db";
import { audit } from "../audit";
import { loadPerson } from "../services/persons";
import { setAccountOrganization } from "../services/membership";
import { fullName, setMyOrganizationSchema, type MeDto, type OrganizationMoveDto } from "../types";

/**
 * Everything the SPA needs on boot: who you are, what you may do, the
 * organization you are acting in, and -- for a super admin -- the list you may
 * switch between. The SPA reads role from here rather than from the token,
 * because role lives in Postgres.
 */
const routes = new Hono<AppEnv>();

/**
 * My own record lives in my own parish, whichever parish I happen to be
 * browsing. Loading it against the *active* organization is what made
 * `/api/me` return `person: null` for a super admin looking at another parish,
 * and `canEdit` false on their own details.
 */
function asHomeParishCaller(caller: Caller): Caller {
  return { ...caller, organizationId: caller.homeOrganizationId };
}

async function loadMe(db: AppEnv["Variables"]["db"], caller: Caller): Promise<MeDto> {
  const [org, person] = await Promise.all([
    caller.organizationId
      ? one<{ id: string; name: string }>(db, "select id, name from organizations where id = $1", [
          caller.organizationId,
        ])
      : Promise.resolve(null),
    caller.personId && caller.homeOrganizationId
      ? loadPerson(db, asHomeParishCaller(caller), caller.personId, caller.homeOrganizationId)
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

  // The active organization is usually the home one, so avoid re-reading it.
  const homeName =
    caller.homeOrganizationId === null
      ? null
      : caller.homeOrganizationId === org?.id
        ? org.name
        : ((
            await one<{ name: string }>(db, "select name from organizations where id = $1", [
              caller.homeOrganizationId,
            ])
          )?.name ?? null);

  return {
    appUser: {
      id: caller.appUserId,
      email: caller.email,
      role: caller.role,
      status: caller.status,
      organizationId: caller.homeOrganizationId,
      organizationName: homeName,
      personId: caller.personId,
      personName: person ? fullName(person) : null,
    },
    person,
    organization: org,
    availableOrganizations,
  };
}

routes.get("/", async (c) => {
  return c.json(await loadMe(c.get("db"), c.get("caller")));
});

/**
 * Adopt a home parish, so a super admin has a directory record of their own to
 * keep up to date.
 *
 * Super admins only. Everyone else is placed in a parish by an administrator --
 * letting a member move themselves would let them walk into another parish's
 * directory.
 */
routes.put("/organization", requireRole("SUPER_ADMIN"), async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const payload = setMyOrganizationSchema.parse(await c.req.json());

  const move: OrganizationMoveDto = await setAccountOrganization(db, {
    appUserId: caller.appUserId,
    organizationId: payload.organizationId,
    names: { firstName: payload.firstName, lastName: payload.lastName ?? null },
  });

  await audit(db, caller, {
    action: move.created ? "user.adoptParish" : "user.changeParish",
    entityType: "appUser",
    entityId: caller.appUserId,
    changes: { organizationId: payload.organizationId, ...move },
  });

  // Re-read rather than patching the caller: the move changed
  // homeOrganizationId, personId and familyId, all of which came from the
  // auth middleware's snapshot.
  const refreshed: Caller = {
    ...caller,
    homeOrganizationId: payload.organizationId,
    organizationId: payload.organizationId,
    personId: move.personId,
    familyId: null,
  };

  return c.json({ ...(await loadMe(db, refreshed)), move });
});

export default routes;
