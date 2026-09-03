// @vitest-environment node
//
// Overrides the jsdom default in vitest.config.ts: this file reads the build
// output off disk and touches no DOM, and under jsdom `import.meta.url` is an
// http URL that node:fs will not take.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Assertions about the generated service worker, not about any module in src/.
 *
 * The risk this covers is entirely in the build output: a plausible-looking
 * `runtimeCaching` entry added to vite.config.ts would put the parish's phone
 * numbers, addresses and everyone's face into the Cache API on disk, which is
 * the exposure lib/queryClient.ts refuses a localStorage persister to avoid.
 * Nothing in the app would look different, and no existing test would fail.
 *
 * A jsdom test could not see it: jsdom has neither `caches` nor
 * `navigator.serviceWorker`, so it would only ever assert against its own
 * mocks. So this reads dist/sw.js, and needs `npm run build:app` to have run --
 * CI builds before it tests for this reason. Locally it skips instead, the way
 * the API suites skip when Postgres is not up, so `npm test` still works.
 */
const SW = new URL("../dist/sw.js", import.meta.url);
const MANIFEST = new URL("../dist/manifest.webmanifest", import.meta.url);
const built = existsSync(SW);

if (!built) {
  console.warn(
    "app/dist/sw.js is missing — run `npm run build:app`; service worker tests will skip."
  );
}

describe.skipIf(!built)("the generated service worker", () => {
  const sw = readFileSync(SW, "utf8");
  // Workbox minifies the precache manifest, so the keys are unquoted.
  const precached = [...sw.matchAll(/url:"([^"]+)"/g)].flatMap(([, url]) => (url ? [url] : []));

  it("never precaches the API or anyone's photo", () => {
    expect(precached).not.toHaveLength(0);
    const personal = precached.filter(
      (url) =>
        url.startsWith("api/") ||
        url.startsWith("/api/") ||
        url.startsWith("photos/") ||
        url.startsWith("/photos/")
    );
    expect(personal).toEqual([]);
  });

  it("has no route that would cache the API or photos at runtime", () => {
    /*
     * The two prefixes may appear only in the navigation denylist. Strip that
     * and nothing should be left matching them: any other mention means
     * something is routing them, a `runtimeCaching` entry most likely, and a
     * cached /api/me would keep serving a CloudFront photo cookie long after
     * the real one expired.
     */
    const denylist = String.raw`denylist:[/^\/api\//,/^\/photos\//]`;
    expect(sw).toContain(denylist);
    const rest = sw.replace(denylist, "");
    expect(rest).not.toMatch(/api/);
    expect(rest).not.toMatch(/photos/);
  });

  it("precaches the shell, so a config change cannot silently cache nothing", () => {
    expect(precached).toContain("index.html");
    expect(precached.some((url) => /^assets\/index-.+\.js$/.test(url))).toBe(true);
    expect(precached.some((url) => /^assets\/index-.+\.css$/.test(url))).toBe(true);
  });

  it("precaches woff2 but not the woff duplicates nobody requests", () => {
    // @fontsource ships both formats for every face; precaching the pair costs
    // 96KB of downloads that no browser able to run this app would make.
    expect(precached.some((url) => url.endsWith(".woff2"))).toBe(true);
    expect(precached.filter((url) => url.endsWith(".woff"))).toEqual([]);
  });

  it("is installable: standalone, scoped to the whole app, with a maskable icon", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/");
    // Never "portrait": Android enforces a manifest orientation lock on an
    // installed app, so a tablet would refuse to rotate. iOS ignores the
    // field, so this cannot be caught by testing on an iPhone.
    expect(manifest.orientation).toBe("any");
    // Android masks every icon; without a maskable one it crops whatever it
    // is given, which for an edge-to-edge cross means clipping the bars.
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(
      true
    );
  });
});
