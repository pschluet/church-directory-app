/**
 * Where a postal address goes when somebody taps it.
 *
 * The hard part is not the URLs, it is that a web page cannot ask the operating
 * system whether the Google Maps app is installed -- there is no API for it,
 * and the old trick of firing `comgooglemaps://` and watching for nothing to
 * happen cannot tell "not installed" from "installed and slow to switch". So
 * which maps to offer is decided by platform, and every URL is one that still
 * lands somewhere useful when the app it prefers is absent:
 *
 *   maps.apple.com  -- a universal link: opens Maps.app on an Apple platform,
 *                      renders a web map anywhere else. `maps://` fails hard
 *                      off an Apple device.
 *   google.com/maps -- opens the Google Maps app through its app link when it
 *                      is installed, and the web map when it is not.
 *                      `comgooglemaps://` silently does nothing when it is not.
 *
 * `geo:0,0?q=` was considered for Android, where it raises the OS's own chooser
 * across every installed map app. It was dropped: when nothing claims the
 * scheme the tap is a silent no-op the page cannot detect, and the https URL
 * already reaches the Google Maps app on the phones that have it.
 *
 * Nothing here touches `navigator` or React. The platform arrives as arguments
 * so the branches that a laptop never takes can still be tested on one.
 */

/** A map a member can be sent to. */
export type MapsProviderId = "apple" | "google";

export const MAPS_PROVIDERS: Record<MapsProviderId, { label: string }> = {
  apple: { label: "Apple Maps" },
  google: { label: "Google Maps" },
};

/**
 * Whether this is an iPhone or an iPad -- the devices where Apple Maps is
 * certainly installed and Google Maps might be, which is the only situation
 * with a genuine choice to offer.
 *
 * The touch points are not decoration. Since iPadOS 13 an iPad in its default
 * desktop mode sends a user agent identical to a Mac's, and they are the same
 * string down to the WebKit build; the touch count is the only thing left to
 * tell them apart, and no Mac reports any. Testing for the `Macintosh` token
 * rather than for "like Mac OS X" matters too -- that phrase is in every iOS
 * user agent and in none of the desktop ones.
 *
 * A Mac is deliberately excluded even though it ships Maps.app: at a desk the
 * address opens in a tab, and a sheet asking which map to use is a question
 * nobody standing in a parking lot would have been asked.
 */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * Which maps to offer, in the order they should be shown.
 *
 * Apple first where it exists, because it is the one certainly installed. One
 * entry means there is nothing to choose between and the address can be an
 * ordinary link -- a sheet offering a single option is a wasted tap.
 */
export function mapsProvidersFor(userAgent: string, maxTouchPoints: number): MapsProviderId[] {
  return isAppleMobile(userAgent, maxTouchPoints) ? ["apple", "google"] : ["google"];
}

export function mapsUrl(provider: MapsProviderId, address: string): string {
  // A search rather than an exact-address lookup, which is what a hand-typed
  // directory entry needs: Apple's `?address=` wants a well-formed address and
  // shows nothing at all when it does not get one.
  const query = encodeURIComponent(address);
  return provider === "apple"
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/**
 * The map somebody asked to keep using, if they ticked the box.
 *
 * Stored per browser the same way the active organization is, in localStorage
 * behind a try/catch -- see `lib/api.ts`. Private browsing throws on access,
 * and the consequence of failing to read it is one extra tap, so there is
 * nothing to report.
 */
const PROVIDER_KEY = "directory.mapsProvider";

export function preferredProvider(): MapsProviderId | null {
  try {
    const stored = localStorage.getItem(PROVIDER_KEY);
    // Validated rather than cast: a stale or hand-edited key should read as "no
    // preference", not be interpolated into a URL.
    return stored === "apple" || stored === "google" ? stored : null;
  } catch {
    return null;
  }
}

export function rememberProvider(provider: MapsProviderId): void {
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    // Private browsing; the sheet simply asks again next time.
  }
}

export function forgetPreferredProvider(): void {
  try {
    localStorage.removeItem(PROVIDER_KEY);
  } catch {
    // Nothing was stored to begin with.
  }
}
