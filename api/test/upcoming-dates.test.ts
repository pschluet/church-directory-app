import { describe, expect, it } from "vitest";
import {
  allMonthDayKeys,
  compareByTypeThenName,
  expandMonth,
  expandWindow,
  MAX_WINDOW_DAYS,
  monthDayKey,
  parseIsoDate,
  yearCountFor,
} from "../src/services/upcoming-dates";

describe("expandWindow", () => {
  it("covers today and the next six days by default", () => {
    const window = expandWindow("2026-08-30", 7);
    expect(window).toHaveLength(7);
    expect(window[0]!.iso).toBe("2026-08-30");
    expect(window[6]!.iso).toBe("2026-09-05");
  });

  it("crosses a year boundary without gaps", () => {
    const window = expandWindow("2026-12-29", 5);
    expect(window.map((d) => d.iso)).toEqual([
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("clamps a silly range rather than building an unbounded list", () => {
    expect(expandWindow("2026-01-01", 10_000)).toHaveLength(MAX_WINDOW_DAYS);
    expect(expandWindow("2026-01-01", 0)).toHaveLength(1);
    expect(expandWindow("2026-01-01", -5)).toHaveLength(1);
  });

  it("rejects anything that is not a real yyyy-mm-dd date", () => {
    expect(() => parseIsoDate("2026-02-30")).toThrow();
    expect(() => parseIsoDate("30/08/2026")).toThrow();
    expect(() => parseIsoDate("2026-13-01")).toThrow();
  });
});

describe("leap day handling", () => {
  it("surfaces 29 February on 1 March in a non-leap year", () => {
    const window = expandWindow("2027-02-27", 4);
    const march1 = window.find((d) => d.iso === "2027-03-01")!;
    expect(march1.monthDayKeys).toContain(monthDayKey(2, 29));
    // ...and 28 February does not also claim it.
    const feb28 = window.find((d) => d.iso === "2027-02-28")!;
    expect(feb28.monthDayKeys).not.toContain(monthDayKey(2, 29));
  });

  it("leaves 29 February on its own day in a leap year", () => {
    const window = expandWindow("2028-02-28", 3);
    const feb29 = window.find((d) => d.iso === "2028-02-29")!;
    expect(feb29.monthDayKeys).toEqual([monthDayKey(2, 29)]);
    const march1 = window.find((d) => d.iso === "2028-03-01")!;
    expect(march1.monthDayKeys).toEqual([monthDayKey(3, 1)]);
  });
});

describe("allMonthDayKeys", () => {
  it("is deduplicated and sorted", () => {
    const keys = allMonthDayKeys(expandWindow("2027-02-27", 4));
    expect(keys).toEqual([...new Set(keys)].sort((a, b) => a - b));
    expect(keys).toContain(monthDayKey(2, 29));
  });
});

describe("yearCountFor", () => {
  it("returns the age when the person opted in", () => {
    expect(yearCountFor(2026, 1985, true)).toBe(41);
  });

  it("stays silent when the person did not opt in", () => {
    expect(yearCountFor(2026, 1985, false)).toBeNull();
  });

  it("stays silent when only a month and day are on record", () => {
    expect(yearCountFor(2026, null, true)).toBeNull();
  });

  it("refuses to report a negative age from a future year", () => {
    expect(yearCountFor(2026, 2030, true)).toBeNull();
  });
});

describe("expandMonth", () => {
  it("covers exactly the days in the month", () => {
    expect(expandMonth(2026, 2)).toHaveLength(28);
    expect(expandMonth(2028, 2)).toHaveLength(29);
    expect(expandMonth(2026, 4)).toHaveLength(30);
    expect(expandMonth(2026, 12)).toHaveLength(31);
  });
});

describe("compareByTypeThenName", () => {
  it("orders birthday, then anniversary, then feast day", () => {
    const sorted = [
      { type: "FEAST_DAY", personName: "Anna" },
      { type: "ANNIVERSARY", personName: "Paul" },
      { type: "BIRTHDAY", personName: "Zoe" },
    ].sort(compareByTypeThenName);
    expect(sorted.map((d) => d.type)).toEqual(["BIRTHDAY", "ANNIVERSARY", "FEAST_DAY"]);
  });

  it("falls back to name within a type", () => {
    const sorted = [
      { type: "BIRTHDAY", personName: "Zoe" },
      { type: "BIRTHDAY", personName: "Anna" },
    ].sort(compareByTypeThenName);
    expect(sorted.map((d) => d.personName)).toEqual(["Anna", "Zoe"]);
  });
});
