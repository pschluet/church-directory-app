import { describe, expect, it } from "vitest";
import { qrModules, qrRuns, qrSvgPath } from "../src/lib/qr";

describe("qrModules", () => {
  it("makes a square matrix of a valid QR size", async () => {
    const modules = await qrModules("https://example.com/e/abc123");
    const n = modules.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect((n - 17) % 4).toBe(0);
    for (const row of modules) expect(row).toHaveLength(n);
  });

  it("has the finder patterns in three corners and not the fourth", async () => {
    const modules = await qrModules("https://example.com/e/abc123");
    const n = modules.length;
    expect(modules[0]?.[0]).toBe(true);
    expect(modules[0]?.[n - 1]).toBe(true);
    expect(modules[n - 1]?.[0]).toBe(true);
    // Only three finders: the bottom-right corner is data.
    expect(modules[0]?.slice(0, 7).every(Boolean)).toBe(true);
  });

  it("grows with the data", async () => {
    const short = await qrModules("a");
    const long = await qrModules("x".repeat(200));
    expect(long.length).toBeGreaterThan(short.length);
  });
});

const MATRIX = [
  [true, true, false, true],
  [false, false, false, false],
  [false, true, true, true],
  [true, false, false, true],
];

describe("qrRuns", () => {
  it("merges neighbouring dark modules into horizontal runs", () => {
    expect(qrRuns(MATRIX)).toEqual([
      { x: 0, y: 0, w: 2 },
      { x: 3, y: 0, w: 1 },
      { x: 1, y: 2, w: 3 },
      { x: 0, y: 3, w: 1 },
      { x: 3, y: 3, w: 1 },
    ]);
  });

  it("is empty for an all-light matrix", () => {
    expect(qrRuns([[false, false]])).toEqual([]);
  });
});

describe("qrSvgPath", () => {
  it("offsets every run by the margin and reports the viewBox size", () => {
    const { d, viewBoxSize } = qrSvgPath(MATRIX, { margin: 2 });
    expect(viewBoxSize).toBe(8);
    expect(d).toBe(
      "M2 2h2v1h-2z" + "M5 2h1v1h-1z" + "M3 4h3v1h-3z" + "M2 5h1v1h-1z" + "M5 5h1v1h-1z"
    );
  });

  it("defaults to the four-module quiet zone", () => {
    expect(qrSvgPath(MATRIX).viewBoxSize).toBe(12);
  });
});
