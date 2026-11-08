/**
 * The number on the app's home-screen icon.
 *
 * iOS (16.4+) only ever badges an installed web app's icon through the Badging
 * API -- a notification arriving does not do it by itself. The service worker
 * sets it when a push lands (see `setIconBadge` in app/src/sw.ts); this is the
 * page's half, which keeps it in step with the bell while the app is open, and
 * is what clears it once the member has read everything.
 *
 * Every failure is swallowed. The API is missing in most desktop browsers and
 * in an ordinary Safari tab, and it rejects when notification permission has
 * not been granted -- none of which is worth telling the member about.
 */

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function syncAppBadge(count: number): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as BadgingNavigator;
  try {
    const pending = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    pending?.catch(() => undefined);
  } catch {
    // Some engines throw synchronously instead of rejecting.
  }
}
