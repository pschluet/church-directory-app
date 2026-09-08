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

  if (summary.unplaceable > 0) {
    // Not a crash: the person keeps their address and simply has no pin. The
    // ids are in the log above, so say what to do with them.
    console.error(
      `${summary.unplaceable} address(es) could not be placed at all. Check them for typos, or ` +
        "re-enter them using the address suggestions -- see the warnings above for which."
    );
  }
  if (summary.failed > 0) {
    // Deliberately a different sentence: this one needs no action.
    console.error(
      `${summary.failed} address(es) were deferred because Google could not be reached. The ` +
        "daily run will pick them up; nothing is wrong with the addresses."
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
