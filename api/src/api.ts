import { setDefaultResultOrder } from "node:dns";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { authMiddleware, type AppEnv } from "./auth";
import { assertPhotoCookieConfig } from "./photo-cookies";
import { assertPushConfig } from "./services/push";
import type { Queryable } from "./db";
import meRoutes from "./routes/me";
import directoryRoutes from "./routes/directory";
import personRoutes from "./routes/persons";
import familyRoutes from "./routes/families";
import mergeRoutes from "./routes/merges";
import specialDateRoutes from "./routes/special-dates";
import prayerRequestRoutes from "./routes/prayer-requests";
import notificationRoutes from "./routes/notifications";
import pushRoutes from "./routes/push";
import uploadRoutes from "./routes/uploads";
import adminRoutes from "./routes/admin";
import organizationRoutes from "./routes/organizations";
import auditRoutes from "./routes/audit";

// Deployed, this function lives in a VPC whose only route out is IPv6 (see the
// networking comment in infra/lib/church-directory-stack.ts). Both the Cognito
// and RDS hostnames resolve to A and AAAA records, and the A route goes
// nowhere, so tell Node to hand the IPv6 address to the socket first rather
// than depending on Happy Eyeballs to time the IPv4 attempt out.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  setDefaultResultOrder("ipv6first");
}

/** Postgres SQLSTATE codes worth translating into a useful HTTP status. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";

/**
 * The whole API: one Hono router, one Lambda.
 *
 * CloudFront routes /api/* to this function on the same origin as the SPA, so
 * there is no CORS to configure in production and the browser sends relative
 * paths. Locally, server.ts serves the identical routes over
 * @hono/node-server, which is why `createApp` takes the database as an
 * argument -- tests pass a fake and get every route without a live Postgres.
 */
export function createApp(queryable?: Queryable) {
  // Fails here rather than on the first photo request: without the signing key
  // every image on the site 403s, and a 403 from CloudFront leaves nothing in
  // the API's logs to explain it.
  assertPhotoCookieConfig();
  // Same reasoning, one step weaker: push is optional, so this only complains
  // about a *half*-configured keypair. See assertPushConfig.
  assertPushConfig();

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: "That does not look right",
          issues: err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400
      );
    }
    // Postgres enforces rules the routes also check (one birthday per person,
    // one anniversary per couple, unique organization slugs). A race or a
    // rule only the database knows about should read as a conflict, not as an
    // unexplained 500.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === UNIQUE_VIOLATION) {
      return c.json({ error: "That already exists" }, 409);
    }
    if (pgCode === CHECK_VIOLATION || pgCode === NOT_NULL_VIOLATION) {
      return c.json({ error: "That does not look right" }, 400);
    }

    console.error("Unhandled API error", err);
    return c.json({ error: "Something went wrong" }, 500);
  });

  // Unauthenticated "is it up" check. The exemption that actually matters is
  // on the API Gateway route (see the HttpNoneAuthorizer in
  // infra/lib/church-directory-stack.ts) -- with a default authorizer on the
  // API, anything rejected there never reaches this Lambda. This list keeps
  // the local server, which has no gateway in front of it, consistent.
  const PUBLIC_PATHS = new Set(["/api/health"]);
  const auth = authMiddleware(queryable);
  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    return auth(c, next);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.route("/api/me", meRoutes);
  app.route("/api/directory", directoryRoutes);
  app.route("/api/persons", personRoutes);
  app.route("/api/families", familyRoutes);
  app.route("/api/merges", mergeRoutes);
  app.route("/api/special-dates", specialDateRoutes);
  app.route("/api/prayer-requests", prayerRequestRoutes);
  app.route("/api/notifications", notificationRoutes);
  app.route("/api/push", pushRoutes);
  app.route("/api/uploads", uploadRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/organizations", organizationRoutes);
  app.route("/api/audit", auditRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

export const app = createApp();
export const handler = handle(app);
