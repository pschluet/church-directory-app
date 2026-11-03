export type Platform = "ios" | "android";

/**
 * Which phone this probably is, from the browser's own account of itself.
 *
 * A suggestion for the /help page, never a gate: the visitor still picks, so a
 * wrong guess costs one tap. Null on a desktop, where there is nothing to
 * suggest.
 *
 * iPadOS Safari reports itself as a Mac by default, so a "Macintosh" with a
 * touch screen is an iPad -- no Mac has one. Android is tested first only
 * because some Android user agents also mention other platforms in passing.
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform | null {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return null;
}
