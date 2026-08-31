import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createFamily, createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";

/**
 * Presigning an upload, and attaching the result.
 *
 * The prefix check in the two attach handlers is the only thing stopping a
 * caller pointing their own record at a photo someone else uploaded -- the
 * upload endpoint issues a key scoped to one owner, and nothing but that check
 * makes the attach agree with it. It had no test.
 */

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("photos", () => {
  const db = () => testDb();
  let orgId: string;
  let otherOrgId: string;
  let familyId: string;
  let member: CreatedUser;
  let stranger: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db(), "All Saints", "all-saints");
    otherOrgId = await createOrganization(db(), "St. George", "st-george");
    familyId = await createFamily(db(), orgId, "Schlueter");
    member = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "member@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    stranger = await createUser(db(), {
      organizationId: orgId,
      familyId: null,
      email: "stranger@test.example",
      firstName: "Maria",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  const upload = { thumb: { contentLength: 20 * 1024 }, full: { contentLength: 180 * 1024 } };

  describe("POST /uploads/photo", () => {
    it("hands back one URL per rendition under a single prefix", async () => {
      const res = await as(member).call("POST", "/api/uploads/photo", {
        contentType: "image/webp",
        renditions: upload,
        personId: member.personId,
      });

      expect(res.status).toBe(200);
      expect(res.body.photoKey).toMatch(
        new RegExp(`^photos/${orgId}/person/${member.personId}/[0-9A-HJKMNP-TV-Z]+/$`)
      );
      expect(Object.keys(res.body.uploadUrls).sort()).toEqual(["full", "thumb"]);
      // Local storage mode presigns to the same paths the dev server serves.
      expect(res.body.uploadUrls.thumb).toBe(`/${res.body.photoKey}thumb`);
      expect(res.body.uploadUrls.full).toBe(`/${res.body.photoKey}full`);
    });

    it("refuses a rendition larger than a downscaled image could be", async () => {
      const res = await as(member).call("POST", "/api/uploads/photo", {
        contentType: "image/webp",
        renditions: {
          thumb: { contentLength: 20 * 1024 },
          full: { contentLength: 9 * 1024 * 1024 },
        },
        personId: member.personId,
      });
      expect(res.status).toBe(400);
    });

    it("will not presign for a person the caller cannot edit", async () => {
      const res = await as(stranger).call("POST", "/api/uploads/photo", {
        contentType: "image/webp",
        renditions: upload,
        personId: member.personId,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /persons/:id/photo", () => {
    const keyFor = (org: string, person: string) => `photos/${org}/person/${person}/01ABCDEFGH/`;

    it("attaches a key issued for that person and returns both renditions", async () => {
      const key = keyFor(orgId, member.personId!);
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: key,
      });

      expect(res.status).toBe(200);
      expect(res.body.thumbUrl).toBe(`/${key}thumb`);
      expect(res.body.fullUrl).toBe(`/${key}full`);
      // Deprecated, but still mirrored for an older cached SPA bundle.
      expect(res.body.photoUrl).toBe(`/${key}thumb`);
    });

    it("rejects a key belonging to a different person", async () => {
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: keyFor(orgId, stranger.personId!),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not belong/i);
    });

    it("rejects a key belonging to a different organization", async () => {
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: keyFor(otherOrgId, member.personId!),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a family key on a person", async () => {
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: `photos/${orgId}/family/${familyId}/01ABCDEFGH/`,
      });
      expect(res.status).toBe(400);
    });

    it("rejects a bare object key, which would store a photo with no thumbnail", async () => {
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: `${keyFor(orgId, member.personId!)}thumb`,
      });
      expect(res.status).toBe(400);
    });

    it("clears the photo with a null key", async () => {
      const key = keyFor(orgId, member.personId!);
      await as(member).call("PUT", `/api/persons/${member.personId}/photo`, { photoKey: key });
      const res = await as(member).call("PUT", `/api/persons/${member.personId}/photo`, {
        photoKey: null,
      });
      expect(res.status).toBe(200);
      expect(res.body.thumbUrl).toBeNull();
      expect(res.body.fullUrl).toBeNull();
    });
  });

  describe("PUT /families/:id/photo", () => {
    const keyFor = (org: string, family: string) => `photos/${org}/family/${family}/01ABCDEFGH/`;

    it("stores the free-form crop's dimensions alongside the key", async () => {
      const key = keyFor(orgId, familyId);
      const res = await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: key,
        photoWidth: 1600,
        photoHeight: 1067,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        thumbUrl: `/${key}thumb`,
        fullUrl: `/${key}full`,
        photoWidth: 1600,
        photoHeight: 1067,
      });
    });

    it("serves the dimensions back on the family payload", async () => {
      const key = keyFor(orgId, familyId);
      await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: key,
        photoWidth: 1600,
        photoHeight: 1067,
      });

      const res = await as(member).call("GET", `/api/families/${familyId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ photoWidth: 1600, photoHeight: 1067 });
    });

    it("clears the dimensions when the photo goes, so no stale ratio survives", async () => {
      await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: keyFor(orgId, familyId),
        photoWidth: 1600,
        photoHeight: 1067,
      });
      const res = await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: null,
      });

      expect(res.status).toBe(200);
      expect(res.body.photoWidth).toBeNull();
      expect(res.body.photoHeight).toBeNull();
    });

    it("rejects a key belonging to a different family", async () => {
      const other = await createFamily(db(), orgId, "Ivanov");
      const res = await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: keyFor(orgId, other),
      });
      expect(res.status).toBe(400);
    });

    it("wants both dimensions or neither", async () => {
      const res = await as(member).call("PUT", `/api/families/${familyId}/photo`, {
        photoKey: keyFor(orgId, familyId),
        photoWidth: 1600,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("legacy photos", () => {
    it("keeps rendering a pre-cropping key as both renditions", async () => {
      // Written straight to the column, as an old upload left it: one object
      // with an extension and no rendition suffix.
      const legacy = `photos/${orgId}/person/${member.personId}/01ABCDEF.png`;
      await db().query("update persons set photo_key = $2 where id = $1", [
        member.personId,
        legacy,
      ]);

      const res = await as(member).call("GET", `/api/persons/${member.personId}`);
      expect(res.status).toBe(200);
      expect(res.body.thumbUrl).toBe(`/${legacy}`);
      expect(res.body.fullUrl).toBe(`/${legacy}`);
    });
  });
});
