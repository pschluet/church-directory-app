import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

/**
 * CloudFront signed cookies for photo reads.
 *
 * Photos live in a private bucket reached only through CloudFront, whose
 * `/photos/*` behaviour requires a trusted signature. Rather than sign every
 * object URL -- which changes the URL on each response and so defeats the
 * browser cache entirely -- the API authorizes the *viewer* once, with three
 * cookies CloudFront validates itself. Photo paths are then permanent, and both
 * the browser cache and the CloudFront edge start working.
 *
 * Signing is a local RSA operation, so this adds no network dependency. That is
 * also why the private key arrives in a KMS-encrypted environment variable
 * rather than from Secrets Manager or SSM: the Lambda's only VPC egress is
 * IPv6, and both of those are IPv4-only on their standard endpoints.
 */

const STORAGE = (process.env.PHOTO_STORAGE ?? "s3") as "s3" | "local";
const KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID ?? "";
const PRIVATE_KEY = (process.env.CLOUDFRONT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const SITE_URL = process.env.SITE_URL ?? "";

/**
 * A week. Long enough that nobody hits an expiry mid-session, short enough that
 * revoking someone's access by removing their account takes effect promptly.
 * Refreshed on every `GET /me`, which the SPA calls on each load.
 */
export const PHOTO_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PhotoCookieScope {
  /** The organization the caller is acting in. */
  organizationId: string | null;
  isSuperAdmin: boolean;
}

/**
 * Fails at startup rather than at the first photo request, because the symptom
 * otherwise is every image on the site returning 403 with nothing in the logs.
 */
export function assertPhotoCookieConfig(): void {
  if (STORAGE === "local") return;
  const missing = [
    ["CLOUDFRONT_KEY_PAIR_ID", KEY_PAIR_ID],
    ["CLOUDFRONT_PRIVATE_KEY", PRIVATE_KEY],
    ["SITE_URL", SITE_URL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Photo delivery is misconfigured: ${missing.join(", ")} must be set when PHOTO_STORAGE=s3`
    );
  }
}

/**
 * The one resource pattern the cookie authorizes.
 *
 * A CloudFront custom policy allows exactly one `Resource`, which forces a
 * choice for super admins: `GET /me` deliberately loads their own record from
 * their *home* parish while they act in another (see `asHomeParishCaller` in
 * routes/me.ts), so a photo path under a second organization is legitimate and
 * a per-organization scope would break it. Everyone else is pinned to their own
 * organization, so the cookie cannot read another parish's photos even if a key
 * were somehow guessed -- and keys carry an organization UUID and a ULID, so
 * they are not guessable.
 */
export function photoResourcePattern(siteUrl: string, scope: PhotoCookieScope): string | null {
  if (scope.isSuperAdmin) return `${siteUrl}/photos/*`;
  if (!scope.organizationId) return null;
  return `${siteUrl}/photos/${scope.organizationId}/*`;
}

export function buildPhotoPolicy(
  siteUrl: string,
  scope: PhotoCookieScope,
  expiresAtEpochSeconds: number
): string | null {
  const resource = photoResourcePattern(siteUrl, scope);
  if (!resource) return null;
  return JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { "AWS:EpochTime": expiresAtEpochSeconds } },
      },
    ],
  });
}

export interface PhotoCookie {
  name: string;
  value: string;
}

/**
 * Empty when there is nothing to authorize: local development serves photos
 * from disk, and someone with no organization has no photos to read.
 */
export function signPhotoCookies(scope: PhotoCookieScope, now = new Date()): PhotoCookie[] {
  if (STORAGE === "local") return [];

  const expires = Math.floor(now.getTime() / 1000) + PHOTO_COOKIE_TTL_SECONDS;
  const policy = buildPhotoPolicy(SITE_URL, scope, expires);
  if (!policy) return [];

  const signed = getSignedCookies({ keyPairId: KEY_PAIR_ID, privateKey: PRIVATE_KEY, policy });
  return Object.entries(signed).map(([name, value]) => ({ name, value: String(value) }));
}
