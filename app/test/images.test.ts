import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  MAX_WORKING_PIXELS,
  RENDITION_LIMITS,
  clampCrop,
  fitWithin,
  fitWithinPixels,
  renditionSize,
} from "../src/lib/images";

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

describe("fitWithinPixels", () => {
  it("leaves an image already inside the budget alone", () => {
    expect(fitWithinPixels({ width: 2000, height: 1500 }, 8_000_000)).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it("scales down to the budget and keeps the ratio", () => {
    const out = fitWithinPixels({ width: 8064, height: 6048 }, 8_000_000);
    expect(out.width * out.height).toBeLessThanOrEqual(8_000_000);
    expect(out.width / out.height).toBeCloseTo(8064 / 6048, 2);
  });

  it("never rounds back over the budget", () => {
    // Rounding up on both axes could put the area past the cap, which for the
    // working copy means past the canvas limit it was chosen to stay under.
    for (const size of [
      { width: 4001, height: 3001 },
      { width: 5177, height: 3451 },
      { width: 9999, height: 9999 },
    ]) {
      const out = fitWithinPixels(size, 8_000_000);
      expect(out.width * out.height).toBeLessThanOrEqual(8_000_000);
    }
  });

  it("caps by area, not by long edge, so a panorama keeps its detail", () => {
    // 12000x1000 is 12MP but only 1000 tall. Capping the long edge would shrink
    // it far more than memory requires.
    const out = fitWithinPixels({ width: 12000, height: 1000 }, 8_000_000);
    expect(out.width).toBeGreaterThan(8000);
    expect(out.width * out.height).toBeLessThanOrEqual(8_000_000);
  });

  it("keeps an extreme panorama at least one pixel tall", () => {
    const out = fitWithinPixels({ width: 20000, height: 2 }, 8_000_000);
    expect(out.height).toBeGreaterThanOrEqual(1);
    expect(out.width).toBeGreaterThanOrEqual(1);
  });

  it("never upscales", () => {
    expect(fitWithinPixels({ width: 400, height: 300 }, 8_000_000)).toEqual({
      width: 400,
      height: 300,
    });
  });
});

describe("the working copy budget", () => {
  it("stays under the canvas size iOS Safari fails on", () => {
    // The assertion this file exists for. Above MAX_CANVAS_PIXELS, iOS Safari
    // returns a blank canvas rather than throwing, so the photo saves black with
    // no error -- and Chrome does not enforce the limit, so raising the working
    // budget past it would pass every other check here and in the browser.
    expect(MAX_WORKING_PIXELS).toBeLessThan(MAX_CANVAS_PIXELS);
  });

  it("keeps every realistic phone photo under that limit once downscaled", () => {
    const sources = [
      { label: "12MP iPhone", width: 4032, height: 3024 },
      { label: "48MP iPhone", width: 8064, height: 6048 },
      { label: "108MP Android", width: 12032, height: 9024 },
      { label: "panorama", width: 12000, height: 1000 },
      { label: "square scan", width: 10000, height: 10000 },
    ];
    for (const source of sources) {
      const out = fitWithinPixels(source, MAX_WORKING_PIXELS);
      expect(out.width * out.height, source.label).toBeLessThan(MAX_CANVAS_PIXELS);
    }
  });

  it("is large enough that a full-frame crop still fills the biggest rendition", () => {
    // Why 8MP rather than something smaller: the family `full` rendition is
    // 1600px, and a working copy has to be able to feed it.
    const working = fitWithinPixels({ width: 8064, height: 5376 }, MAX_WORKING_PIXELS);
    const full = renditionSize(working, "family", "full");
    expect(full.width).toBe(RENDITION_LIMITS.family.full);
  });

  it("still fills the biggest rendition from a crop of about half the frame", () => {
    const working = fitWithinPixels({ width: 8064, height: 5376 }, MAX_WORKING_PIXELS);
    const halfCrop = {
      width: Math.round(working.width / 2),
      height: Math.round(working.height / 2),
    };
    const full = renditionSize(halfCrop, "family", "full");
    // ~1732px wide at half of a 3:2 8MP working copy, so the 1600px target is met.
    expect(full.width).toBe(RENDITION_LIMITS.family.full);
  });
});
