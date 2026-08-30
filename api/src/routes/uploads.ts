import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv } from "../auth";
import { one } from "../db";
import { assertCanEditFamily, assertCanEditPerson } from "../services/access";
import { buildPhotoKey, presignUpload } from "../photos";
import { photoUploadSchema, type PhotoUploadDto } from "../types";

/**
 * Presigned photo uploads.
 *
 * The browser PUTs the image bytes straight to S3, so nothing large ever
 * passes through the Lambda. Permission is checked here, before a URL is
 * handed out, and the returned key is scoped to the organization and the owner
 * so the follow-up `PUT /persons/:id/photo` can verify the two agree.
 */
const routes = new Hono<AppEnv>();

routes.post("/photo", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const payload = photoUploadSchema.parse(await c.req.json());

  if (payload.personId) {
    const person = await one<{
      id: string;
      organization_id: string;
      family_id: string | null;
      app_user_id: string | null;
    }>(
      db,
      `select id, organization_id, family_id, app_user_id
         from persons where id = $1 and deleted_at is null`,
      [payload.personId]
    );
    if (!person || person.organization_id !== organizationId) {
      throw new HTTPException(404, { message: "Person not found" });
    }
    assertCanEditPerson(caller, {
      id: person.id,
      organizationId: person.organization_id,
      familyId: person.family_id,
      appUserId: person.app_user_id,
    });
  } else if (payload.familyId) {
    const family = await one<{ id: string; organization_id: string }>(
      db,
      "select id, organization_id from families where id = $1",
      [payload.familyId]
    );
    if (!family || family.organization_id !== organizationId) {
      throw new HTTPException(404, { message: "Family not found" });
    }
    assertCanEditFamily(caller, { id: family.id, organizationId: family.organization_id });
  }

  const owner = payload.personId ? { personId: payload.personId } : { familyId: payload.familyId! };
  const photoKey = buildPhotoKey(organizationId, owner, payload.contentType);
  const uploadUrl = await presignUpload(photoKey, payload.contentType, payload.contentLength);

  const body: PhotoUploadDto = { uploadUrl, photoKey };
  return c.json(body);
});

export default routes;
