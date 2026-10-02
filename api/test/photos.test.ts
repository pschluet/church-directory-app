import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPhotoKey,
  familyCardKey,
  familyCardUrl,
  photoUrls,
  photoVariantKeys,
  presignUploads,
} from "../src/photos";
import { buildPhotoPolicy, photoResourcePattern, signPhotoCookies } from "../src/photo-cookies";

const ORG = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

describe("buildPhotoKey", () => {
  it("returns a prefix ending in a slash, scoped to the owner", () => {
    const key = buildPhotoKey(ORG, { personId: PERSON });
    expect(key.startsWith(`photos/${ORG}/person/${PERSON}/`)).toBe(true);
    expect(key.endsWith("/")).toBe(true);
  });

  it("never reuses a prefix, so a rendition URL can be cached forever", () => {
    expect(buildPhotoKey(ORG, { familyId: PERSON })).not.toBe(
      buildPhotoKey(ORG, { familyId: PERSON })
    );
  });

  it("keeps the attach endpoint's prefix check satisfiable for families too", () => {
    expect(
      buildPhotoKey(ORG, { familyId: PERSON }).startsWith(`photos/${ORG}/family/${PERSON}/`)
    ).toBe(true);
  });
});

describe("photoVariantKeys", () => {
  it("derives both renditions from the prefix", () => {
    const key = `photos/${ORG}/person/${PERSON}/01ABCDEF/`;
    expect(photoVariantKeys(key)).toEqual({
      thumb: `${key}thumb`,
      full: `${key}full`,
    });
  });

  it("treats a key that predates cropping as a single original", () => {
    // Photos uploaded before renditions existed are one object with an
    // extension. Both variants resolve to it so they keep rendering rather
    // than 404ing, which is what lets this ship with no backfill.
    const legacy = `photos/${ORG}/person/${PERSON}/01ABCDEF.png`;
    expect(photoVariantKeys(legacy)).toEqual({ thumb: legacy, full: legacy });
  });
});

describe("familyCardKey", () => {
  it("names the card rendition under the prefix", () => {
    const key = `photos/${ORG}/family/${PERSON}/01ABCDEF/`;
    expect(familyCardKey(key)).toBe(`${key}card`);
  });

  it("has no card for a key that predates cropping", () => {
    const legacy = `photos/${ORG}/family/${PERSON}/01ABCDEF.png`;
    expect(familyCardKey(legacy)).toBeNull();
  });
});

describe("familyCardUrl", () => {
  const key = `photos/${ORG}/family/${PERSON}/01ABCDEF/`;

  it("builds the same-origin card path once one has been framed", () => {
    expect(familyCardUrl(key, true)).toBe(`/${key}card`);
  });

  it("is null until a card has been framed, so a legacy photo falls back with no 404", () => {
    expect(familyCardUrl(key, false)).toBeNull();
  });

  it("is null with no key at all", () => {
    expect(familyCardUrl(null, true)).toBeNull();
  });
});

describe("presignUploads", () => {
  it("presigns thumb and full but not a card nobody asked for", async () => {
    const key = `photos/${ORG}/family/${PERSON}/01ABCDEF/`;
    const urls = await presignUploads(key, "image/webp", { thumb: 100, full: 200 });
    expect(urls.thumb).toBe(`/${key}thumb`);
    expect(urls.full).toBe(`/${key}full`);
    expect(urls.card).toBeUndefined();
  });

  it("presigns a card too when a length for it was given", async () => {
    const key = `photos/${ORG}/family/${PERSON}/01ABCDEF/`;
    const urls = await presignUploads(key, "image/webp", { thumb: 100, full: 200, card: 50 });
    expect(urls.card).toBe(`/${key}card`);
  });
});

/**
 * `deletePhoto` no-ops under PHOTO_STORAGE=local (the suite's default, so
 * nothing here touches real S3), so the key selection it does before that
 * early return has to be exercised with the storage mode stubbed back to
 * `s3` and the SDK client mocked -- re-imported per case, the same pattern
 * `geocoding.test.ts` uses, since `photos.ts` reads STORAGE once at load.
 */
