import { afterEach, describe, expect, it, vi } from "vitest";
import { isInstalled, pushAvailability, urlBase64ToUint8Array } from "../src/lib/push";

/**
 * The browser-side push helpers.
 *
 * Mostly about `pushAvailability`, because every one of its answers is a state
 * a real member lands in and none of them can be reached from a laptop running
 * the test suite. The iOS one especially: Web Push there works only in a PWA
 * added to the home screen, and getting that branch wrong means an iPhone user
 * sees a switch that silently does nothing.
 */

const originalNotification = globalThis.Notification;

/** Replaces `Notification` with one reporting the given permission. */
function withPermission(permission: NotificationPermission | null): void {
  if (permission === null) {
    // @ts-expect-error -- deleting a global to model a browser without it
    delete globalThis.Notification;
    return;
  }
  Object.defineProperty(globalThis, "Notification", {
    value: { permission, requestPermission: vi.fn() },
    configurable: true,
    writable: true,
  });
}

/** Models a browser with or without the two APIs push needs. */
function withSupport({
  serviceWorker,
  pushManager,
  standalone = false,
}: {
  serviceWorker: boolean;
  pushManager: boolean;
  standalone?: boolean;
}): void {
  if (serviceWorker) {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
  } else {
    // @ts-expect-error -- modelling a browser without it
    delete navigator.serviceWorker;
  }

  if (pushManager) {
    Object.defineProperty(window, "PushManager", { value: class {}, configurable: true });
  } else {
    // @ts-expect-error -- modelling a browser without it
    delete window.PushManager;
  }

  Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: standalone }) as never;
}

describe("urlBase64ToUint8Array", () => {
  it("decodes the base64url a VAPID key arrives as", () => {
    // "hello" with no padding needed.
    expect([...urlBase64ToUint8Array("aGVsbG8")]).toEqual([104, 101, 108, 108, 111]);
  });

  it("restores the padding atob insists on", () => {
    // Length 6 -> needs two "="; plain atob("aGVsbG8h".slice(0,6)) would throw.
    expect([...urlBase64ToUint8Array("aGVsbA")]).toEqual([104, 101, 108, 108]);
  });

  it("puts back the two substituted characters", () => {
    // base64url swaps + for - and / for _; the bytes below only decode
    // correctly if both are undone.
    const bytes = [...urlBase64ToUint8Array("-_-_")];
    expect(bytes).toEqual([...urlBase64ToUint8Array("+/+/")]);
    expect(bytes).toEqual([251, 255, 191]);
  });

  it("handles a real 65-byte VAPID key length without throwing", () => {
    const key = `B${"A".repeat(86)}`;
    expect(urlBase64ToUint8Array(key).length).toBe(65);
  });
});

describe("pushAvailability", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "Notification", {
      value: originalNotification,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("is not-configured when the deployment has no VAPID key", () => {
    withSupport({ serviceWorker: true, pushManager: true });
    withPermission("default");
    // Checked before browser support: telling somebody to install the app to
    // reach a feature the parish has not set up is a wasted trip.
    expect(pushAvailability(null)).toBe("not-configured");
  });

  it("is ready when everything is in place", () => {
    withSupport({ serviceWorker: true, pushManager: true });
    withPermission("default");
    expect(pushAvailability("key")).toBe("ready");
  });

  it("is still ready when permission was already granted", () => {
    withSupport({ serviceWorker: true, pushManager: true });
    withPermission("granted");
    expect(pushAvailability("key")).toBe("ready");
  });

  it("is denied once refused, because the page cannot ask again", () => {
    withSupport({ serviceWorker: true, pushManager: true });
    withPermission("denied");
    expect(pushAvailability("key")).toBe("denied");
  });

  it("is needs-install on iOS in a browser tab, where PushManager is absent", () => {
    withSupport({ serviceWorker: true, pushManager: false, standalone: false });
    withPermission("default");
    expect(pushAvailability("key")).toBe("needs-install");
  });

  it("is unsupported when it is installed and still cannot do push", () => {
    // Installing is then not the answer, so it must not be what we suggest.
    withSupport({ serviceWorker: true, pushManager: false, standalone: true });
    withPermission("default");
    expect(pushAvailability("key")).toBe("unsupported");
  });

  it("needs a service worker as well as a PushManager", () => {
    withSupport({ serviceWorker: false, pushManager: true, standalone: true });
    withPermission("default");
    expect(pushAvailability("key")).toBe("unsupported");
  });

  it("survives a browser with no Notification API at all", () => {
    withSupport({ serviceWorker: true, pushManager: true });
    withPermission(null);
    expect(() => pushAvailability("key")).not.toThrow();
  });
});

describe("isInstalled", () => {
  afterEach(() => vi.restoreAllMocks());

  it("trusts the display-mode media query", () => {
    withSupport({ serviceWorker: true, pushManager: true, standalone: true });
    expect(isInstalled()).toBe(true);
  });

  it("also trusts navigator.standalone, which is iOS's own and older", () => {
    withSupport({ serviceWorker: true, pushManager: true, standalone: false });
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(isInstalled()).toBe(true);
  });

  it("is false in an ordinary tab", () => {
    withSupport({ serviceWorker: true, pushManager: true, standalone: false });
    expect(isInstalled()).toBe(false);
  });
});
