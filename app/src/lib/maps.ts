/**
 * Where a postal address goes when somebody taps it.
 *
 * The hard part is not the URLs, it is that a web page cannot ask the operating
 * system whether the Google Maps app is installed -- there is no API for it,
 * and firing `comgooglemaps://` to watch for nothing happening cannot tell
 * "not installed" from "installed and slow to switch". So which maps to offer
 * is decided by platform:
 *
 *   maps.apple.com  -- a universal link: opens Maps.app on an Apple platform,
 *                      renders a web map anywhere else. `maps://` fails hard
 *                      off an Apple device.
 *   google.com/maps -- opens the Google Maps app through its app link when it
 *                      is installed, and the web map when it is not.
 *   comgooglemaps:// -- opens the Google Maps app directly, and does nothing at
 *                      all when it is absent. Used on an iPhone or iPad only,
 *                      and only because nothing else got there; see `mapsUrl`.
 *
 * Every URL here used to be an https one, so that a tap finding no app still
 * landed on a web map rather than doing nothing. That held everywhere except
 * the one platform with two map apps to choose between, where an https link
 * could not reach the Google Maps app without going through a browser first.
 * `geo:0,0?q=` is still not used on Android, where the https link does reach
 * the app and a scheme nothing claims would be a silent no-op.
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

/**
 * Whether a provider's link may open a new browsing context.
 *
 * Everything opens in a new tab, so that a member who lands on a web map still
 * has the directory behind it, except Google Maps on an iPhone or iPad -- where
 * `mapsUrl` hands back a `comgooglemaps://` URL. A custom scheme has no page to
 * render, so a new context would be a blank tab left over beside the map app.
 *
 * This started life as the whole fix, on the theory that iOS was refusing to
 * hand a universal link to an app because the tap opened a new context. It was
 * not: dropping the tab alone changed nothing, which is what sent `mapsUrl` to
 * a custom scheme. It stays because it is right for a scheme, not because it
 * was right about universal links.
 *
 * Apple Maps keeps its tab and never had the problem: `maps.apple.com` is
 * special-cased by iOS below universal-link handling, so Maps.app claims it
 * even from inside a web view.
 *
 * Returns the attribute value rather than a boolean so a caller can hand it
 * straight to `target`, which React omits entirely when it is `undefined`.
 */
export function linkTarget(
  provider: MapsProviderId,
  userAgent: string,
  maxTouchPoints: number
): "_blank" | undefined {
  const inPlace = provider === "google" && isAppleMobile(userAgent, maxTouchPoints);
  return inPlace ? undefined : "_blank";
}

/**
 * Where the tap goes.
 *
 * Google Maps on an iPhone or iPad gets `comgooglemaps://`, which is a reversal
 * worth explaining because the https-only rule it breaks was deliberate. On
 * that platform the https link could not reach the app without a browser in
 * between: an installed copy of this app runs standalone, and the in-app web
 * view it opens links in loads a universal link itself rather than handing it
 * over, so the web map appeared and then bounced into the app. Opening it in
 * place instead of a new tab was tried first and was not enough -- iOS declined
 * to hand the link over either way. A custom scheme is the only thing the OS
 * routes to an app regardless of the context it was tapped in.
 *
 * The cost, accepted knowingly: a tap with Google Maps not installed does
 * nothing at all, where before it would have shown a web map. It buys the
 * behaviour Apple Maps has always had, and someone choosing Google Maps from a
 * sheet on an iPhone is telling us they have it. There is no fallback because
 * there is no reliable one -- a timer cannot tell a missing app from a slow
 * switch, which is the same wall this module started at.
 *
 * Everywhere else keeps the https URL, which already reaches the app on Android
 * and is the only sensible thing at a desk.
 */
export function mapsUrl(
  provider: MapsProviderId,
  address: string,
  userAgent: string,
  maxTouchPoints: number
): string {
  // A search rather than an exact-address lookup, which is what a hand-typed
  // directory entry needs: Apple's `?address=` wants a well-formed address and
  // shows nothing at all when it does not get one.
  const query = encodeURIComponent(address);
  if (provider === "apple") return `https://maps.apple.com/?q=${query}`;
  return isAppleMobile(userAgent, maxTouchPoints)
    ? `comgooglemaps://?q=${query}`
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
