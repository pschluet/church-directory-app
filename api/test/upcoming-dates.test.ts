import { describe, expect, it } from "vitest";
import {
  allMonthDayKeys,
  anchorYearsFor,
  compareByTypeThenName,
  completedYearsOn,
  expandMonth,
  expandWindow,
  MAX_WINDOW_DAYS,
  monthDayKey,
  parseIsoDate,
  resolveRelativeRows,
  yearCountFor,
} from "../src/services/upcoming-dates";
import type { SpecialDateRule } from "../src/types";

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

describe("completedYearsOn", () => {
  // The opt-in, spelled out: everything below passes `true` for show_year_count
  // except the case that checks the default is silence.
  it("counts the birthday that has already passed this year", () => {
    expect(completedYearsOn("2026-09-01", 5, 4, 1985, true)).toBe(41);
  });

  it("has not counted a birthday still to come this year", () => {
    expect(completedYearsOn("2026-09-01", 12, 25, 1985, true)).toBe(40);
  });

  it("counts the birthday on the day itself", () => {
    expect(completedYearsOn("2026-05-04", 5, 4, 1985, true)).toBe(41);
  });

  it("has not counted a birthday one day away", () => {
    expect(completedYearsOn("2026-05-03", 5, 4, 1985, true)).toBe(40);
  });

  // Distinct from yearCountFor, which answers "how old on that occurrence".
  // On 3 May that says 41 while this says 40 -- the family page states a fact
  // about now, so the two must not agree here.
  it("disagrees with yearCountFor before the birthday, on purpose", () => {
    expect(completedYearsOn("2026-05-03", 5, 4, 1985, true)).toBe(40);
    expect(yearCountFor(2026, 1985, true)).toBe(41);
  });

  it("treats 1 March as a leap-day birthday's boundary in a non-leap year", () => {
    // 2026 is not a leap year, so 29 February has no occurrence of its own.
    expect(completedYearsOn("2026-02-28", 2, 29, 2000, true)).toBe(25);
    expect(completedYearsOn("2026-03-01", 2, 29, 2000, true)).toBe(26);
  });

  it("uses the real date in a leap year", () => {
    expect(completedYearsOn("2028-02-28", 2, 29, 2000, true)).toBe(27);
    expect(completedYearsOn("2028-02-29", 2, 29, 2000, true)).toBe(28);
  });

  it("says nothing when the person did not opt in", () => {
    expect(completedYearsOn("2026-09-01", 5, 4, 1985, false)).toBeNull();
  });

  it("says nothing when no year is on record", () => {
    expect(completedYearsOn("2026-09-01", 5, 4, null, true)).toBeNull();
  });

  it("says nothing rather than a negative count for a year in the future", () => {
    expect(completedYearsOn("2026-09-01", 5, 4, 2030, true)).toBeNull();
  });

  it("counts a birth earlier this year as zero", () => {
    expect(completedYearsOn("2026-09-01", 5, 4, 2026, true)).toBe(0);
  });
});

describe("anchorYearsFor", () => {
  it("adds one year on each side of a short window", () => {
    const window = expandWindow("2026-04-06", 14);
    expect(anchorYearsFor(window)).toEqual([2025, 2026, 2027]);
  });

  it("spans every year a 366-day window touches, plus one on each side", () => {
    const window = expandWindow("2026-06-01", 366);
    expect(anchorYearsFor(window)).toEqual([2025, 2026, 2027, 2028]);
  });

  it("returns nothing for an empty window", () => {
    expect(anchorYearsFor([])).toEqual([]);
  });
});

describe("resolveRelativeRows", () => {
  const thomasSunday: SpecialDateRule = {
    reference: "PASCHA",
    direction: "AFTER",
    unit: "WEEKDAY",
    count: 1,
    weekday: 0,
  };

  it("places a rule on the one day it resolves to", () => {
    // Pascha 2026-04-12, so Thomas Sunday is 2026-04-19.
    const window = expandWindow("2026-04-06", 14);
    const row = { id: "sd-1", rule: thomasSunday };
    const byIso = resolveRelativeRows(window, [row]);
    expect([...byIso.keys()]).toEqual(["2026-04-19"]);
    expect(byIso.get("2026-04-19")).toEqual([row]);
  });

  it("finds nothing when the window misses every occurrence", () => {
    const window = expandWindow("2026-04-20", 14);
    expect(resolveRelativeRows(window, [{ id: "sd-1", rule: thomasSunday }]).size).toBe(0);
  });

  /*
   * Consecutive Orthodox Paschas can be as little as 350 days apart (e.g.
   * 2026-04-12 to 2027-05-02 inclusive is 385 days, but 2024-05-05 to
   * 2025-04-20 is 350), so a 366-day window can hold two occurrences of a
   * Pascha-anchored rule -- or, symmetrically, none at all. Both are correct
   * behaviour for a moving date, not an edge case to special-case away.
   */
  it("surfaces two occurrences when a 366-day window spans a short Pascha-to-Pascha gap", () => {
    // Pascha 2025-04-20 and 2026-04-12 are 357 days apart.
    const window = expandWindow("2025-04-20", 366);
    const row = { id: "sd-1", rule: { ...thomasSunday, unit: "DAYS" as const, count: 0 } };
    const byIso = resolveRelativeRows(window, [row]);
    expect([...byIso.keys()].sort()).toEqual(["2025-04-20", "2026-04-12"]);
  });

  it("surfaces zero occurrences when a 366-day window spans a long Pascha-to-Pascha gap", () => {
    // Pascha 2026-04-12 and 2027-05-02 are 385 days apart, outside any
    // 366-day window that starts the day after the first.
    const window = expandWindow("2026-04-13", 366);
    const row = { id: "sd-1", rule: { ...thomasSunday, unit: "DAYS" as const, count: 0 } };
    expect(resolveRelativeRows(window, [row]).size).toBe(0);
  });

  it("can resolve into the January following the window's own year", () => {
    const window = expandMonth(2026, 12);
    const row = {
      id: "sd-1",
      rule: {
        reference: "NATIVITY" as const,
        direction: "AFTER" as const,
        unit: "DAYS" as const,
        count: 15,
        weekday: null,
      },
    };
    // Falls in January 2027, outside a December-only window.
    expect(resolveRelativeRows(window, [row]).size).toBe(0);

    const januaryWindow = expandMonth(2027, 1);
    expect([...resolveRelativeRows(januaryWindow, [row]).keys()]).toEqual(["2027-01-09"]);
  });

  it("does not let the 29 Feb carry-over collide with a rule resolving onto 1 March", () => {
    // In 2027 (not a leap year), expandWindow gives 1 March the extra key 229
    // so a stored (2, 29) birthday still surfaces there. A *rule* resolving to
    // 2027-03-01 must land there once, from its own resolved ISO date, with no
    // interaction with that fallback.
    const window = expandWindow("2027-02-25", 10);
    // Pascha 2027-05-02 minus 62 days.
    const row = {
      id: "sd-1",
      rule: {
        reference: "PASCHA" as const,
        direction: "BEFORE" as const,
        unit: "DAYS" as const,
        count: 62,
        weekday: null,
      },
    };
    const byIso = resolveRelativeRows(window, [row]);
    expect([...byIso.keys()]).toEqual(["2027-03-01"]);
    expect(byIso.get("2027-03-01")).toHaveLength(1);
  });
});
