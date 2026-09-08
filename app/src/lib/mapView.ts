/**
 * Where the map opens, as arithmetic.
 *
 * Separated from the page for the reason `lib/maps.ts` is: none of this needs a
 * map, a browser or a Google script to be right, and all of it is the kind of
 * thing that is wrong by a factor of `cos(latitude)` until something checks.
 *
 * The requirement is "centered on the church and show approximately a 30 mile
 * radius around the church", falling back to "the centroid of all parishioners"
 * when no church address is saved.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** The radius the map opens at, from the requirement. */
export const DEFAULT_RADIUS_MILES = 30;

const KM_PER_MILE = 1.609_344;

/**
 * Kilometres per degree of latitude.
 *
 * Constant enough: the real figure varies from about 110.57 at the equator to
 * 111.69 at the poles, which at 30 miles is a couple of hundred metres of
 * initial zoom. "Approximately a 30 mile radius" has more slack than that.
 */
const KM_PER_DEGREE_LATITUDE = 111.132;

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * A box around a point, `radiusMiles` from centre to edge.
 *
 * A box rather than a circle because `fitBounds` takes one, and the map is
 * rectangular: a circle would have to be inscribed in a box anyway, and
 * inscribing it the other way would show less than asked for.
 *
 * Longitude degrees narrow as you leave the equator, hence the `cos`. Without
 * it a parish in Chicago opens on a box half again as wide as it is tall, which
 * looks like the zoom is simply wrong rather than like a units bug.
 */
export function boundsAround(centre: LatLng, radiusMiles = DEFAULT_RADIUS_MILES): Bounds {
  const km = radiusMiles * KM_PER_MILE;
  const latitudeSpan = km / KM_PER_DEGREE_LATITUDE;

  /*
   * Clamped away from the poles. At a latitude of exactly 90 the cosine is zero
   * and the longitude span is infinite; there is no parish there, but an
   * Infinity handed to `fitBounds` renders an empty grey map with nothing in
   * the console to explain it.
   */
  const clampedLatitude = Math.min(Math.abs(centre.latitude), 89.9);
  const longitudeSpan = latitudeSpan / Math.max(Math.cos((clampedLatitude * Math.PI) / 180), 0.01);

  return {
    north: Math.min(centre.latitude + latitudeSpan, 90),
    south: Math.max(centre.latitude - latitudeSpan, -90),
    east: centre.longitude + longitudeSpan,
    west: centre.longitude - longitudeSpan,
  };
}

/**
 * The average of every pin.
 *
 * A plain mean, which is wrong across the antimeridian and right for every
 * parish that has one. Weighted by address rather than by person, because the
 * caller passes locations: a family of seven should not drag the map onto their
 * house.
 */
export function centroid(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const total = points.reduce(
    (acc, p) => ({ latitude: acc.latitude + p.latitude, longitude: acc.longitude + p.longitude }),
    { latitude: 0, longitude: 0 }
  );
  return {
    latitude: total.latitude / points.length,
    longitude: total.longitude / points.length,
  };
}

/**
 * Where to open, and whether that is the church or a guess.
 *
 * Three cases, and the third is the one worth naming: a parish with no church
 * address and nobody placed yet has nothing to centre on at all. Returning null
 * lets the page say so rather than opening in the middle of the Atlantic, which
 * is where a `{0, 0}` default lands.
 */
export function initialView(
  church: LatLng | null,
  locations: LatLng[]
): { centre: LatLng; source: "church" | "centroid" } | null {
  if (church) return { centre: church, source: "church" };
  const middle = centroid(locations);
  return middle ? { centre: middle, source: "centroid" } : null;
}
