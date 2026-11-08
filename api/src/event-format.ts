/**
 * How an event's date and times read, shared by the SPA (through `@shared`, via
 * app/src/lib/format.ts) and the notification email -- so an event reads the
 * same in an inbox as on its page.
 */

/** "18:30" as "6:30 PM". Anything that is not HH:MM comes back as it was. */
export function formatTime12(hm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!match) return hm;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${suffix}`;
}

/**
 * When an event happens, as a person would say it: "6:30 – 8:00 PM" when both
 * ends share a half of the day, "6:30 PM – 12:00 AM" otherwise, "6:30 PM" with
 * no end, and null with no start time at all (an event can be just a date).
 */
export function formatEventTimes(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const from = formatTime12(start);
  if (!end) return from;
  const to = formatTime12(end);
  const sameHalf = from.slice(-2) === to.slice(-2);
  return `${sameHalf ? from.slice(0, -3) : from} – ${to}`;
}

/**
 * An event's day for an email: "Saturday, November 14", with the year when it
 * is not this year's.
 *
 * `event_date` is the parish's own naive local date (V16__groups.sql), so it is
 * formatted in UTC: read in any other zone, midnight on the 14th can become the
 * 13th. English, because the email has no browser to ask for a locale.
 */
export function formatEventDay(iso: string, now: Date = new Date()): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
    ...(date.getUTCFullYear() !== now.getUTCFullYear() ? { year: "numeric" } : {}),
  });
}
