import { afterEach, describe, expect, it, vi } from "vitest";
import { stubDownload } from "./utils";
import {
  buildEventIcs,
  type CalendarEvent,
  downloadEventIcs,
  eventIcsFilename,
} from "../src/lib/ics";

const URL_ = "https://directory.example.org/e/tok123";
const NOW = new Date("2026-10-28T15:04:05.000Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    title: "Parish Picnic",
    description: null,
    eventDate: "2026-11-14",
    startTime: null,
    endTime: null,
    location: null,
    shareToken: "tok123",
    ...overrides,
  };
}

const lines = (ics: string): string[] => ics.replace(/\r\n /g, "").split("\r\n");

describe("buildEventIcs", () => {
  it("wraps one event in a calendar, with CRLF line endings", () => {
    const ics = buildEventIcs(event(), URL_, NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(lines(ics)).toEqual(
      expect.arrayContaining([
        "UID:tok123@church-directory",
        "DTSTAMP:20261028T150405Z",
        "SUMMARY:Parish Picnic",
        `URL:${URL_}`,
      ])
    );
  });

  it("makes an event with no start time an all-day one", () => {
    const out = lines(buildEventIcs(event({ eventDate: "2026-12-31" }), URL_, NOW));
    expect(out).toContain("DTSTART;VALUE=DATE:20261231");
    expect(out).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("uses floating local times for a timed event", () => {
    const out = lines(
      buildEventIcs(event({ startTime: "10:00:00", endTime: "13:30:00" }), URL_, NOW)
    );
    expect(out).toContain("DTSTART:20261114T100000");
    expect(out).toContain("DTEND:20261114T133000");
  });

  it("gives a start with no end an hour, rolling past midnight", () => {
    const out = lines(buildEventIcs(event({ startTime: "23:30" }), URL_, NOW));
    expect(out).toContain("DTSTART:20261114T233000");
    expect(out).toContain("DTEND:20261115T003000");
  });

  it("puts the location in, and the link after the description", () => {
    const out = lines(
      buildEventIcs(
        event({ location: "Hall; Room 2, Main St", description: "Bring a dish\nand a chair" }),
        URL_,
        NOW
      )
    );
    expect(out).toContain("LOCATION:Hall\\; Room 2\\, Main St");
    expect(out).toContain(`DESCRIPTION:Bring a dish\\nand a chair\\n\\n${URL_}`);
  });

  it("folds long lines at 75 octets", () => {
    const ics = buildEventIcs(event({ description: "word ".repeat(60) }), URL_, NOW);
    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n"))
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("downloadEventIcs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saves a calendar file named for the event", () => {
    const download = stubDownload();
    downloadEventIcs(event({ title: "Picnic: Fall/Winter" }), URL_);
    const blob = download.create.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/calendar;charset=utf-8");
    expect(download.clicked()?.download).toBe("Picnic FallWinter.ics");
  });

  it("falls back to a generic name", () => {
    expect(eventIcsFilename({ title: "///" })).toBe("event.ics");
  });
});
