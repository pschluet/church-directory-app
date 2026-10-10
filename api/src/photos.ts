import { DeleteObjectsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ulid } from "ulid";
import {
  MAX_PHOTO_BYTES,
  MAX_RENDITION_BYTES,
  PHOTO_RENDITIONS,
  type PhotoRendition,
  type PhotoUploadType,
} from "./types";

/**
 * Person and family photos.
 *
 * Uploads go straight from the browser to S3 with a presigned PUT, so no image
 * bytes pass through the Lambda. The browser crops and downscales first and
 * uploads two renditions: `thumb` for avatars and directory cards, `full` for
 * the full-screen view. A card renders at 56px, so serving it the untouched
 * original -- which is what this used to do -- cost megabytes a screen.
 *
 * Reads go through CloudFront. The bucket stays private, reached by an Origin
 * Access Control, and the `/photos/*` behaviour is gated on a trusted key group:
 * a viewer needs the CloudFront-Policy/-Signature/-Key-Pair-Id cookies that
 * `photo-cookies.ts` issues. That buys what per-object presigned GETs could not
 * -- a URL that never changes, so the browser cache and the CloudFront edge both
 * work, and no photo that silently breaks after an hour.
 *
 * Presigning an upload is a local signature operation -- no network call --
 * which matters because the Lambda runs in a VPC whose only egress is IPv6 and
 * `s3.us-east-1.amazonaws.com` is IPv4-only. Actual S3 calls (deleting a
 * replaced photo) go over IPv4 through the free S3 gateway VPC endpoint.
 *
 * PHOTO_STORAGE=local swaps the bytes for the filesystem so the app can be run
 * end to end with no AWS credentials at all. The URLs are identical either way,
 * because the dev server serves the same /photos/* paths.
 */

const STORAGE = (process.env.PHOTO_STORAGE ?? "s3") as "s3" | "local";
const BUCKET = process.env.PHOTOS_BUCKET ?? "";
const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Every rendition is written once under a ULID that is never reused, so it can
 * be cached for as long as the browser likes. Replacing a photo mints a new
 * prefix rather than overwriting, which is also why CloudFront never needs an
 * invalidation.
 */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

let client: S3Client | undefined;
function s3(): S3Client {
  client ??= new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  return client;
}

/** What a stored photo belongs to, and so what its key is scoped by. */
export type PhotoOwner =
  | { personId: string }
  | { familyId: string }
  /**
   * A prayer request attachment, scoped to the *author* rather than to the
   * request. That is what lets the images be uploaded before the
   * `prayer_requests` row exists, so creating a request stays a single POST
   * with no draft state to clean up if the author changes their mind. The
   * ownership check at attach time is unaffected -- the author is exactly who
   * it needs to verify.
   */
  | { prayerRequestAuthorPersonId: string }
  /** A group's own cover photo -- free-form crop, thumb/full, no card. */
  | { groupId: string }
  /**
   * A group post attachment, scoped to the *author* for the same reason as a
   * prayer request image above: the post may not exist yet when the files go
   * up. Covers both an IMAGE attachment's renditions and a FILE attachment's
   * single object -- see `GROUP_ATTACHMENT_FILE_OBJECT` for the latter.
   */
  | { groupPostAuthorPersonId: string };

/** The path prefix a prayer request attachment's key must start with. */
export function prayerRequestImagePrefix(organizationId: string, authorPersonId: string): string {
  return `photos/${organizationId}/prayer-request/${authorPersonId}/`;
}

/** The path prefix a group post attachment's key must start with. */
export function groupAttachmentPrefix(organizationId: string, authorPersonId: string): string {
  return `photos/${organizationId}/group-post/${authorPersonId}/`;
}

/**
 * The single object name a FILE-kind attachment is stored under, inside its
 * own ULID prefix -- the document equivalent of `thumb`/`full`. There is only
 * ever one, because a FILE is never decoded to produce a second rendition.
 */
export const GROUP_ATTACHMENT_FILE_OBJECT = "file";

