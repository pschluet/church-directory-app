import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "./api";
import type { AppEnv, Claims } from "./auth";
import { closePool } from "./db";

/**
 * Local development only -- this file is never deployed.
 *
 * Deployed, API Gateway's Cognito JWT authorizer validates the token and hands
 * the Lambda a set of claims. There is no authorizer in front of `tsx watch`,
 * so this server does the equivalent work itself and puts the same claim shape
 * on the context. Routes cannot tell the difference.
 *
 * Two auth modes:
 *
 *   DEV_AUTH_EMAIL set    No token needed; every request is treated as that
 *                         person. This is what makes "run the whole app on my
 *                         laptop" true with no AWS account at all. Combine with
 *                         COGNITO_MODE=local and PHOTO_STORAGE=local.
 *
 *   otherwise             Verifies a real ID token from the deployed user pool
 *                         with aws-jwt-verify. Email OTP arrives in your actual
 *                         inbox, so you are exercising the real sign-in flow.
 */

const PORT = Number(process.env.PORT ?? 3000);
const DEV_AUTH_EMAIL = process.env.DEV_AUTH_EMAIL;
const LOCAL_PHOTO_DIR = path.resolve(process.env.LOCAL_PHOTO_DIR ?? ".local-photos");

const verifier = DEV_AUTH_EMAIL
  ? null
  : CognitoJwtVerifier.create({
      userPoolId: requiredEnv("USER_POOL_ID"),
      clientId: requiredEnv("USER_POOL_CLIENT_ID"),
      tokenUse: "id",
    });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it from the CDK stack outputs, or set DEV_AUTH_EMAIL to skip Cognito entirely.`
    );
  }
  return value;
}

// Typed with AppEnv so the claims this server sets are the same context
// variable the API's auth middleware reads; `route()` shares one request
// context between the two apps.
const root = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Local photo storage, standing in for S3 and CloudFront.
//
// Deliberately the same /photos/* paths the deployed app serves, so the API
// hands out identical URLs in both modes and nothing downstream branches on
// storage. Registered before the API so it is reachable without a token -- an
// <img src> cannot send one, which is what CloudFront signed cookies solve in
// production and nothing needs to solve here.
// ---------------------------------------------------------------------------
function localPhotoPath(key: string): string {
  // Keys look like photos/<org>/person/<id>/<ulid>/thumb; flatten to one file
  // and refuse anything that tries to climb out of the directory.
  const flat = key
    .replace(/\.\./g, "")
    .replace(/[^\w./-]/g, "_")
    .replace(/\//g, "__");
  return path.join(LOCAL_PHOTO_DIR, flat);
}

/** The key a /photos/... request is asking for, with the leading slash gone. */
function photoKeyFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname).slice(1);
}

/**
 * Renditions are stored without an extension, because deployed they carry their
 * content type in S3 object metadata. On disk there is nowhere to put that, so
 * sniff the magic bytes instead -- cheaper and more honest than a sidecar file.
 */
function sniffContentType(bytes: Buffer): string {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF") {
    if (bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";
  return "application/octet-stream";
}

root.put("/photos/*", async (c) => {
  const key = photoKeyFromUrl(c.req.url);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  await fs.mkdir(LOCAL_PHOTO_DIR, { recursive: true });
  await fs.writeFile(localPhotoPath(key), bytes);
  return c.body(null, 200);
});

root.get("/photos/*", async (c) => {
  const key = photoKeyFromUrl(c.req.url);
  try {
    const bytes = await fs.readFile(localPhotoPath(key));
    return c.body(bytes, 200, {
      "content-type": sniffContentType(bytes),
      // Deployed these are immutable, but a dev who re-seeds wants the new
      // bytes and the keys are not content-addressed across a reset.
      "cache-control": "no-store",
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// ---------------------------------------------------------------------------
// Auth, then everything else.
// ---------------------------------------------------------------------------
root.use("/api/*", async (c, next) => {
  if (DEV_AUTH_EMAIL) {
    const claims: Claims = {
      // A stable fake subject, so the bind-by-email path in auth.ts runs once
      // and then resolves directly on later requests, exactly as in production.
      sub: `dev-${DEV_AUTH_EMAIL}`,
      email: DEV_AUTH_EMAIL.toLowerCase(),
      emailVerified: true,
    };
    c.set("claims", claims);
    return next();
  }

  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(); // auth.ts will turn the missing claims into a 401.

  try {
    const payload = await verifier!.verify(token);
    c.set("claims", {
      sub: payload.sub,
      email: String(payload.email ?? "").toLowerCase(),
      emailVerified: payload.email_verified === true,
    });
  } catch {
    return c.json({ error: "Invalid or expired sign-in" }, 401);
  }
  return next();
});

root.route("/", app);

const server = serve({ fetch: root.fetch, port: PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  if (DEV_AUTH_EMAIL) {
    console.log(`Auth bypassed: every request is ${DEV_AUTH_EMAIL}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void closePool().finally(() => process.exit(0));
  });
}
