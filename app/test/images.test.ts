import { describe, expect, it } from "vitest";
import { RENDITION_LIMITS, clampCrop, fitWithin, renditionSize } from "../src/lib/images";

/**
 * The crop and resize arithmetic. jsdom has no canvas, so the drawing itself is
 * not testable here -- which is exactly why the maths lives apart from it.
 */

describe("fitWithin", () => {
  it("scales the long edge down to the limit and keeps the ratio", () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 800)).toEqual({ width: 800, height: 600 });
    expect(fitWithin({ width: 3000, height: 4000 }, 800)).toEqual({ width: 600, height: 800 });
  });

  it("never upscales", () => {
    // Interpolating a small photo up would cost bytes and add no detail.
    expect(fitWithin({ width: 200, height: 150 }, 800)).toEqual({ width: 200, height: 150 });
  });

  it("keeps a very wide crop at least one pixel tall", () => {
    expect(fitWithin({ width: 5000, height: 3 }, 320).height).toBeGreaterThanOrEqual(1);
  });

  it("rounds to whole pixels", () => {
    const out = fitWithin({ width: 1001, height: 667 }, 320);
    expect(Number.isInteger(out.width)).toBe(true);
    expect(Number.isInteger(out.height)).toBe(true);
  });
});

describe("clampCrop", () => {
  const source = { width: 1000, height: 800 };

  it("leaves a crop inside the image alone", () => {
    expect(clampCrop({ x: 100, y: 50, width: 400, height: 300 }, source)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it("pulls a crop dragged past the edge back inside", () => {
    // react-image-crop reports against the rendered <img>, so a rounded scale
    // factor can put the rectangle a pixel or two outside the source. Drawing
    // that leaves a transparent sliver down one side.
    expect(clampCrop({ x: 900, y: 700, width: 400, height: 300 }, source)).toEqual({
      x: 600,
      y: 500,
      width: 400,
      height: 300,
    });
  });

  it("caps a crop larger than the image", () => {
    expect(clampCrop({ x: 0, y: 0, width: 5000, height: 5000 }, source)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800,
    });
  });

  it("refuses to produce a zero-sized crop", () => {
    const out = clampCrop({ x: 0, y: 0, width: 0.2, height: 0.2 }, source);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });
});

describe("renditionSize", () => {
  it("gives a person a thumbnail sharp at the largest avatar on a 2x screen", () => {
    // Avatar's `lg` is 144 CSS px, so 320 covers it with headroom.
    expect(RENDITION_LIMITS.person.thumb).toBeGreaterThanOrEqual(144 * 2);
    expect(renditionSize({ width: 3000, height: 3000 }, "person", "thumb")).toEqual({
      width: 320,
      height: 320,
    });
  });

  it("keeps a family's free-form ratio in both renditions", () => {
    const crop = { width: 3000, height: 2000 };
    const thumb = renditionSize(crop, "family", "thumb");
    const full = renditionSize(crop, "family", "full");
    expect(thumb.width / thumb.height).toBeCloseTo(1.5, 2);
    expect(full.width / full.height).toBeCloseTo(1.5, 2);
    expect(full.width).toBe(1600);
    expect(thumb.width).toBe(800);
  });

  it("makes the thumbnail smaller than the full rendition for both owners", () => {
    for (const owner of ["person", "family"] as const) {
      expect(RENDITION_LIMITS[owner].thumb).toBeLessThan(RENDITION_LIMITS[owner].full);
    }
  });

  it("shrinks a directory thumbnail far below the 5MB original it replaces", () => {
    // The point of the whole change: a card renders at 56px and used to
    // download the untouched file.
    const out = renditionSize({ width: 4032, height: 3024 }, "person", "thumb");
    expect(Math.max(out.width, out.height)).toBe(320);
  });
});