describe("deletePhoto", () => {
  async function load() {
    vi.resetModules();
    vi.stubEnv("PHOTO_STORAGE", "s3");
    const send = vi.fn().mockResolvedValue({});
    // `photos.ts` calls both with `new`, so the mocks need a real function --
    // vi.fn()'s default arrow-function implementation cannot be constructed.
    vi.doMock("@aws-sdk/client-s3", () => ({
      S3Client: vi.fn().mockImplementation(function S3Client() {
        return { send };
      }),
      PutObjectCommand: vi.fn(),
      DeleteObjectsCommand: vi.fn().mockImplementation(function DeleteObjectsCommand(
        input: unknown
      ) {
        return { input };
      }),
    }));
    const mod = await import("../src/photos");
    return { deletePhoto: mod.deletePhoto, send };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@aws-sdk/client-s3");
    vi.resetModules();
  });

  interface DeleteObjectsInput {
    input: { Delete: { Objects: { Key: string }[] } };
  }

  function deletedKeys(send: ReturnType<typeof vi.fn>): string[] {
    const [command] = send.mock.calls[0] as [DeleteObjectsInput];
    return command.input.Delete.Objects.map((o) => o.Key);
  }

  it("deletes the card object too for a family key", async () => {
    const { deletePhoto, send } = await load();
    const key = `photos/${ORG}/family/${PERSON}/01ABCDEF/`;
    await deletePhoto(key);
    expect(deletedKeys(send)).toEqual(
      expect.arrayContaining([`${key}thumb`, `${key}full`, `${key}card`])
    );
  });

  it("asks for exactly the same two objects as before for a person key", async () => {
    const { deletePhoto, send } = await load();
    const key = `photos/${ORG}/person/${PERSON}/01ABCDEF/`;
    await deletePhoto(key);
    expect(deletedKeys(send).sort()).toEqual([`${key}full`, `${key}thumb`].sort());
  });
});

describe("photoUrls", () => {
  it("builds same-origin paths, not signed URLs", () => {
    const key = `photos/${ORG}/person/${PERSON}/01ABCDEF/`;
    expect(photoUrls(key)).toEqual({
      thumbUrl: `/photos/${ORG}/person/${PERSON}/01ABCDEF/thumb`,
      fullUrl: `/photos/${ORG}/person/${PERSON}/01ABCDEF/full`,
    });
  });

  it("is stable across calls, which is the whole point", () => {
    // The old presignDownload minted a fresh signature every response, so the
    // URL changed and the browser cache never hit.
    const key = `photos/${ORG}/person/${PERSON}/01ABCDEF/`;
    expect(photoUrls(key)).toEqual(photoUrls(key));
  });

  it("has nothing to say about a person with no photo", () => {
    expect(photoUrls(null)).toEqual({ thumbUrl: null, fullUrl: null });
  });
});

describe("photoResourcePattern", () => {
  const SITE = "https://directory.test.example";

  it("pins an ordinary member to their own parish", () => {
    expect(photoResourcePattern(SITE, { organizationId: ORG, isSuperAdmin: false })).toBe(
      `${SITE}/photos/${ORG}/*`
    );
  });

  it("lets a super admin read across parishes", () => {
    // GET /me loads a super admin's own record from their *home* parish while
    // they act in another, so a photo path under a second organization is
    // legitimate. A CloudFront policy allows only one Resource, so this is the
    // only way that photo can load.
    expect(photoResourcePattern(SITE, { organizationId: ORG, isSuperAdmin: true })).toBe(
      `${SITE}/photos/*`
    );
  });

  it("authorizes nothing for an account with no parish", () => {
    expect(photoResourcePattern(SITE, { organizationId: null, isSuperAdmin: false })).toBeNull();
  });
});

describe("buildPhotoPolicy", () => {
  const SITE = "https://directory.test.example";

  it("expires the grant", () => {
    const policy = buildPhotoPolicy(SITE, { organizationId: ORG, isSuperAdmin: false }, 1_700_000);
    expect(JSON.parse(policy!)).toEqual({
      Statement: [
        {
          Resource: `${SITE}/photos/${ORG}/*`,
          Condition: { DateLessThan: { "AWS:EpochTime": 1_700_000 } },
        },
      ],
    });
  });

  it("is null when there is nothing to authorize", () => {
    expect(
      buildPhotoPolicy(SITE, { organizationId: null, isSuperAdmin: false }, 1_700_000)
    ).toBeNull();
  });
});

describe("signPhotoCookies", () => {
  it("issues none in local mode, where photos come off disk", () => {
    // The test env sets PHOTO_STORAGE=local, so this also proves the suite
    // never needs a real signing key.
    expect(signPhotoCookies({ organizationId: ORG, isSuperAdmin: false })).toEqual([]);
  });
});
