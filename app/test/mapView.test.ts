import { describe, expect, it } from "vitest";
import { boundsAround, centroid, initialView } from "../src/lib/mapView";

/**
 * The map's arithmetic, which is the part that can be wrong quietly.
 *
 * A box that is half again as wide as it is tall reads as "the zoom is off"
 * rather than as a missing `cos(latitude)`, and an Infinity handed to
 * `fitBounds` renders a grey square with nothing in the console.
 */

const CHICAGO = { latitude: 41.9445, longitude: -87.7325 };

describe("boundsAround", () => {
  it("spans about 60 miles from north to south", () => {
    const bounds = boundsAround(CHICAGO);
    const degrees = bounds.north - bounds.south;
    // 60 miles is 96.6km; at 111.132 km/degree that is 0.869 degrees.
    expect(degrees).toBeCloseTo(0.869, 2);
  });

  it("widens the longitude span to keep the box roughly square on the ground", () => {
    const bounds = boundsAround(CHICAGO);
    const latitudeSpan = bounds.north - bounds.south;
    const longitudeSpan = bounds.east - bounds.west;
    // cos(41.9) is about 0.744, so longitude degrees have to be ~1.34x wider.
    expect(longitudeSpan / latitudeSpan).toBeCloseTo(1 / Math.cos((41.9445 * Math.PI) / 180), 2);
  });

  it("is square in degrees at the equator, where the correction is nothing", () => {
    const bounds = boundsAround({ latitude: 0, longitude: 0 });
    expect(bounds.north - bounds.south).toBeCloseTo(bounds.east - bounds.west, 6);
  });

  it("honours a different radius", () => {
    const thirty = boundsAround(CHICAGO, 30);
    const sixty = boundsAround(CHICAGO, 60);
    expect(sixty.north - sixty.south).toBeCloseTo(2 * (thirty.north - thirty.south), 6);
  });

  it("stays finite at the pole", () => {
    // cos(90) is 0, so an unclamped span is Infinity -- a grey map with no error.
    const bounds = boundsAround({ latitude: 90, longitude: 0 });
    expect(Number.isFinite(bounds.east)).toBe(true);
    expect(Number.isFinite(bounds.west)).toBe(true);
  });

  it("does not run off the top of the world", () => {
    const bounds = boundsAround({ latitude: 89.8, longitude: 0 });
    expect(bounds.north).toBeLessThanOrEqual(90);
  });
});

describe("centroid", () => {
  it("has nothing to average when there is nobody", () => {
    expect(centroid([])).toBeNull();
  });

  it("returns the one point it was given", () => {
    expect(centroid([CHICAGO])).toEqual(CHICAGO);
  });

  it("averages the points it was given", () => {
    expect(
      centroid([
        { latitude: 40, longitude: -80 },
        { latitude: 42, longitude: -90 },
      ])
    ).toEqual({ latitude: 41, longitude: -85 });
  });
});

describe("initialView", () => {
  it("prefers the church", () => {
    expect(initialView(CHICAGO, [{ latitude: 10, longitude: 10 }])).toEqual({
      centre: CHICAGO,
      source: "church",
    });
  });

  it("falls back to the centroid of the parish", () => {
    const view = initialView(null, [
      { latitude: 40, longitude: -80 },
      { latitude: 42, longitude: -90 },
    ]);
    expect(view).toEqual({ centre: { latitude: 41, longitude: -85 }, source: "centroid" });
  });

  it("has nowhere to open with no church and nobody placed", () => {
    // Null so the page can say so. A {0, 0} default opens in the Atlantic,
    // which looks like a working map pointed at the wrong parish.
    expect(initialView(null, [])).toBeNull();
  });
});
