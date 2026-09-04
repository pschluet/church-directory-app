import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { db, one, type Queryable } from "./db";
import { hasRole, type Role, type UserStatus } from "./types";

/**
 * Authentication and the caller's effective permissions.
 *
 * Role and organization live in Postgres, not in Cognito groups: a group
 * cannot express "which organization is this admin scoped to", and mirroring
 * roles into Cognito only creates drift. The token establishes *who* is
 * calling; this module answers *what they may do*.
 *
 * Claims arrive from one of two places, which is what lets the same Hono app
 * serve both platforms:
 *
 *   Deployed  API Gateway's Cognito JWT authorizer has already validated the
 *             token and flattened its claims into the Lambda event.
 *   Local     There is no authorizer in front of `tsx watch`, so server.ts
 *             verifies the real token with aws-jwt-verify and puts the same
 *             claim shape into the context.
 *
 * Routes never see either path -- they read `c.get("caller")`.
 */

export interface Claims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export interface Caller {
  appUserId: string;
  email: string;
  role: Role;
  status: UserStatus;
  /** The organization this account belongs to; null only for super admins. */
  homeOrganizationId: string | null;
  personId: string | null;
  /** The caller's own family, which is what lets them edit its non-user members. */
  familyId: string | null;
  /**
   * The organization this request operates in. Same as `homeOrganizationId`
   * for everyone except a super admin, who may switch.
   */
  organizationId: string | null;
  isSuperAdmin: boolean;
  /** True for ADMIN and SUPER_ADMIN. */
  isAdmin: boolean;
  /** True for PRAYER_REQUEST_ADMIN and everything above it. */
  canApprovePrayerRequests: boolean;
}

export type AppEnv = {
  Variables: {
    claims: Claims;
    caller: Caller;
    /**
     * The database handle for this request. Set by `authMiddleware` so route
     * handlers never import `db` directly and tests can inject a fake.
     */
    db: Queryable;
  };
};

/** Claims as API Gateway's JWT authorizer leaves them on the Lambda event. */
export function claimsFromLambdaEvent(c: Context): Claims | null {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const raw = event?.requestContext?.authorizer?.jwt?.claims as Record<string, unknown> | undefined;
  if (!raw?.sub) return null;
  return {
    sub: String(raw.sub),
    email: String(raw.email ?? "").toLowerCase(),
    // HTTP API authorizers flatten every claim to a string, so the boolean
    // arrives as "true"/"false" rather than a real boolean.
    emailVerified: String(raw.email_verified ?? "false") === "true",
  };
}

interface AppUserRow {
  id: string;
  cognito_sub: string | null;
  email: string;
  role: Role;
  status: UserStatus;
  organization_id: string | null;
  person_id: string | null;
  family_id: string | null;
}

const SELECT_APP_USER = `
  select u.id,
         u.cognito_sub,
         u.email::text as email,
         u.role,
         u.status,
         u.organization_id,
         p.id as person_id,
         p.family_id
    from app_users u
    left join persons p
      on p.app_user_id = u.id
     and p.deleted_at is null
     -- A person always sits in their account's own parish. Saying so here means
     -- that if the two ever disagree, this fails closed (no personId, no
     -- familyId) instead of quietly handing out a record scoped to the wrong
     -- parish. api/src/services/membership.ts is what keeps them in step.
     and p.organization_id = u.organization_id
`;

/**
 * Finds the account for a token, binding it to the Cognito subject the first
 * time we see one and marking it ACTIVE on its first sign-in.
 *
 * Two steps, because the account can arrive by either route and both mean
 * someone just signed in successfully. Resolving by sub is the ordinary case;
 * `bindByEmail` is the exception. Activation then happens once, outside both,
 * which is the whole point: it used to live inside the bind-by-email UPDATE, so
 * every invited account -- which already has its sub, and so never took that
 * branch -- stayed INVITED forever no matter how often they signed in.
 */
export async function findOrBindAppUser(q: Queryable, claims: Claims): Promise<AppUserRow | null> {
  const user =
    (await one<AppUserRow>(q, `${SELECT_APP_USER} where u.cognito_sub = $1`, [claims.sub])) ??
    (await bindByEmail(q, claims));
  if (!user) return null;

  return activateOnFirstSignIn(q, user);
}

/**
 * Claims an account that has no Cognito subject yet.
 *
 * This exists for exactly one case: the bootstrap super admin, who is inserted
 * by V3__bootstrap_super_admin.sql before any Cognito user exists (the database
 * is private, so there is no way to insert the row later from a laptop). Every
 * other account is created by the invite flow, which calls AdminCreateUser and
 * stores the sub in the same request. We require a verified email so this
 * cannot be used to hijack a row.
 */
