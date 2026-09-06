import { formatPhone } from "@shared";
import type { PersonSummaryDto, SpecialDateDto, SpecialDateType } from "@shared";

export { formatPhone, fullName, normalizePhone } from "@shared";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_NAMES = MONTHS;

/** yyyy-mm-dd, treated as a plain calendar date rather than an instant. */
export function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

export function todayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/** "Monday, 31 August" -- year omitted unless it differs from today's. */
export function formatDayLabel(iso: string): string {
  const date = parseIsoDate(iso);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

export function formatRelativeDay(iso: string): string | null {
  const days = Math.round(
    (parseIsoDate(iso).getTime() - parseIsoDate(todayIso()).getTime()) / 86_400_000
  );
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return null;
}

/**
 * How long ago something was posted -- "2 hours ago", "Yesterday", "4 May".
 *
 * Instant-based, unlike the rest of this file, which deals in plain calendar
 * dates: a prayer request is posted at a moment, and "3 hours ago" is what a
 * reader wants from a page that turns over within a month. Past a week the
 * relative form stops being useful ("23 days ago" needs counting back), so it
 * gives way to the date.
 *
 * `now` is injectable so this is testable without freezing the clock.
 */
export function formatPostedAt(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);

  // A clock skew between the browser and the server can put a fresh post a few
  // seconds in the future; read that as "just now" rather than as a negative.
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;

  return then.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/** "4 May" or "4 May 1985". */
export function formatMonthDay(month: number, day: number, year?: number | null): string {
  const name = MONTHS[month - 1] ?? "";
  return year ? `${name} ${day}, ${year}` : `${name} ${day}`;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "Sep 6" -- for a pill sitting in a row next to a name, where "September" is
 * the difference between the name fitting and the name being cut off.
 *
 * Only for the visible label. Anything a screen reader gets should use
 * `formatMonthDay`, which has no width to fight over.
 */
export function formatMonthDayShort(month: number, day: number): string {
  return `${MONTHS_SHORT[month - 1] ?? ""} ${day}`;
}

const SPECIAL_DATE_LABELS: Record<SpecialDateType, string> = {
  BIRTHDAY: "Birthday",
  ANNIVERSARY: "Wedding Anniversary",
  FEAST_DAY: "Name Day",
};

export function specialDateLabel(type: SpecialDateType): string {
  return SPECIAL_DATE_LABELS[type];
}

/**
 * The opt-in checkbox label, which reads differently for a birthday than for an
 * anniversary. Shared, so the note explaining a hidden year can quote back the
 * exact wording of the box the person left unchecked.
 */
export function showYearCountLabel(type: SpecialDateType): string {
  return type === "BIRTHDAY" ? "Show my age to others" : "Show how many years";
}

/**
 * "41st birthday" / "16 years married" / "St. Anna". Returns null when there is
 * nothing extra to say -- which is the common case, since showing an age is
 * opt-in.
 */
export function specialDateDetail(date: {
  type: SpecialDateType;
  yearCount?: number | null;
  patronSaint?: string | null;
}): string | null {
  if (date.type === "FEAST_DAY") return date.patronSaint ?? null;
  if (date.yearCount == null) return null;
  if (date.type === "BIRTHDAY") return `Turning ${date.yearCount}`;
  return `${date.yearCount} ${date.yearCount === 1 ? "year" : "years"} married`;
}

/**
 * The other half of a linked date, as seen from one person's page. An
 * anniversary is stored once and shows on both pages, so who the partner is
 * depends on whose page it is: Paul's page says "with Sarah", Sarah's "with
 * Paul".
 */
export function specialDatePartner(
  date: Pick<SpecialDateDto, "personId" | "personName" | "relatedPersonId" | "relatedPersonName">,
  viewedPersonId: string
): { id: string; name: string } | null {
  if (!date.relatedPersonId) return null;
  const partner =
    date.relatedPersonId === viewedPersonId
      ? { id: date.personId, name: date.personName }
      : { id: date.relatedPersonId, name: date.relatedPersonName };
  return partner.name ? { id: partner.id, name: partner.name } : null;
}

export function formatMultilineAddress(person: Partial<PersonSummaryDto>): string[] {
  return [
    person.addressLine1,
    person.addressLine2,
    [person.city, person.state, person.postalCode].filter(Boolean).join(" "),
    person.country,
  ].filter((line): line is string => Boolean(line?.trim()));
}

/**
 * The same address on one line, for a maps query.
 *
 * Commas between the lines but spaces inside the city/state/postcode one, which
 * is how an address is written and how both providers' search parses it. Built
 * on `formatMultilineAddress` rather than beside it so the two can never
 * disagree about which fields count or in what order.
 */
export function formatSingleLineAddress(person: Partial<PersonSummaryDto>): string {
  return formatMultilineAddress(person).join(", ");
}

/**
 * Whether an address is specific enough to be worth handing to a map.
 *
 * The street line is the bar. A city and state on their own resolve to the
 * middle of the city, and a link that drops somebody four miles from the house
 * is worse than plain text, because it looks like it knew where it was going.
 */
export function hasMappableAddress(person: Partial<PersonSummaryDto>): boolean {
  return Boolean(person.addressLine1?.trim());
}

/** Initials for the placeholder shown when someone has no photo. */
export function initials(person: { firstName: string; lastName: string | null }): string {
  return [person.firstName?.[0], person.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

export function displayPhone(e164: string | null): string | null {
  return e164 ? formatPhone(e164) : null;
}
