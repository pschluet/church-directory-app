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

/** "4 May" or "4 May 1985". */
export function formatMonthDay(month: number, day: number, year?: number | null): string {
  const name = MONTHS[month - 1] ?? "";
  return year ? `${name} ${day}, ${year}` : `${name} ${day}`;
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
 * anniversary is stored once and shows on both pages, so whose name to print
 * depends on whose page it is: Paul's page says "with Sarah", Sarah's "with
 * Paul".
 */
export function specialDatePartnerName(
  date: Pick<SpecialDateDto, "personId" | "personName" | "relatedPersonId" | "relatedPersonName">,
  viewedPersonId: string
): string | null {
  if (!date.relatedPersonId) return null;
  return date.relatedPersonId === viewedPersonId ? date.personName : date.relatedPersonName;
}

/** A single-line address, skipping the parts that are missing. */
export function formatAddress(person: Partial<PersonSummaryDto>): string | null {
  const street = [person.addressLine1, person.addressLine2].filter(Boolean).join(", ");
  const locality = [person.city, person.state].filter(Boolean).join(", ");
  const line = [street, locality, person.postalCode].filter(Boolean).join(" · ");
  return line || null;
}

export function formatMultilineAddress(person: Partial<PersonSummaryDto>): string[] {
  return [
    person.addressLine1,
    person.addressLine2,
    [person.city, person.state, person.postalCode].filter(Boolean).join(" "),
    person.country,
  ].filter((line): line is string => Boolean(line?.trim()));
}

/** Initials for the placeholder shown when someone has no photo. */
export function initials(person: { firstName: string; lastName: string | null }): string {
  return [person.firstName?.[0], person.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

export function displayPhone(e164: string | null): string | null {
  return e164 ? formatPhone(e164) : null;
}
