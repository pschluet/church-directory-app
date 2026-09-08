import { closePool } from "../src/db";
import { isGeocodingConfigured } from "../src/services/geocoding";
import { handler } from "../src/refresh-geocodes";

/**
 * Geocode the addresses that have no pin yet.
 *
 * Switching Map View on for a parish populates nothing by itself: a parish with
 * it off was never geocoded, so its addresses arrive with no `place_id` and the
 * map opens correctly empty. This is what fills them in -- locally, and by
 * invoking the deployed function with `{"backfill": true}`.
 *
 * The same handler the daily EventBridge schedule runs, so there is one piece
 * of code that talks to Google about a batch of addresses. It only ever looks
 * at parishes with Map View on.
 *
 *   npm run geocode:backfill -w api
 *   npm run geocode:backfill -w api -- <organizationId>
 */
async function main(): Promise<void> {
  if (!isGeocodingConfigured()) {
    console.error(
      "Geocoding is not configured, so there is nothing this could do.\n" +
        "Put GOOGLE_MAPS_SERVER_KEY in api/.env (see api/.env.example), or pass it in the\n" +
        "environment. GEOCODING_MODE=local also switches it off deliberately."
    );
    process.exitCode = 1;
    return;
  }

  const organizationId = process.argv[2];
  const summary = await handler(
    organizationId ? { backfill: true, organizationId } : { backfill: true }
  );

  if (summary.failed > 0) {
    // Not a crash: an address Google cannot place is a normal outcome, and the
    // person keeps their address. Worth a non-zero exit so a script notices.
    console.error(
      `${summary.failed} address(es) could not be placed. Check them for typos, or try again ` +
        "later if Google was unreachable."
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
