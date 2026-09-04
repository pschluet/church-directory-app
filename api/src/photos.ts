import { DeleteObjectsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ulid } from "ulid";
import {
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
  | { prayerRequestAuthorPersonId: string };

/** The path prefix a prayer request attachment's key must start with. */
export function prayerRequestImagePrefix(organizationId: string, authorPersonId: string): string {
  return `photos/${organizationId}/prayer-request/${authorPersonId}/`;
}

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

export async function presignUpload(
  key: string,
  contentType: PhotoUploadType,
  contentLength: number
): Promise<string> {
  if (contentLength > MAX_RENDITION_BYTES) {
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

/** One presigned PUT per rendition, under the one prefix. */
export async function presignUploads(
  photoKey: string,
  contentType: PhotoUploadType,
  lengths: Record<PhotoRendition, number>
): Promise<Record<PhotoRendition, string>> {
  const keys = photoVariantKeys(photoKey);
  const urls = await Promise.all(
    PHOTO_RENDITIONS.map((rendition) =>
      presignUpload(keys[rendition], contentType, lengths[rendition])
    )
  );
  return Object.fromEntries(PHOTO_RENDITIONS.map((r, i) => [r, urls[i]])) as Record<
    PhotoRendition,
    string
  >;
}

/** Best-effort: a failed cleanup should not fail the user's save. */
export async function deletePhoto(key: string | null): Promise<void> {
  if (!key || STORAGE === "local") return;
  const keys = photoVariantKeys(key);
  // A legacy key resolves both renditions to the same object; dedupe so the
  // request is not asking S3 to delete it twice.
  const objects = [...new Set(Object.values(keys))].map((Key) => ({ Key }));
  try {
    await s3().send(
      new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } })
    );
  } catch (err) {
    console.error("Failed to delete replaced photo", key, err);
  }
}
