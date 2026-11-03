import { describe, expect, it } from "vitest";
import { detectPlatform } from "../src/lib/platform";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_MODE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAMSUNG_INTERNET =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const MAC_DESKTOP = IPADOS_DESKTOP_MODE;
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("detectPlatform", () => {
  it("recognises an iPhone in Safari and in Chrome", () => {
    expect(detectPlatform(IPHONE_SAFARI)).toBe("ios");
    expect(detectPlatform(IPHONE_CHROME)).toBe("ios");
  });

  it("recognises Android in Chrome and Samsung Internet", () => {
    expect(detectPlatform(ANDROID_CHROME)).toBe("android");
    expect(detectPlatform(SAMSUNG_INTERNET)).toBe("android");
  });

  it("takes an iPad reporting itself as a Mac, because a Mac has no touch screen", () => {
    expect(detectPlatform(IPADOS_DESKTOP_MODE, 5)).toBe("ios");
  });

  it("suggests nothing on a desktop", () => {
    expect(detectPlatform(MAC_DESKTOP, 0)).toBeNull();
    expect(detectPlatform(MAC_DESKTOP)).toBeNull();
    expect(detectPlatform(WINDOWS_CHROME)).toBeNull();
    expect(detectPlatform("")).toBeNull();
  });
});
