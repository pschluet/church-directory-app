import {
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ulid } from "ulid";
import { MAX_PHOTO_BYTES, type PHOTO_CONTENT_TYPES } from "./types";

/**
 * Person and family photos.
 *
 * Uploads go straight from the browser to S3 with a presigned PUT, so no image
 * bytes pass through the Lambda. Reads are presigned GETs handed back with the
 * person/family payload rather than a public CloudFront path: the bucket stays
 * private, so a photo never becomes a URL that can be shared outside the
 * parish.
 *
 * Presigning is a local signature operation -- no network call -- which
 * matters because the Lambda runs in a VPC whose only egress is IPv6 and
 * `s3.us-east-1.amazonaws.com` is IPv4-only. Actual S3 calls (deleting a
 * replaced photo) go over IPv4 through the free S3 gateway VPC endpoint.
 *
 * PHOTO_STORAGE=local swaps all of this for the filesystem so the app can be
 * run end to end with no AWS credentials at all.
 */

export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

const EXTENSION: Record<PhotoContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const STORAGE = (process.env.PHOTO_STORAGE ?? "s3") as "s3" | "local";
const BUCKET = process.env.PHOTOS_BUCKET ?? "";
const UPLOAD_URL_TTL_SECONDS = 300;
const DOWNLOAD_URL_TTL_SECONDS = 3600;

let client: S3Client | undefined;
function s3(): S3Client {
  client ??= new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  return client;
}

export function buildPhotoKey(
  organizationId: string,
  owner: { personId: string } | { familyId: string },
  contentType: PhotoContentType
): string {
  const scope = "personId" in owner ? `person/${owner.personId}` : `family/${owner.familyId}`;
  return `photos/${organizationId}/${scope}/${ulid()}.${EXTENSION[contentType]}`;
}

export async function presignUpload(
  key: string,
  contentType: PhotoContentType,
  contentLength: number
): Promise<string> {
  if (contentLength > MAX_PHOTO_BYTES) {
    throw new Error("Photo is too large");
  }
  if (STORAGE === "local") {
    return `/api/dev/photos/${encodeURIComponent(key)}`;
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
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(["content-type", "content-length"]),
    }
  );
}

export async function presignDownload(key: string | null): Promise<string | null> {
  if (!key) return null;
  if (STORAGE === "local") {
    return `/api/dev/photos/${encodeURIComponent(key)}`;
  }
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
}

/**
 * Resolves many keys at once for list responses. Signing is cheap and local,
 * but identical keys are common (a family's members sharing a family photo),
 * so dedupe rather than signing the same key repeatedly.
 */
export async function presignDownloads(keys: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  const signed = await Promise.all(unique.map((key) => presignDownload(key)));
  const result = new Map<string, string>();
  unique.forEach((key, index) => {
    const url = signed[index];
    if (url) result.set(key, url);
  });
  return result;
}

/** Best-effort: a failed cleanup should not fail the user's save. */
export async function deletePhoto(key: string | null): Promise<void> {
  if (!key || STORAGE === "local") return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error("Failed to delete replaced photo", key, err);
  }
}