async function bindByEmail(q: Queryable, claims: Claims): Promise<AppUserRow | null> {
  if (!claims.email || !claims.emailVerified) return null;

  const bound = await one<{ id: string }>(
    q,
    `update app_users
        set cognito_sub = $1
      where email = $2
        and cognito_sub is null
      returning id`,
    [claims.sub, claims.email]
  );
  if (!bound) return null;

  return one<AppUserRow>(q, `${SELECT_APP_USER} where u.id = $1`, [bound.id]);
}

/**
 * INVITED means "invited but never seen"; presenting a valid token settles
 * that. The status is what the People & Accounts screen shows, and there is no
 * other signal that anyone ever signed in.
 *
 * Only INVITED is touched, so a DISABLED account is not resurrected -- the
 * WHERE clause repeats the check in case a concurrent request disabled the row
 * between the SELECT and here. The updated status is patched into the row we
 * already hold rather than re-selected, so the caller built from it (and the
 * `status` GET /me echoes back) is correct on the very request that activated
 * the account.
 */
async function activateOnFirstSignIn(q: Queryable, user: AppUserRow): Promise<AppUserRow> {
  if (user.status !== "INVITED") return user;

  await q.query("update app_users set status = 'ACTIVE' where id = $1 and status = 'INVITED'", [
    user.id,
  ]);
  return { ...user, status: "ACTIVE" };
}

/**
 * Which organization is this request about?
 *
 * Everyone but a super admin is pinned to their own. A super admin may pass
 * `?orgId=` (or `X-Org-Id`) to act inside a specific organization; we validate
 * it exists rather than trusting the value, and return null when none was
 * given so that org-scoped routes can ask for one explicitly.
 */
async function resolveOrganizationId(
  q: Queryable,
  c: Context,
  user: AppUserRow
): Promise<string | null> {
  if (user.role !== "SUPER_ADMIN") return user.organization_id;

  const requested = c.req.query("orgId") ?? c.req.header("x-org-id") ?? null;
  if (!requested) return user.organization_id;

  const org = await one<{ id: string }>(q, "select id from organizations where id = $1", [
    requested,
  ]);
  if (!org) throw new HTTPException(404, { message: "Organization not found" });
  return org.id;
}

export function authMiddleware(queryable: Queryable = db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("db", queryable);

    const claims = c.get("claims") ?? claimsFromLambdaEvent(c);
    if (!claims) throw new HTTPException(401, { message: "Not signed in" });
    c.set("claims", claims);

    const user = await findOrBindAppUser(queryable, claims);
    if (!user) {
      // The token is valid but there is no account for it. Sign-up is
      // disabled, so this means the account was deleted, or someone was
      // created directly in Cognito rather than through the invite flow.
      throw new HTTPException(403, { message: "No directory account for this sign-in" });
    }
    if (user.status === "DISABLED") {
      throw new HTTPException(403, { message: "This account has been disabled" });
    }

    const organizationId = await resolveOrganizationId(queryable, c, user);

    c.set("caller", {
      appUserId: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      homeOrganizationId: user.organization_id,
      personId: user.person_id,
      familyId: user.family_id,
      organizationId,
      isSuperAdmin: user.role === "SUPER_ADMIN",
      isAdmin: user.role === "SUPER_ADMIN" || user.role === "ADMIN",
      canApprovePrayerRequests: hasRole(user.role, "PRAYER_REQUEST_ADMIN"),
    });

    await next();
  };
}

/** Route guard: `app.post("/admin/users", requireRole("ADMIN"), handler)`. */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const caller = c.get("caller");
    // A floor, not an exact match: a super admin can do anything an admin can,
    // and an admin anything a user can. The hierarchy itself lives in
    // `hasRole` (types.ts) so the SPA's guards agree with this one by
    // construction rather than by a second copy of the same ladder.
    const allowed = roles.some((role) => hasRole(caller.role, role));
    if (!allowed) throw new HTTPException(403, { message: "Not allowed" });
    await next();
  };
}

/**
 * The organization the request operates in, or a 400 explaining that a super
 * admin needs to pick one. Every org-scoped query goes through this rather
 * than reading a client-supplied id.
 */
export function requireOrganizationId(c: Context<AppEnv>): string {
  const { organizationId } = c.get("caller");
  if (!organizationId) {
    throw new HTTPException(400, {
      message: "Select an organization first (pass orgId)",
    });
  }
  return organizationId;
}
