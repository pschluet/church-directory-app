import type { Queryable } from "../db";
import { geocodeByAddress, geocodeByPlaceId, geocodeWarning } from "./geocoding";

/**
 * Turning an address into something the map can draw.
 *
 * One place, because persons and organizations both do it and the rules are
 * fiddly enough that two copies would diverge. The rules:
 *
 * - **A `place_id` already in `geocoded_addresses` costs nothing.** A family of
 *   five at one address sends the same id five times and Google is called once.
 *   This is the main reason coordinates live in their own table.
 * - **A client's `place_id` is never trusted as a coordinate.** It is a lookup
 *   key, and the coordinates come back from Google. A payload carrying its own
 *   latitude would let anybody put themselves on the church roof.
 * - **A failure returns null rather than throwing.** The address still saves;
 *   the caller gets a warning to show. Refusing the write would tell somebody
 *   their address is invalid when it is merely one Google cannot place, and
 *   there is no rephrasing of it that would be guaranteed to pass.
 * - **A `place_id` we could not resolve is dropped.** `persons.place_id` is a
 *   foreign key, so storing an id with no row behind it would fail the
 *   transaction rather than lose a pin.
 */

export interface ResolvedAddress {
  /** What to write to `place_id`. Null whenever there is no pin to point at. */
  placeId: string | null;
  /** What to tell the person who just saved. Null when nothing went wrong. */
  warning: string | null;
}

const NOTHING: ResolvedAddress = { placeId: null, warning: null };

export interface AddressToResolve {
  /** From Places Autocomplete, when the browser had it. */
  placeId: string | null;
  /** The address on one line, for a text lookup when there is no `place_id`. */
  text: string | null;
  /**
   * Whether this parish has Map View switched on.
   *
   * False short-circuits the whole function, which is the point of the switch:
   * a parish without a map makes no calls to Google at all, and nothing
   * accumulates in `geocoded_addresses` that nobody can see. Switching it on
   * later backfills.
   */
  mapViewEnabled: boolean;
}

export async function resolveAddress(
  q: Queryable,
  { placeId, text, mapViewEnabled }: AddressToResolve
): Promise<ResolvedAddress> {
  if (!mapViewEnabled) return NOTHING;
  if (!placeId && !text) return NOTHING;

  if (placeId) {
    const { rows } = await q.query<{ place_id: string }>(
      "select place_id from geocoded_addresses where place_id = $1 and latitude is not null",
      [placeId]
    );
    if (rows[0]) return { placeId: rows[0].place_id, warning: null };
  }

  const result = placeId ? await geocodeByPlaceId(placeId) : await geocodeByAddress(text as string);

  if (!result.ok) return { placeId: null, warning: geocodeWarning(result.reason) };

  /*
   * `on conflict` rather than a read-then-write: two members of the same family
   * saving at the same moment would both find nothing and both insert.
   * Refreshing the row on conflict is also how the scheduled job writes, so
   * there is one statement that puts coordinates in this table.
   */
  await q.query(
    `insert into geocoded_addresses (place_id, formatted_address, latitude, longitude, geocoded_at)
          values ($1, $2, $3, $4, now())
     on conflict (place_id) do update
            set formatted_address = excluded.formatted_address,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                geocoded_at = now()`,
    [result.placeId, result.formattedAddress, result.latitude, result.longitude]
  );

  return { placeId: result.placeId, warning: null };
}

/**
 * The six address columns as one line, which is what a text geocode wants.
 *
 * Deliberately the same shape as `formatSingleLineAddress` in the SPA
 * (app/src/lib/format.ts), so what gets geocoded is what the directory shows.
 * Duplicated rather than shared because that module is a React-facing formatter
 * and this is the only piece of it the API needs.
 */
export function addressToLine(address: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string | null {
  // No street line, no geocode. A city and a state on their own resolve to the
  // middle of the city, which is a pin that looks like it knew.
  if (!address.addressLine1?.trim()) return null;

  const locality = [address.city, address.state, address.postalCode]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return [address.addressLine1, address.addressLine2, locality, address.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Whether the parish this write belongs to has Map View switched on.
 *
 * Read per write rather than cached: it is a single indexed lookup by primary
 * key, and caching it in a Lambda that may live for minutes would keep
 * geocoding a parish for a while after a super admin switched it off.
 */
export async function mapViewEnabledFor(q: Queryable, organizationId: string): Promise<boolean> {
  const { rows } = await q.query<{ map_view_enabled: boolean }>(
    "select map_view_enabled from organizations where id = $1",
    [organizationId]
  );
  return rows[0]?.map_view_enabled ?? false;
}
