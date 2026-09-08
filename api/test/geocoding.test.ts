import { afterEach, describe, expect, it, vi } from "vitest";
import { classify, geocodeWarning, isGeocodingConfigured } from "../src/services/geocoding";

/**
 * The classifier, which is the part of geocoding worth testing.
 *
 * `classify` is exported separately from the request so these cases need no
 * `fetch` stub and no network: what they are about is Google's habit of
 * answering `OK` to a question it could not really answer. Half an address
 * comes back as the middle of a city with `partial_match` set, which is a 200,
 * a valid pair of coordinates, and a pin in the wrong place.
 *
 * The module runs under GEOCODING_MODE=local (see api/vitest.config.mts), so
 * `isGeocodingConfigured` is false here -- asserted, because that is what keeps
 * the rest of the suite off the network.
 */

const ROOFTOP = {
  status: "OK",
  results: [
    {
      place_id: "ChIJnewport",
      formatted_address: "4129 W Newport Ave, Chicago, IL 60641, USA",
      types: ["street_address"],
      geometry: { location: { lat: 41.9445, lng: -87.7325 }, location_type: "ROOFTOP" },
    },
  ],
};

describe("geocoding", () => {
  it("does not call Google when the mode is local", () => {
    expect(isGeocodingConfigured()).toBe(false);
  });

  it("accepts a rooftop result", () => {
    expect(classify(ROOFTOP)).toEqual({
      ok: true,
      placeId: "ChIJnewport",
      formattedAddress: "4129 W Newport Ave, Chicago, IL 60641, USA",
      latitude: 41.9445,
      longitude: -87.7325,
    });
  });

  it("accepts an interpolated result, which is a point along a known range", () => {
    const result = classify({
      ...ROOFTOP,
      results: [
        {
          ...ROOFTOP.results[0]!,
          types: ["premise"],
          geometry: { ...ROOFTOP.results[0]!.geometry, location_type: "RANGE_INTERPOLATED" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("reports no match when Google has never heard of the address", () => {
    expect(classify({ status: "ZERO_RESULTS", results: [] })).toEqual({
      ok: false,
      reason: "no_match",
    });
  });

  it("rejects a partial match, which is a successful response and a useless pin", () => {
    const result = classify({
      ...ROOFTOP,
      results: [{ ...ROOFTOP.results[0]!, partial_match: true }],
    });
    expect(result).toEqual({ ok: false, reason: "imprecise" });
  });

  it("rejects the centre of a postcode", () => {
    const result = classify({
      status: "OK",
      results: [
        {
          place_id: "ChIJzip",
          formatted_address: "Chicago, IL 60641, USA",
          types: ["postal_code"],
          geometry: { location: { lat: 41.94, lng: -87.73 }, location_type: "APPROXIMATE" },
        },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "imprecise" });
  });

  it("accepts an approximate fix for something that is still a building", () => {
    // Google holds plenty of real addresses without a rooftop fix. The types
    // are what make it a house rather than a neighbourhood.
    const result = classify({
      status: "OK",
      results: [
        {
          place_id: "ChIJapprox",
          formatted_address: "12 Some Ave, Chicago, IL, USA",
          types: ["subpremise"],
          geometry: { location: { lat: 41.9, lng: -87.7 }, location_type: "APPROXIMATE" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("treats a quota or server error as unavailable rather than as a bad address", () => {
    expect(classify({ status: "OVER_QUERY_LIMIT", results: [] })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(classify({ status: "REQUEST_DENIED" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports no match when the payload is OK but unusable", () => {
    // An OK with no results, or a result with no coordinates, has happened.
    expect(classify({ status: "OK", results: [] })).toEqual({ ok: false, reason: "no_match" });
    expect(
      classify({ status: "OK", results: [{ place_id: "x", geometry: { location: {} } }] })
    ).toEqual({ ok: false, reason: "no_match" });
  });

  it("says nothing to the user when geocoding was never configured", () => {
    // Nothing was expected to work, so there is nothing to report.
    expect(geocodeWarning("not_configured")).toBeNull();
  });

  it("gives every real failure something to show", () => {
    for (const reason of ["no_match", "imprecise", "unavailable"] as const) {
      expect(geocodeWarning(reason)).toContain("saved");
    }
  });
});

/**
 * What the browser is handed.
 *
 * Re-imported per case with the environment stubbed, because the module reads
 * `process.env` once at load -- the same reason `api/vitest.config.mts` sets
 * the modes there rather than in a `.env`.
 */
describe("browser map configuration", () => {
  async function load(env: Record<string, string>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return import("../src/services/geocoding");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("hands over the key and the map id together", async () => {
    const { mapsBrowserConfig } = await load({
      GEOCODING_MODE: "google",
      GOOGLE_MAPS_BROWSER_KEY: "browser-key",
    });
    const config = mapsBrowserConfig();
    expect(config.key).toBe("browser-key");
    // A constant rather than configuration: it names a style, grants nothing,
    // and is already sent to every signed-in browser. Asserted as non-empty
    // rather than by value, so restyling does not have to edit a test -- but
    // asserted at all, because Advanced Markers render nothing without one.
    expect(config.mapId).toBeTruthy();
  });

  it("hands over neither when there is no browser key", async () => {
    // The caller reads a null key as "no map here", so handing back a Map ID
    // beside it would be offering half of something that cannot work.
    const { mapsBrowserConfig } = await load({
      GEOCODING_MODE: "google",
      GOOGLE_MAPS_BROWSER_KEY: "",
    });
    expect(mapsBrowserConfig()).toEqual({ key: null, mapId: null });
  });

  it("hands over nothing in local mode even with a key set", async () => {
    const { mapsBrowserConfig } = await load({
      GEOCODING_MODE: "local",
      GOOGLE_MAPS_BROWSER_KEY: "browser-key",
    });
    expect(mapsBrowserConfig()).toEqual({ key: null, mapId: null });
  });

  it("refuses to start with a browser key and no server key", async () => {
    // A map that loads and never places anybody on it is worse than no map:
    // every address saves without a pin and nothing says why.
    const { assertGeocodingConfig } = await load({
      GEOCODING_MODE: "google",
      GOOGLE_MAPS_BROWSER_KEY: "browser-key",
      GOOGLE_MAPS_SERVER_KEY: "",
    });
    expect(() => assertGeocodingConfig()).toThrow(/half-configured/);
  });

  it("starts happily with nothing configured at all", async () => {
    const { assertGeocodingConfig } = await load({
      GEOCODING_MODE: "google",
      GOOGLE_MAPS_BROWSER_KEY: "",
      GOOGLE_MAPS_SERVER_KEY: "",
    });
    expect(() => assertGeocodingConfig()).not.toThrow();
  });
});
