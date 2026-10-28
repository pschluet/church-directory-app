import type { GroupEventDto } from "@shared";
import { downloadBlob, safeFilename } from "./download";
import { escapeText, fold } from "./vcard";

/**
 * Turning an event into a calendar file, so a member can add it to their own
 * calendar.
 *
 * iCalendar (RFC 5545), because it is the one format every calendar opens:
 * iOS and macOS offer "Add to Calendar", Android hands it to the calendar app,
 * and Outlook and Google Calendar import it. Its text rules are vCard's, so
 * the escaping and line folding come from `vcard.ts`.
 */

export type CalendarEvent = Pick<
  GroupEventDto,
  "title" | "description" | "eventDate" | "startTime" | "endTime" | "location" | "shareToken"
>;

/** How long an event with a start but no end is taken to last. */
const DEFAULT_DURATION_MINUTES = 60;

const two = (n: number): string => String(n).padStart(2, "0");

/** `yyyy-mm-dd` plus `days`, as `yyyymmdd`. Done in UTC so no daylight-saving change can shift it. */
function dateValue(iso: string, days = 0): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`;
}

/**
 * A wall-clock time on a day, as a "floating" iCalendar date-time -- no zone,
 * so the calendar shows the same 10:00 the app does. Minutes past 24 hours
 * roll onto the next day.
 */
function dateTimeValue(iso: string, minutes: number): string {
  const days = Math.floor(minutes / (24 * 60));
  const rest = minutes - days * 24 * 60;
  return `${dateValue(iso, days)}T${two(Math.floor(rest / 60))}${two(rest % 60)}00`;
}

/** `HH:MM` or `HH:MM:SS` as minutes past midnight. */
function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function utcStamp(date: Date): string {
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(
    date.getUTCHours()
  )}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

/**
 * The calendar file for one event. `url` is the event's public share link: it
 * goes in the description as well as `URL`, because most calendars only show
 * the description.
 */
export function buildEventIcs(event: CalendarEvent, url: string, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Church Directory//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // Stable per event, so adding it again updates the entry rather than duplicating it.
    `UID:${event.shareToken}@church-directory`,
    `DTSTAMP:${utcStamp(now)}`,
  ];

  if (event.startTime) {
    const start = minutesOf(event.startTime);
    let end = event.endTime ? minutesOf(event.endTime) : start + DEFAULT_DURATION_MINUTES;
    // An end before the start runs past midnight.
    if (end <= start) end += 24 * 60;
    lines.push(`DTSTART:${dateTimeValue(event.eventDate, start)}`);
    lines.push(`DTEND:${dateTimeValue(event.eventDate, end)}`);
  } else {
    // All day: the end date is exclusive, so it is the day after.
    lines.push(`DTSTART;VALUE=DATE:${dateValue(event.eventDate)}`);
    lines.push(`DTEND;VALUE=DATE:${dateValue(event.eventDate, 1)}`);
  }

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location?.trim()) lines.push(`LOCATION:${escapeText(event.location.trim())}`);
  const description = [event.description?.trim(), url].filter(Boolean).join("\n\n");
  lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function eventIcsFilename(event: Pick<CalendarEvent, "title">): string {
  return `${safeFilename(event.title, "event")}.ics`;
}

export function downloadEventIcs(event: CalendarEvent, url: string): void {
  const blob = new Blob([buildEventIcs(event, url)], { type: "text/calendar;charset=utf-8" });
  downloadBlob(blob, eventIcsFilename(event));
}
