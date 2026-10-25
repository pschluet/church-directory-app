/**
 * Where an event can be seen without signing in.
 *
 * The page lives at `/e/:token`, an unguessable token standing in for the event
 * id so that sharing one event does not expose the rest of the directory.
 */

/**
 * The public link for an event's share token.
 *
 * Built from `window.location.origin` rather than a configured base URL: the
 * app has no client-side one (`SITE_URL` is server-only, for emails and push),
 * and the origin the page is open on is right in every place it runs --
 * production, a preview deployment and localhost -- where a baked-in constant
 * would be right in at most one.
 */
export function eventShareUrl(token: string): string {
  return `${window.location.origin}/e/${token}`;
}
