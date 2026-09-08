/**
 * Geocoding: an address in, a `place_id` and a pair of coordinates out.
 *
 * The second piece of this app that talks to a third party from inside the VPC,
 * and the same caveat as `push.ts` applies: that VPC has no NAT gateway, and
 * its only route out is IPv6 through an egress-only internet gateway.
 * `maps.googleapis.com` publishes AAAA records, so this reaches Google over
 * IPv6 with no endpoint override and nothing added to the network.
 * `api/src/api.ts` already sets `ipv6first` in Lambda, which matters here too:
 * the A route goes nowhere, and without that ordering every geocode would wait
 * on Happy Eyeballs timing the IPv4 attempt out.
 *
 * Plain `fetch` rather than a Google SDK. `push.ts` pulls in `web-push` only
 * because it has to sign VAPID; this is one GET with three query parameters,
 * and a dependency for that is a dependency to keep patched for no gain.
 *
 * The key arrives in a KMS-encrypted environment variable, for the same reason
 * as VAPID_PRIVATE_KEY and CLOUDFRONT_PRIVATE_KEY: Secrets Manager and SSM are
 * both unreachable from this subnet, and the Lambda runtime decrypts an
 * environment variable with no network call at all. It is a different key from
 * the one the browser gets -- this one carries no application restriction,
 * because a Lambda leaving over IPv6 has no stable address to restrict it to,
 * so it must never reach a page.
 *
 * GEOCODING_MODE=local makes every call return `not_configured` so the app runs
 * end to end on a laptop with no Google project -- the same shape as
 * PUSH_MODE=local and PHOTO_STORAGE=local.
 */

const MODE = (process.env.GEOCODING_MODE ?? "google") as "google" | "local";
const API_KEY = process.env.GOOGLE_MAPS_SERVER_KEY ?? "";

/*
 * The browser's half of the same integration, read here so that one module
 * owns every Google setting and `createApp` has one place to check them.
 *
 * Which key is which matters. The browser key reaches a page by design, so it
 * is restricted in the Google console to this site's referrers and capped
 * there; the server key above carries no application restriction, because a
 * Lambda leaving over IPv6 has no stable address to restrict it to, and so
 * must never be handed to a browser.
 */
const BROWSER_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY ?? "";

/**
 * The Map ID the styled vector map is published under.
 *
 * Hardcoded rather than configured, because it is not a secret and never was:
 * it names a *style*, it is already sent to every signed-in browser, and it is
 * visible in any request the map makes. Making it a GitHub secret and threading
 * it through CDK context, a stack prop and a Lambda environment variable was
 * three files of plumbing to hide a value that is published by design.
 *
 * It does identify a style in one Google Cloud project, so a deployment against
 * a different project needs this line changed -- Advanced Markers will not
 * render against a Map ID the project does not own. Edit the style itself in
 * the console (Google Maps Platform -> Map Styles); it takes effect with no
 * deploy, which is most of how the map gets the parish's colours.
 */
const MAP_ID = "8c0a756910db1f3475ae8ba6";

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * A geocode is worth waiting three seconds for and no longer.
 *
 * It runs inside a person save, and the save is the thing that has to succeed:
 * an address stored without a pin is a small loss, and a request that hangs
 * until the Lambda's own timeout loses the write. Google answers in well under
 * a second in practice.
 */
const TIMEOUT_MS = 3_000;

/**
 * The `types` on a result that mean "this is a building, not a neighbourhood".
 *
 * Anything broader gets rejected even though Google returned coordinates for
 * it, because a pin dropped in the middle of a postcode is worse than no pin:
 * it looks like it knew. This is the same judgement `hasMappableAddress` makes
 * on the client when it refuses to link a city-only address.
 */
const PRECISE_TYPES = new Set(["street_address", "premise", "subpremise", "rooftop"]);

export interface Geocode {
  placeId: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
}

export type GeocodeFailure =
  /** No key on this deployment, or GEOCODING_MODE=local. Not the user's fault. */
  | "not_configured"
  /** Google has never heard of it. Almost always a typo. */
  | "no_match"
  /** Google found something, but only a street, a suburb or a postcode. */
  | "imprecise"
  /** Timeout, network error, quota exhausted, 5xx. Worth retrying later. */
  | "unavailable";

export type GeocodeResult = ({ ok: true } & Geocode) | { ok: false; reason: GeocodeFailure };

/**
 * Whether geocoding is configured at all. Read rather than asserted, for the
 * reason `isPushConfigured` is: a parish running without a key should still be
 * able to save an address. It simply does not get a pin.
 */
export function isGeocodingConfigured(): boolean {
  if (MODE === "local") return false;
  return Boolean(API_KEY);
}

/**
 * Nothing to assert beyond the mode, unlike `assertPushConfig`: there is one
 * value rather than three, so there is no half-configured state to catch. The
 * function exists so that `createApp` has one call per integration and adding
 * a second key later has somewhere obvious to go.
 */
