import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetPreferredProvider,
  isAppleMobile,
  linkTarget,
  mapsProvidersFor,
  mapsUrl,
  preferredProvider,
  rememberProvider,
} from "../src/lib/maps";

/*
 * Real user agents, because the interesting one is only interesting verbatim:
 * an iPad in its default desktop mode is byte-for-byte a Mac.
 */
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_MOBILE =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
/** iPadOS 13+ asking for the desktop site -- the same string as MAC. */
const IPAD_DESKTOP = MAC;
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ADDRESS = "4129 W Newport Ave, Chicago IL 60641";

describe("isAppleMobile", () => {
  it("recognises an iPhone, whichever browser is painting it", () => {
    expect(isAppleMobile(IPHONE, 5)).toBe(true);
    // Chrome on iOS is Safari underneath, and has the same two map apps.
    expect(isAppleMobile(IPHONE_CHROME, 5)).toBe(true);
  });

  it("recognises an iPad that still calls itself one", () => {
    expect(isAppleMobile(IPAD_MOBILE, 5)).toBe(true);
  });

  it("recognises an iPad that calls itself a Macintosh, by its touch points", () => {
    // The default since iPadOS 13. Nothing in the string distinguishes it.
    expect(isAppleMobile(IPAD_DESKTOP, 5)).toBe(true);
  });

  it("says no to a real Mac, which has the app but is a desk", () => {
    expect(isAppleMobile(MAC, 0)).toBe(false);
  });

  it('is not fooled by "like Mac OS X", which every iOS string contains', () => {
    // The test is for the device token. A phone with no touch reported would
    // otherwise fall through to the Macintosh branch and match on that phrase.
    expect(isAppleMobile(ANDROID, 5)).toBe(false);
    expect(isAppleMobile(WINDOWS, 0)).toBe(false);
  });
});

describe("mapsProvidersFor", () => {
  it("offers the app that is certainly installed first", () => {
    expect(mapsProvidersFor(IPHONE, 5)).toEqual(["apple", "google"]);
  });

  it("offers one destination off an Apple device, so no sheet is raised", () => {
    expect(mapsProvidersFor(ANDROID, 5)).toEqual(["google"]);
    expect(mapsProvidersFor(MAC, 0)).toEqual(["google"]);
  });
});

/*
 * Google's destination on an iPhone is a `comgooglemaps://` URL, which has no
 * page to render -- a new context would leave a blank tab beside the map app.
 * Dropping the tab was tried as the whole fix first and did not work; see
 * `mapsUrl`.
 */
describe("linkTarget", () => {
  it("opens Google in place on an iPhone, where there is no page to show", () => {
    expect(linkTarget("google", IPHONE, 5)).toBeUndefined();
    expect(linkTarget("google", IPHONE_CHROME, 5)).toBeUndefined();
    expect(linkTarget("google", IPAD_MOBILE, 5)).toBeUndefined();
    // The iPad that calls itself a Mac; only the touch count gives it away.
    expect(linkTarget("google", IPAD_DESKTOP, 5)).toBeUndefined();
  });

  it("leaves Apple Maps in a new tab, which was never the broken one", () => {
    // maps.apple.com is claimed by Maps.app even from inside a web view.
    expect(linkTarget("apple", IPHONE, 5)).toBe("_blank");
    expect(linkTarget("apple", IPAD_MOBILE, 5)).toBe("_blank");
  });

  it("keeps the new tab everywhere else", () => {
    // Android app links resolve from a new tab, and at a desk a tab is right.
    expect(linkTarget("google", ANDROID, 5)).toBe("_blank");
    expect(linkTarget("google", MAC, 0)).toBe("_blank");
    expect(linkTarget("google", WINDOWS, 0)).toBe("_blank");
  });
});

describe("mapsUrl", () => {
  it("builds https links off an Apple phone, which reach the app or a web map", () => {
    expect(mapsUrl("google", ADDRESS, ANDROID, 5)).toBe(
      "https://www.google.com/maps/search/?api=1&query=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
    expect(mapsUrl("google", ADDRESS, MAC, 0)).toBe(
      "https://www.google.com/maps/search/?api=1&query=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
  });

  it("sends Apple Maps to its universal link on every platform", () => {
    // It is claimed by Maps.app on an Apple device and a web map elsewhere, so
    // there is nothing for the platform to change.
    for (const agent of [IPHONE, IPAD_MOBILE, ANDROID, MAC, WINDOWS]) {
      expect(mapsUrl("apple", ADDRESS, agent, 5)).toBe(
        "https://maps.apple.com/?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
      );
    }
  });

  /*
   * Reported twice: an https link could not reach the Google Maps app on iOS
   * without loading a web map in an in-app browser first. A custom scheme is
   * the only thing the OS routes to an app whatever the context, at the price
   * of doing nothing when the app is absent.
   */
  it("sends Google to its own scheme on an iPhone, so iOS routes it to the app", () => {
    expect(mapsUrl("google", ADDRESS, IPHONE, 5)).toBe(
      "comgooglemaps://?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
    expect(mapsUrl("google", ADDRESS, IPHONE_CHROME, 5)).toBe(
      "comgooglemaps://?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
    expect(mapsUrl("google", ADDRESS, IPAD_MOBILE, 5)).toBe(
      "comgooglemaps://?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
    // The iPad that calls itself a Mac; only the touch count gives it away.
    expect(mapsUrl("google", ADDRESS, IPAD_DESKTOP, 5)).toBe(
      "comgooglemaps://?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641"
    );
  });

  it("escapes an address that would otherwise truncate the query", () => {
    // Unescaped, the `#` ends the URL and the `&` starts a second parameter.
    const url = mapsUrl("google", "Apt #3 & 4, Chicago IL", ANDROID, 5);
    expect(url).toContain("%233");
    expect(url).toContain("%26");
    expect(url.split("?")[1]).not.toContain("#");
  });

  it("escapes the scheme URL the same way, which carries the address bare", () => {
    const url = mapsUrl("google", "Apt #3 & 4, Chicago IL", IPHONE, 5);
    expect(url.startsWith("comgooglemaps://?q=")).toBe(true);
    expect(url).toContain("%233");
    expect(url).toContain("%26");
    expect(url.split("?")[1]).not.toContain("#");
  });
});

/*
 * There is no `localStorage` under test: Node 22 ships one of its own that is
 * unavailable without `--localstorage-file`, and it shadows jsdom's. That is
 * exactly the shape of the failure these functions already guard against, and
 * it is why `lib/api.ts` wraps its own access in a try/catch -- but it means a
 * suite that wants to watch a value round-trip has to supply the store.
 */
function fakeStorage(): void {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    },
  });
}

describe("the remembered provider", () => {
  beforeEach(fakeStorage);
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("round-trips, so somebody is only asked once", () => {
    expect(preferredProvider()).toBeNull();
    rememberProvider("apple");
    expect(preferredProvider()).toBe("apple");
    forgetPreferredProvider();
    expect(preferredProvider()).toBeNull();
  });

  it("ignores a value it did not write, rather than putting it in a URL", () => {
    localStorage.setItem("directory.mapsProvider", "waze");
    expect(preferredProvider()).toBeNull();
  });

  it("reads as no preference where there is no storage at all", () => {
    // Private browsing throws on access. One extra tap is the whole cost, so
    // there is nothing to report and nothing to crash.
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(preferredProvider()).toBeNull();
    expect(() => rememberProvider("google")).not.toThrow();
    expect(() => forgetPreferredProvider()).not.toThrow();
  });
});
