import { db, type Queryable } from "./db";
import { geocodeByAddress, geocodeByPlaceId, isGeocodingConfigured } from "./services/geocoding";
import { addressToLine } from "./services/addresses";

/**
 * Keeping coordinates inside Google's caching terms, and filling in the ones
 * that were never resolved.
 *
 * Google's Maps Platform Service Specific Terms allow `lat`/`lng` to be cached
 * for 30 consecutive calendar days. There is an exception for keeping them
 * indefinitely, but it requires the cached value to be "logically isolated to
 * the specific End User it is associated with and must not be used across
 * multiple End Users" -- and a parish map that shows every home to every
 * member is the opposite of that. `place_id` is separately exempt and is
 * stored forever, which is why it is the durable key and the coordinates are a
 * cache with an age on them.
 *
 * So this runs daily and re-resolves anything approaching 30 days old. The
 * compliance is the reason it exists; the side benefit is that it self-heals
 * when Google corrects an address, which nothing else here would notice.
 *
 * A separate function from the API rather than a schedule pointed at it: that
 * one sits behind a JWT authorizer with no claims for EventBridge to present,
 * and is sized for request/response work. It shares the VPC, the security
 * group and the IAM database grant, and reaches Google the same way -- over
 * IPv6 through the egress-only gateway, with nothing added to the network.
 */

/**
 * How many addresses one run touches.
 *
 * At 25 days the eligible set is roughly a month's worth of a parish, so a
 * couple of hundred is a whole parish in one go and still finishes inside a
 * short timeout. A backlog simply carries to tomorrow.
 */
const BATCH = 200;

/**
 * 25 rather than 30, so a run that fails -- or a deploy that pauses the
 * schedule -- has five days of slack before anything is out of terms.
 */
const REFRESH_AFTER_DAYS = 25;

/**
 * A pause between calls.
 *
 * Serial rather than `Promise.all`: 200 concurrent requests to Google from one
 * Lambda is a rate limit waiting to happen, and this is a daily job with
 * nobody watching, so there is nothing to gain by being quick.
 */
const DELAY_MS = 50;

export interface RefreshEvent {
  /**
   * Limit to one parish. Used when a super admin has just switched Map View
   * on: the flag alone populates nothing, because a disabled parish was never
   * geocoded in the first place.
   */
  organizationId?: string;
  /**
   * Also resolve addresses that have never had a `place_id` at all, rather
   * than only refreshing ones that do. This is the backfill -- for the initial
   * migration, and for a parish being switched on.
   */
  backfill?: boolean;
}