/**
 * The prefix both renditions live under, ending in "/" -- this is what goes in
 * `photo_key`. The organization and owner are baked into it so the attach
 * endpoints can verify a caller is not pointing their record at someone else's
 * upload, and the ULID makes every upload a fresh path.
 */
export function buildPhotoKey(organizationId: string, owner: PhotoOwner): string {
  if ("personId" in owner) {
    return `photos/${organizationId}/person/${owner.personId}/${ulid()}/`;
  }
  if ("familyId" in owner) {
    return `photos/${organizationId}/family/${owner.familyId}/${ulid()}/`;
  }
  if ("groupId" in owner) {
    return `photos/${organizationId}/group/${owner.groupId}/${ulid()}/`;
  }
  if ("groupPostAuthorPersonId" in owner) {
    return `${groupAttachmentPrefix(organizationId, owner.groupPostAuthorPersonId)}${ulid()}/`;
  }
  return `${prayerRequestImagePrefix(organizationId, owner.prayerRequestAuthorPersonId)}${ulid()}/`;
}

/**
 * The object keys for a stored photo.
 *
 * Renditions are deliberately extensionless: the content type is set on the
 * presigned PUT and lives in the object's metadata, so one key layout works
 * whether the browser encoded WebP or fell back to JPEG.
 *
 * A key that does not end in "/" predates cropping and is a single original.
 * Both renditions resolve to it, so those photos keep rendering with no
 * backfill -- they are simply still full-size until someone re-uploads.
 */
export function photoVariantKeys(key: string): Record<PhotoRendition, string> {
  if (!key.endsWith("/")) return { thumb: key, full: key };
  return { thumb: `${key}thumb`, full: `${key}full` };
}

/**
 * The families-page card rendition's key. Family-only -- a person or
 * attachment key has no `card`, same as a legacy key that predates cropping
 * and is not a prefix at all.
 */
export function familyCardKey(key: string): string | null {
  if (!key.endsWith("/")) return null;
  return `${key}card`;
}

export interface PhotoUrls {
  thumbUrl: string | null;
  fullUrl: string | null;
}

/**
 * Same-origin paths, served by CloudFront in production and by the dev server
 * locally. No signing, no expiry, no per-request work -- which is what makes
 * these cacheable, and why a directory listing no longer carries ~400
 * characters of signature per person.
 */
export function photoUrls(key: string | null): PhotoUrls {
  if (!key) return { thumbUrl: null, fullUrl: null };
  const keys = photoVariantKeys(key);
  return { thumbUrl: `/${keys.thumb}`, fullUrl: `/${keys.full}` };
}

/** The same-origin download path for a group post FILE attachment. */
export function groupAttachmentFileUrl(key: string): string {
  return `/${key}${GROUP_ATTACHMENT_FILE_OBJECT}`;
}

/**
 * The families-page card URL, or null when this photo has no card rendition --
 * either because `hasCard` is false (nothing has framed one yet) or the key
 * predates cropping.
 */
export function familyCardUrl(key: string | null, hasCard: boolean): string | null {
  if (!key || !hasCard) return null;
  const cardKey = familyCardKey(key);
  return cardKey ? `/${cardKey}` : null;
}

export async function presignUpload(
  key: string,
  contentType: PhotoUploadType,
  contentLength: number,
  maxBytes: number = MAX_RENDITION_BYTES
): Promise<string> {
  if (contentLength > maxBytes) {
    throw new Error("Photo is too large");
  }
  if (STORAGE === "local") {
    return `/${key}`;
  }
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      // Signing the length stops a presigned URL from being reused to upload
      // something much bigger than the browser said it would.
      ContentLength: contentLength,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(["content-type", "content-length", "cache-control"]),
    }
  );
}

