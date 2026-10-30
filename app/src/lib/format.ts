import { formatPhone, formatSpecialDateRule, resolveSpecialDateRule } from "@shared";
import type { PersonSummaryDto, SpecialDateDto, SpecialDateRule, SpecialDateType } from "@shared";

export { formatPhone, formatSpecialDateRule, fullName, normalizePhone } from "@shared";

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

/** The local yyyy-mm-dd of an instant, for deciding which day a message belongs to. */
export function localDayIso(instant: string | Date): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The label on a chat's day divider: "Today", "Yesterday", the weekday for the
 * rest of the past week, and a full date after that.
 *
 * Calendar days in the reader's own timezone rather than 24-hour spans -- a
 * message from 11pm last night is "Yesterday" at 1am, not "Today".
 */
export function formatChatDay(instant: string, now: Date = new Date()): string {
  const day = localDayIso(instant);
  const days = Math.round(
    (parseIsoDate(localDayIso(now)).getTime() - parseIsoDate(day).getTime()) / 86_400_000
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return parseIsoDate(day).toLocaleDateString(undefined, { weekday: "long" });
  return formatDayLabel(day);
}

/** The time of day on a chat row, e.g. "2:05 PM". */
export function formatChatTime(instant: string): string {
  return new Date(instant).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
 * "2nd Sunday after Pascha" for a name day that moves with a feast; null for
 * a fixed one. A separate, quieter fact from `specialDateDetail` (the patron
 * saint) -- the two coexist rather than compete for the one bold slot.
 */
export function specialDateRuleText(date: { rule?: SpecialDateRule | null }): string | null {
  return date.rule ? formatSpecialDateRule(date.rule) : null;
}

/**
 * The date to show for a special date: the stored month and day for a fixed
 * one, or the next occurrence on or after `today` for one that moves with a
 * feast. The year is included for a moving date specifically because it is
 * not the same one every time -- that is the visible evidence that the date
 * moves, the same way the live preview in the form shows three different
 * years for the same rule.
 */
export function specialDateDateText(
  date: Pick<SpecialDateDto, "month" | "day" | "year" | "rule">,
  today: string = todayIso()
): string {
  if (!date.rule) return formatMonthDay(date.month ?? 1, date.day ?? 1, date.year ?? null);

  const todayDate = parseIsoDate(today);
  const anchorYear = todayDate.getFullYear();
  const rule = date.rule;
  const next =
    [anchorYear - 1, anchorYear, anchorYear + 1]
      .map((year) => resolveSpecialDateRule(rule, year))
      .find(
        (resolved) =>
          new Date(resolved.year, resolved.month - 1, resolved.day).getTime() >= todayDate.getTime()
      ) ?? resolveSpecialDateRule(rule, anchorYear + 1);
  return formatMonthDay(next.month, next.day, next.year);
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

/**
 * A few names and how many more there are -- "Anna, Maria, Nikolai +1".
 *
 * The tail of a member preview, without any count in front of it, because the
 * two callers disagree about what the count means. The families list says
 * "4 members" and means the whole family; a map pin says nothing, because a pin
 * is an address and a family can have somebody living elsewhere.
 *
 * Shared rather than written twice because the fiddly part is the arithmetic --
 * `total` is the real number of people, which may be larger than `names`, since
 * the families list caps its names server-side. `api/src/services/persons.ts`
 * records what happened last time two copies of this preview's logic drifted:
 * the list ordered its members differently from the page it previewed.
 */
export function memberPreview(names: string[], total: number, show = 3): string {
  const shown = names.slice(0, show);
  // `total` rather than `names.length`: the caller may have been handed fewer
  // names than there are people, and the overflow has to count the ones it
  // never saw.
  const hidden = Math.max(total - shown.length, 0);
  if (shown.length === 0) return hidden > 0 ? `+${hidden}` : "";
  return hidden > 0 ? `${shown.join(", ")} +${hidden}` : shown.join(", ");
}

/** Initials for the placeholder shown when someone has no photo. */
export function initials(person: { firstName: string; lastName: string | null }): string {
  return [person.firstName?.[0], person.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

export function displayPhone(e164: string | null): string | null {
  return e164 ? formatPhone(e164) : null;
}