export interface RefreshSummary {
  refreshed: number;
  backfilled: number;
  /** Addresses Google no longer recognises, whose coordinates were cleared. */
  dropped: number;
  failed: number;
  skipped?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StaleRow {
  place_id: string;
}

/**
 * Stale coordinates that at least one enabled parish still points at.
 *
 * The `exists` is the per-parish switch doing its work: a parish with Map View
 * off makes no calls to Google, including this one. Rows only it references
 * simply age out, and are resolved again if it is switched back on.
 *
 * Both branches matter. Without the second, the church's own pin is the one
 * coordinate on the map that never refreshes -- no person points at it.
 */
async function selectStale(q: Queryable, organizationId?: string): Promise<StaleRow[]> {
  const { rows } = await q.query<StaleRow>(
    `select g.place_id
       from geocoded_addresses g
      where g.geocoded_at < now() - ($1 || ' days')::interval
        and (
          exists (
            select 1
              from persons p
              join organizations o on o.id = p.organization_id
             where p.place_id = g.place_id
               and p.deleted_at is null
               and o.map_view_enabled
               and ($2::uuid is null or o.id = $2::uuid)
          )
          or exists (
            select 1
              from organizations o
             where o.place_id = g.place_id
               and o.map_view_enabled
               and ($2::uuid is null or o.id = $2::uuid)
          )
        )
      order by g.geocoded_at asc
      limit ${BATCH}`,
    [String(REFRESH_AFTER_DAYS), organizationId ?? null]
  );
  return rows;
}

interface UngeocodedRow {
  id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

/**
 * People in enabled parishes who have a street address and no pin.
 *
 * Read from `persons` rather than `persons_resolved`: somebody who inherits
 * their address inherits the pin along with it, so resolving them separately
 * would geocode the same house twice and put a second, identical row in the
 * table.
 */
async function selectUngeocoded(q: Queryable, organizationId?: string): Promise<UngeocodedRow[]> {
  const { rows } = await q.query<UngeocodedRow>(
    `select p.id, p.address_line1, p.address_line2, p.city, p.state, p.postal_code, p.country
       from persons p
       join organizations o on o.id = p.organization_id
      where p.deleted_at is null
        and p.place_id is null
        and p.inherit_address_from_person_id is null
        and p.address_line1 is not null
        and o.map_view_enabled
        and ($1::uuid is null or o.id = $1::uuid)
      order by p.updated_at asc
      limit ${BATCH}`,
    [organizationId ?? null]
  );
  return rows;
}

async function storeGeocode(
  q: Queryable,
  geocode: { placeId: string; formattedAddress: string; latitude: number; longitude: number }
): Promise<void> {
  await q.query(
    `insert into geocoded_addresses (place_id, formatted_address, latitude, longitude, geocoded_at)
          values ($1, $2, $3, $4, now())
     on conflict (place_id) do update
            set formatted_address = excluded.formatted_address,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                geocoded_at = now()`,
    [geocode.placeId, geocode.formattedAddress, geocode.latitude, geocode.longitude]
  );
}

export async function refreshGeocodes(
  q: Queryable,
  event: RefreshEvent = {}
): Promise<RefreshSummary> {
  const summary: RefreshSummary = { refreshed: 0, backfilled: 0, dropped: 0, failed: 0 };

  if (!isGeocodingConfigured()) {
    // Not an error. A deployment with no Google project is a supported state,
    // and saying so beats a run that reports zero of everything.
    return { ...summary, skipped: "geocoding is not configured" };
  }

  for (const { place_id: placeId } of await selectStale(q, event.organizationId)) {
    const result = await geocodeByPlaceId(placeId);
    if (result.ok) {
      await storeGeocode(q, result);
      summary.refreshed += 1;
    } else if (result.reason === "no_match" || result.reason === "imprecise") {
      /*
       * Google has stopped recognising this id, or no longer places it well
       * enough. Clear the point and keep the row: the address stays on the
       * person's record and they fall off the map, which is the honest
       * outcome. Touching `geocoded_at` also stops it being retried daily
       * forever.
       */
      await q.query(
        `update geocoded_addresses
            set latitude = null, longitude = null, geocoded_at = now()
          where place_id = $1`,
        [placeId]
      );
      summary.dropped += 1;
      console.warn(`Dropped coordinates for place_id ${placeId}: ${result.reason}`);
    } else {
      // Timeout or quota. Leave `geocoded_at` alone so tomorrow tries again.
      summary.failed += 1;
    }
    await sleep(DELAY_MS);
  }

  if (event.backfill) {
    for (const person of await selectUngeocoded(q, event.organizationId)) {
      // `addressToLine` speaks the payload's camelCase, not the row's.
      const line = addressToLine({
        addressLine1: person.address_line1,
        addressLine2: person.address_line2,
        city: person.city,
        state: person.state,
        postalCode: person.postal_code,
        country: person.country,
      });
      if (!line) continue;
      const result = await geocodeByAddress(line);
      if (result.ok) {
        await storeGeocode(q, result);
        await q.query("update persons set place_id = $2 where id = $1", [
          person.id,
          result.placeId,
        ]);
        summary.backfilled += 1;
      } else {
        summary.failed += 1;
      }
      await sleep(DELAY_MS);
    }
  }

  return summary;
}

/**
 * The Lambda entry point.
 *
 * Logs the summary rather than returning it anywhere useful, because nothing
 * reads the return value of a scheduled invocation -- CloudWatch is the only
 * place this run is ever looked at.
 */
export async function handler(event: RefreshEvent = {}): Promise<RefreshSummary> {
  const summary = await refreshGeocodes(db, event);
  console.log("Geocode refresh finished", summary);
  return summary;
}