/**
 * Presigns one group post FILE attachment -- a single passthrough object, not
 * a pair of renditions, under `MAX_PHOTO_BYTES` rather than the much smaller
 * `MAX_RENDITION_BYTES` a compressed image rendition is held to. `contentType`
 * is widened to `string` here rather than `PhotoUploadType`: the route already
 * validates it against `GROUP_DOCUMENT_CONTENT_TYPES` with Zod, and this
 * function has no independent opinion about what a document's content type may
 * be.
 */
export async function presignGroupAttachmentFile(
  photoKey: string,
  contentType: string,
  contentLength: number
): Promise<string> {
  const key = `${photoKey}${GROUP_ATTACHMENT_FILE_OBJECT}`;
  if (contentLength > MAX_PHOTO_BYTES) throw new Error("File is too large");
  if (STORAGE === "local") return `/${key}`;
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(["content-type", "content-length", "cache-control"]),
    }
  );
}

/**
 * One presigned PUT per rendition, under the one prefix. `card` is only
 * presigned when a length for it was given -- a person or attachment upload
 * never asks for one.
 */
export async function presignUploads(
  photoKey: string,
  contentType: PhotoUploadType,
  lengths: Record<PhotoRendition, number> & { card?: number }
): Promise<Record<PhotoRendition, string> & { card?: string }> {
  const keys = photoVariantKeys(photoKey);
  const urls = await Promise.all(
    PHOTO_RENDITIONS.map((rendition) =>
      presignUpload(keys[rendition], contentType, lengths[rendition])
    )
  );
  const result = Object.fromEntries(PHOTO_RENDITIONS.map((r, i) => [r, urls[i]])) as Record<
    PhotoRendition,
    string
  > & { card?: string };

  if (lengths.card !== undefined) {
    const cardKey = familyCardKey(photoKey);
    if (cardKey) result.card = await presignUpload(cardKey, contentType, lengths.card);
  }

  return result;
}

export type PhotoChange = "ADDED" | "REPLACED" | "REMOVED";

/**
 * What a photo attach did, for the audit log -- not the key itself.
 *
 * `deletePhoto` destroys the replaced object's bytes within the same request,
 * so a recorded key would point at nothing moments later; the verb is the
 * fact worth keeping. Null when the key did not actually change, which is the
 * caller's signal to skip the audit entry entirely.
 */
export function photoChange(
  previousKey: string | null,
  nextKey: string | null
): PhotoChange | null {
  if (previousKey === nextKey) return null;
  if (!previousKey) return "ADDED";
  if (!nextKey) return "REMOVED";
  return "REPLACED";
}

/**
 * Best-effort: a failed cleanup should not fail the user's save.
 *
 * The card key is only attempted for a family key, so a person or attachment
 * cleanup sends exactly the request it sent before the card rendition
 * existed -- there is never a card object at those prefixes to ask for.
 */
/**
 * Best-effort delete of a group post FILE attachment's single object.
 *
 * Not `deletePhoto`: that function assumes a `thumb`/`full` pair lives under
 * the prefix, which is true for an IMAGE attachment but not a FILE one -- a
 * document is never decoded, so there is exactly one object to remove.
 */
export async function deleteGroupAttachmentFile(key: string | null): Promise<void> {
  if (!key || STORAGE === "local") return;
  try {
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: [{ Key: `${key}${GROUP_ATTACHMENT_FILE_OBJECT}` }], Quiet: true },
      })
    );
  } catch (err) {
    console.error("Failed to delete group attachment file", key, err);
  }
}

export async function deletePhoto(key: string | null): Promise<void> {
  if (!key || STORAGE === "local") return;
  const keys = photoVariantKeys(key);
  const all = { ...keys, ...(key.includes("/family/") ? { card: familyCardKey(key) } : {}) };
  // A legacy key resolves both renditions to the same object; dedupe so the
  // request is not asking S3 to delete it twice.
  const objects = [...new Set(Object.values(all).filter((v): v is string => Boolean(v)))].map(
    (Key) => ({ Key })
  );
  try {
    await s3().send(
      new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } })
    );
  } catch (err) {
    console.error("Failed to delete replaced photo", key, err);
  }
}
