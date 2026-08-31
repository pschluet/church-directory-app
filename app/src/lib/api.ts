import { fetchAuthSession } from "aws-amplify/auth";
import { PHOTO_RENDITIONS, type PhotoUploadDto } from "@shared";
import type { Renditions } from "./images";

/**
 * The one place that talks to the API.
 *
 * In production the SPA and API share an origin through CloudFront, so every
 * path is relative and there is no CORS. Locally, Vite proxies /api to the Hono
 * node server.
 */

export const DEV_AUTH = import.meta.env.VITE_DEV_AUTH === "true";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: { path: string; message: string }[]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A super admin acts inside a chosen organization; everyone else is pinned to
 * their own and this is ignored by the server. Kept in localStorage so the
 * choice survives a reload.
 */
const ORG_STORAGE_KEY = "directory.orgId";

export function getActiveOrganizationId(): string | null {
  try {
    return localStorage.getItem(ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrganizationId(orgId: string | null): void {
  try {
    if (orgId) localStorage.setItem(ORG_STORAGE_KEY, orgId);
    else localStorage.removeItem(ORG_STORAGE_KEY);
  } catch {
    // Private browsing; the server falls back to the caller's own organization.
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  // With DEV_AUTH the local server synthesises the claims, so there is no token
  // to send and no Cognito to ask for one.
  if (DEV_AUTH) return {};
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  return token ? { authorization: `Bearer ${token}` } : {};
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Extra query parameters; the active organization is added automatically. */
  query?: Record<string, string | number | undefined | null>;
  /** Set false for the organization list itself, which is not org-scoped. */
  withOrg?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, withOrg = true } = options;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const orgId = getActiveOrganizationId();
  if (withOrg && orgId && !params.has("orgId")) params.set("orgId", orgId);

  const queryString = params.toString();
  const response = await fetch(`/api${path}${queryString ? `?${queryString}` : ""}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const { error, issues } = (payload ?? {}) as {
      error?: string;
      issues?: { path: string; message: string }[];
    };
    throw new ApiError(response.status, error ?? "Something went wrong", issues);
  }

  return payload as T;
}

/**
 * Uploads a cropped photo: ask the API to presign one URL per rendition, PUT the
 * bytes straight to S3, then hand the key back so the caller can attach it. The
 * bytes never pass through the Lambda.
 *
 * The cache-control header is signed into the presigned URL, so it has to be
 * sent verbatim or S3 rejects the PUT. It is safe to make these immutable
 * because every upload gets a fresh ULID prefix -- nothing is ever overwritten.
 */
export async function uploadPhoto(
  owner: { personId: string } | { familyId: string },
  renditions: Renditions
): Promise<string> {
  const { photoKey, uploadUrls } = await api<PhotoUploadDto>("/uploads/photo", {
    method: "POST",
    body: {
      contentType: renditions.contentType,
      renditions: {
        thumb: { contentLength: renditions.blobs.thumb.size },
        full: { contentLength: renditions.blobs.full.size },
      },
      ...owner,
    },
  });

  await Promise.all(
    PHOTO_RENDITIONS.map(async (rendition) => {
      const put = await fetch(uploadUrls[rendition], {
        method: "PUT",
        headers: {
          "content-type": renditions.contentType,
          "cache-control": "public, max-age=31536000, immutable",
        },
        body: renditions.blobs[rendition],
      });
      if (!put.ok) throw new ApiError(put.status, "The photo could not be uploaded");
    })
  );

  return photoKey;
}
