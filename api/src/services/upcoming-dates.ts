import { isLeapYear } from "../types";

/**
 * Turning stored (month, day, optional year) records into "what is coming up".
 *
 * The window is expanded here rather than computed in SQL. Doing it in
 * Postgres means building real dates from month/day pairs, which turns Feb 29
 * and the year boundary into awkward special cases (`make_date` simply errors
 * on 29 February 1999). Expanding to a list of month/day keys and filtering
 * with `month * 100 + day = any($1)` keeps the query trivial and the
 * calendar rules explicit and testable.
 *
 * `start` is always supplied by the caller as a yyyy-mm-dd string, so "today"
 * means the user's today and the server's timezone never enters into it. All
 * arithmetic below is UTC for the same reason.
 */

/** A year plus a day, so no window can silently become unbounded. */
export const MAX_WINDOW_DAYS = 366;
export const DEFAULT_WINDOW_DAYS = 7;

export interface WindowDay {
  /** yyyy-mm-dd */
  iso: string;
  year: number;
  month: number;
  day: number;
  /**
   * The stored (month, day) values that should surface on this calendar day.
   * Usually just this day's own, but 1 March in a non-leap year also carries
   * 29 February, so leap-day birthdays and feast days are not skipped for
   * three years out of four.
   */
  monthDayKeys: number[];
}

export function monthDayKey(month: number, day: number): number {
  return month * 100 + day;
}

export function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Expected a yyyy-mm-dd date, got "${iso}"`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    throw new Error(`"${iso}" is not a real date`);
  }
  return { year, month, day };
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `days` calendar days starting at `start` inclusive -- so the default of 7
 * gives "today and the next 6 days".
 */
export function expandWindow(startIso: string, days: number): WindowDay[] {
  const clamped = Math.min(Math.max(Math.trunc(days), 1), MAX_WINDOW_DAYS);
  const { year, month, day } = parseIsoDate(startIso);
  const cursor = new Date(Date.UTC(year, month - 1, day));

  const window: WindowDay[] = [];
  for (let i = 0; i < clamped; i += 1) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();

    const keys = [monthDayKey(m, d)];
    if (m === 3 && d === 1 && !isLeapYear(y)) keys.push(monthDayKey(2, 29));

    window.push({ iso: toIsoDate(cursor), year: y, month: m, day: d, monthDayKeys: keys });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return window;
}

/** Every distinct stored key the window could match -- the SQL parameter. */
export function allMonthDayKeys(window: WindowDay[]): number[] {
  return [...new Set(window.flatMap((d) => d.monthDayKeys))].sort((a, b) => a - b);
}

/**
 * Age on a birthday, or years married on an anniversary. Null unless the
 * person opted in to showing it and a year is on record -- the requirement is
 * "checkbox should allow the person to opt-in to showing age to others", so
 * the default has to be silence.
 */
export function yearCountFor(
  occurrenceYear: number,
  storedYear: number | null,
  showYearCount: boolean
): number | null {
  if (!showYearCount || storedYear == null) return null;
  const count = occurrenceYear - storedYear;
  return count >= 0 ? count : null;
}

/** All the days in one calendar month, for the month-grid view. */
export function expandMonth(year: number, month: number): WindowDay[] {
  const daysInThisMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  return expandWindow(start, daysInThisMonth);
}

/**
 * Dates are "grouped by date then special date type". This is the type order
 * within a day.
 */
export const TYPE_ORDER = ["BIRTHDAY", "ANNIVERSARY", "FEAST_DAY"] as const;

export function compareByTypeThenName(
  a: { type: string; personName: string },
  b: { type: string; personName: string }
): number {
  const byType = TYPE_ORDER.indexOf(a.type as never) - TYPE_ORDER.indexOf(b.type as never);
  return byType !== 0 ? byType : a.personName.localeCompare(b.personName);
}