export function assertGeocodingConfig(): void {
  if (MODE === "local") return;
  if (process.env.GOOGLE_MAPS_BROWSER_KEY && !API_KEY) {
    throw new Error(
      "Google Maps is half-configured: GOOGLE_MAPS_SERVER_KEY must be set alongside " +
        "GOOGLE_MAPS_BROWSER_KEY, or the map loads and no address ever gets coordinates"
    );
  }
}

/**
 * What the SPA needs to draw a map, or nulls when this deployment cannot.
 *
 * Both or neither, even though the Map ID is now a constant that is always
 * present: the caller treats a null key as "no map here", and handing back a
 * Map ID beside it would be offering half of something that cannot work.
 */
export function mapsBrowserConfig(): { key: string | null; mapId: string | null } {
  if (MODE === "local" || !BROWSER_KEY) return { key: null, mapId: null };
  return { key: BROWSER_KEY, mapId: MAP_ID };
}

/** Resolve a `place_id` Places Autocomplete already gave us. */
export function geocodeByPlaceId(placeId: string): Promise<GeocodeResult> {
  return request({ place_id: placeId });
}

/** Resolve a free-text address somebody typed by hand. */
export function geocodeByAddress(address: string): Promise<GeocodeResult> {
  return request({ address });
}

interface GoogleResult {
  place_id?: string;
  formatted_address?: string;
  partial_match?: boolean;
  types?: string[];
  geometry?: {
    location?: { lat?: number; lng?: number };
    location_type?: string;
  };
}

async function request(params: Record<string, string>): Promise<GeocodeResult> {
  if (!isGeocodingConfigured()) return { ok: false, reason: "not_configured" };

  const url = new URL(ENDPOINT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("key", API_KEY);

  let payload: { status?: string; results?: GoogleResult[] };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      console.error(`Geocoding returned HTTP ${response.status}`);
      return { ok: false, reason: "unavailable" };
    }
    payload = (await response.json()) as typeof payload;
  } catch (err) {
    // Timeout, DNS, TLS, malformed body. All the same to the caller.
    console.error("Geocoding request failed", err);
    return { ok: false, reason: "unavailable" };
  }

  return classify(payload);
}

/**
 * Turn Google's answer into something the UI can say out loud.
 *
 * Taking `results[0]` unconditionally is the mistake this exists to avoid.
 * Google is obliging: give it half an address and it will hand back the middle
 * of a city with `partial_match` set, which is a successful response and a
 * useless pin. The three failures are distinguished because only one of them
 * is worth telling the user about in those words -- `no_match` means look at
 * what you typed, `imprecise` means it is not specific enough, and
 * `unavailable` means try again later and is nobody's fault.
 */
export function classify(payload: { status?: string; results?: GoogleResult[] }): GeocodeResult {
  if (payload.status === "ZERO_RESULTS") return { ok: false, reason: "no_match" };
  if (payload.status !== "OK") {
    console.error(`Geocoding status ${payload.status ?? "missing"}`);
    return { ok: false, reason: "unavailable" };
  }

  const top = payload.results?.[0];
  const latitude = top?.geometry?.location?.lat;
  const longitude = top?.geometry?.location?.lng;
  if (!top?.place_id || typeof latitude !== "number" || typeof longitude !== "number") {
    return { ok: false, reason: "no_match" };
  }

  if (top.partial_match) return { ok: false, reason: "imprecise" };

  /*
   * ROOFTOP and RANGE_INTERPOLATED are a specific building or a point along a
   * known address range, and both are good enough to draw. GEOMETRIC_CENTER and
   * APPROXIMATE are the centre of something larger -- a street, a suburb, a
   * postcode -- so they are only accepted when the result also claims to be a
   * building, which happens for addresses Google holds without a precise fix.
   */
  const locationType = top.geometry?.location_type ?? "";
  const precise =
    locationType === "ROOFTOP" ||
    locationType === "RANGE_INTERPOLATED" ||
    (top.types ?? []).some((type) => PRECISE_TYPES.has(type));
  if (!precise) return { ok: false, reason: "imprecise" };

  return {
    ok: true,
    placeId: top.place_id,
    formattedAddress: top.formatted_address ?? "",
    latitude,
    longitude,
  };
}

/** What to tell the person who just saved the address. Null when nothing is wrong. */
export function geocodeWarning(reason: GeocodeFailure): string | null {
  switch (reason) {
    case "not_configured":
      // Nothing was expected to work, so there is nothing to report.
      return null;
    case "no_match":
      return "This address was saved, but the map could not find it. Check it for typos.";
    case "imprecise":
      return "This address was saved, but is not specific enough to place on the map.";
    case "unavailable":
      return "This address was saved, but the map service could not be reached. It will be placed on the map later.";
  }
}
