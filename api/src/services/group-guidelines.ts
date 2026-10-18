import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../auth";
import { one } from "../db";
import { GROUP_GUIDELINES_VERSION } from "../types";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses every groups route that changes something (anything but a read)
 * until the account has agreed to the current guidelines, so the client's gate
 * cannot be bypassed by posting through the API directly. Reads skip the check
 * to save a query on the frequent polling calls. Mounted after authentication,
 * so the caller is always set.
 */
export const requireGroupGuidelinesAgreement: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const caller = c.get("caller");
  const agreement = await one<{ version: number }>(
    c.get("db"),
    "select version from group_guidelines_agreements where app_user_id = $1",
    [caller.appUserId]
  );
  if (agreement?.version !== GROUP_GUIDELINES_VERSION) {
    throw new HTTPException(403, { message: "Agree to the group guidelines first" });
  }
  return next();
};
