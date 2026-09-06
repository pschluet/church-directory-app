/**
 * Web Push, from the browser's side.
 *
 * Separated from the settings page because almost none of this is UI, and the
 * branches that matter are the ones a laptop never takes. In particular:
 *
 * **iOS only delivers Web Push to a PWA installed on the home screen.** In an
 * ordinary Safari tab `window.PushManager` does not exist, so a toggle rendered
 * there would simply fail. That is not something to swallow -- it is the single
 * most likely reason a member cannot turn notifications on, and the app has to
 * be able to say "add Directory to your home screen first" rather than showing
 * a switch that does nothing.
 *
 * **Permission must be asked for from a user gesture**, so nothing here runs on
 * page load; `subscribeThisDevice` is called from the switch's own handler.
 *
 * **Once denied, permission cannot be asked for again** from the page. The only
 * way back is the operating system's own settings, which is why "denied" is a
 * state with its own message rather than an error.
 */

/** Why the switch is, or is not, usable. */
export type PushAvailability =
  /** Can be turned on. */
  | "ready"
  /** Refused, and only the OS can undo it. */
  | "denied"
  /** iOS in a browser tab: works, but only once added to the home screen. */
  | "needs-install"
  /** No service worker or no PushManager, even installed. */
  | "unsupported"
  /** This deployment has no VAPID keypair, so there is nothing to subscribe to. */
  | "not-configured";

/** Whether the app is running as an installed PWA rather than in a tab. */
export function isInstalled(): boolean {
  // `navigator.standalone` is the iOS one, and it predates and is not covered
  // by the display-mode media query.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

export function pushAvailability(publicKey: string | null): PushAvailability {
  // First, because it is the one nothing the member does can change. Telling
  // somebody to install the app to reach a feature the parish has not set up
  // would be a wasted trip.
  if (!publicKey) return "not-configured";

  const supported = "serviceWorker" in navigator && "PushManager" in window;
  if (!supported) return isInstalled() ? "unsupported" : "needs-install";

  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    return "denied";
  }
  return "ready";
}

/**
 * The VAPID public key, as the browser wants it.
 *
 * It is served as base64url (that is what the Web Push spec and every tool
 * emits), and `applicationServerKey` takes bytes. The padding and the two
 * substituted characters both have to be undone -- `atob` rejects base64url as
 * it stands.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** This browser's existing subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * The same answer, but without waiting for a worker to become ready.
 *
 * `currentSubscription` awaits `navigator.serviceWorker.ready`, which does not
 * resolve at all when no worker is registered -- in dev, where none is, and in
 * any browser where registration failed. On the settings page that costs a
 * spinner and nothing else. On the sign-out path it would hang signing out, and
 * on every page load it would leave a promise pending for the life of the tab,
 * so both of those callers use this instead: `getRegistration()` answers
 * immediately, with undefined when there is nothing registered yet.
 *
 * The cost is that a caller running before registration completes sees null
 * rather than waiting for it. Both callers are safe to be wrong that way -- the
 * next load tries again.
 */
export async function registeredSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Asks permission and subscribes. Must be called from a user gesture.
 *
 * `userVisibleOnly: true` is not a choice -- Chrome requires it, and a push
 * that shows no notification is what gets a subscription revoked. The worker's
 * `push` listener therefore always shows one; see app/src/sw.ts.
 *
 * Returns null when the member declines, which is a normal outcome and not an
 * error worth showing as one.
 */
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscription | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const registration = await navigator.serviceWorker.ready;
  // Re-used if it already exists; `subscribe` is idempotent for the same
  // application server key, which is why the server side is an upsert.
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
}
