import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv } from "../auth";
import { one } from "../db";
import { assertCanEditFamily, assertCanEditPerson } from "../services/access";
import { buildPhotoKey, presignUploads } from "../photos";
import { photoUploadSchema, prayerRequestImageUploadSchema, type PhotoUploadDto } from "../types";

/**
 * Presigned photo uploads.
 *
 * The browser crops and downscales, then PUTs the bytes straight to S3, so
 * nothing large ever passes through the Lambda. Two renditions go up per photo
 * -- a thumbnail for cards and avatars, a larger one for the full-screen view --
 * so a URL is handed back for each. Permission is checked here, before any URL
 * is issued, and the returned key is scoped to the organization and the owner so
 * the follow-up `PUT /persons/:id/photo` can verify the two agree.
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
  const photoKey = buildPhotoKey(organizationId, owner);
  const uploadUrls = await presignUploads(photoKey, payload.contentType, {
    thumb: payload.renditions.thumb.contentLength,
    full: payload.renditions.full.contentLength,
  });

  const body: PhotoUploadDto = { photoKey, uploadUrls };
  return c.json(body);
});

/**
 * An image for a prayer request the caller has not written yet.
 *
 * Deliberately takes no owner. The key is scoped to the caller's own person
 * record (`prayerRequestImagePrefix`), so the only thing to check is that they
 * have one -- and `POST /prayer-requests` re-checks the prefix against the same
 * person before it stores anything, so a key obtained here cannot be attached
 * to somebody else's request.
 *
 * That scoping is what keeps creation a single request: the images go up first,
 * the row is written once with their keys, and an author who abandons the form
 * leaves two orphaned objects in S3 rather than a half-built request in the
 * database that a reviewer would see.
 */
routes.post("/prayer-request-image", async (c) => {
  const caller = c.get("caller");
  const organizationId = requireOrganizationId(c);
  const payload = prayerRequestImageUploadSchema.parse(await c.req.json());

  if (!caller.personId) {
    throw new HTTPException(400, { message: "Your own directory record is missing" });
  }

  const photoKey = buildPhotoKey(organizationId, {
    prayerRequestAuthorPersonId: caller.personId,
  });
  const uploadUrls = await presignUploads(photoKey, payload.contentType, {
    thumb: payload.renditions.thumb.contentLength,
    full: payload.renditions.full.contentLength,
  });

  const body: PhotoUploadDto = { photoKey, uploadUrls };
  return c.json(body);
});

export default routes;
