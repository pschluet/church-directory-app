/**
 * The one thing every paginated route needs: a limit it can trust.
 *
 * A query string carries whatever the caller typed, so this clamps rather than
 * rejects -- a nonsense `?limit=` should show a page, not a 400 -- and the
 * ceiling is what stops one request asking for a parish's whole history.
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
