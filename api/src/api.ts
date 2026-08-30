import { setDefaultResultOrder } from "node:dns";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { authMiddleware, type AppEnv } from "./auth";
import type { Queryable } from "./db";
import meRoutes from "./routes/me";
import directoryRoutes from "./routes/directory";
import personRoutes from "./routes/persons";
import familyRoutes from "./routes/families";
import specialDateRoutes from "./routes/special-dates";
import uploadRoutes from "./routes/uploads";
import adminRoutes from "./routes/admin";
import organizationRoutes from "./routes/organizations";

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

  // Unauthenticated: used by the CD workflow and for a quick "is it up" check.
  // Listed explicitly rather than relying on being registered before the
  // middleware, so the exemption cannot be broken by reordering.
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
  app.route("/api/special-dates", specialDateRoutes);
  app.route("/api/uploads", uploadRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/organizations", organizationRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

export const app = createApp();
export const handler = handle(app);
