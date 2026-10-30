import { describe, expect, it } from "vitest";
import {
  formatSpecialDateRule,
  moveableFeastDate,
  orthodoxPascha,
  resolveSpecialDateRule,
  type SpecialDateRule,
} from "../src/types";

/**
 * The Orthodox (Julian) Paschalion, rendered on the Gregorian calendar.
 *
 * These dates are not guesses -- they were computed independently (Meeus'
 * Julian Easter plus a Julian Day Number conversion) and cross-checked
 * against published Orthodox calendars before being pinned here.
 */
const KNOWN_PASCHA: Record<number, [number, number]> = {
  2022: [4, 24],
  2023: [4, 16],
  2024: [5, 5],
  2025: [4, 20],
  2026: [4, 12],
  2027: [5, 2],
  2028: [4, 16],
  2029: [4, 8],
  2030: [4, 28],
  2031: [4, 13],
  2032: [5, 2],
};

describe("orthodoxPascha", () => {
  for (const [year, [month, day]] of Object.entries(KNOWN_PASCHA)) {
    it(`falls on ${month}/${day} in ${year}`, () => {
      expect(orthodoxPascha(Number(year))).toEqual({ year: Number(year), month, day });
    });
  }

  it("is always a Sunday, across the whole supported range", () => {
    for (let year = 1900; year <= 2200; year += 1) {
      const { month, day } = orthodoxPascha(year);
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      expect(weekday, `${year}-${month}-${day}`).toBe(0);
    }
  });

  it("is always between 4 April and 9 May inclusive -- the Julian-Gregorian gap widens the later window over this range", () => {
    for (let year = 1900; year <= 2200; year += 1) {
      const { month, day } = orthodoxPascha(year);
      const ordinal = month === 4 ? day : 30 + day; // days into April/May
      expect(ordinal).toBeGreaterThanOrEqual(4);
      expect(ordinal).toBeLessThanOrEqual(39); // 9 May = 30 + 9
    }
  });

  it("derives the Julian-Gregorian offset rather than hardcoding it", () => {
    // The gap crosses from 13 to 14 days at the 2100 century mark, which only
    // a Julian Day Number conversion gets right without a special case.
    expect(orthodoxPascha(2100)).toEqual({ year: 2100, month: 5, day: 2 });
    expect(orthodoxPascha(2101)).toEqual({ year: 2101, month: 4, day: 24 });
  });

  it("refuses a year outside the supported range", () => {
    expect(() => orthodoxPascha(1799)).toThrow();
    expect(() => orthodoxPascha(2201)).toThrow();
  });
});

describe("moveableFeastDate", () => {
  it("derives Palm Sunday, Ascension and Pentecost as offsets from Pascha", () => {
    // Pascha 2026-04-12.
    expect(moveableFeastDate("PALM_SUNDAY", 2026)).toEqual({ year: 2026, month: 4, day: 5 });
    expect(moveableFeastDate("ASCENSION", 2026)).toEqual({ year: 2026, month: 5, day: 21 });
    expect(moveableFeastDate("PENTECOST", 2026)).toEqual({ year: 2026, month: 5, day: 31 });
  });

  it("keeps Ascension on a Thursday and Pentecost on a Sunday", () => {
    for (let year = 1900; year <= 2200; year += 1) {
      const ascension = moveableFeastDate("ASCENSION", year);
      const pentecost = moveableFeastDate("PENTECOST", year);
      expect(
        new Date(Date.UTC(ascension.year, ascension.month - 1, ascension.day)).getUTCDay()
      ).toBe(4);
      expect(
        new Date(Date.UTC(pentecost.year, pentecost.month - 1, pentecost.day)).getUTCDay()
      ).toBe(0);
    }
  });

  it("keeps Nativity and Theophany fixed, New Calendar dates", () => {
    expect(moveableFeastDate("NATIVITY", 2026)).toEqual({ year: 2026, month: 12, day: 25 });
    expect(moveableFeastDate("THEOPHANY", 2026)).toEqual({ year: 2026, month: 1, day: 6 });
  });
});

function rule(partial: Partial<SpecialDateRule>): SpecialDateRule {
  return {
    reference: "PASCHA",
    direction: "AFTER",
    unit: "DAYS",
    count: 0,
    weekday: null,
    ...partial,
  };
}

describe("resolveSpecialDateRule", () => {
  it('counts weekdays strictly after -- "1 Sunday after Pascha" is Thomas Sunday, not Pascha', () => {
    // Pascha 2026-04-12 is itself a Sunday.
    expect(resolveSpecialDateRule(rule({ unit: "WEEKDAY", count: 1, weekday: 0 }), 2026)).toEqual({
      year: 2026,
      month: 4,
      day: 19,
    });
    expect(resolveSpecialDateRule(rule({ unit: "WEEKDAY", count: 2, weekday: 0 }), 2026)).toEqual({
      year: 2026,
      month: 4,
      day: 26,
    });
  });

  it("counts other weekdays correctly in both directions", () => {
    expect(resolveSpecialDateRule(rule({ unit: "WEEKDAY", count: 1, weekday: 1 }), 2026)).toEqual({
      year: 2026,
      month: 4,
      day: 13,
    }); // 1 Monday after = Bright Monday
    expect(
      resolveSpecialDateRule(
        rule({ direction: "BEFORE", unit: "WEEKDAY", count: 1, weekday: 6 }),
        2026
      )
    ).toEqual({ year: 2026, month: 4, day: 11 }); // 1 Saturday before = Great Saturday
    expect(
      resolveSpecialDateRule(
        rule({ direction: "BEFORE", unit: "WEEKDAY", count: 2, weekday: 6 }),
        2026
      )
    ).toEqual({ year: 2026, month: 4, day: 4 }); // 2 Saturdays before = Lazarus Saturday
  });

  it("agrees with moveableFeastDate's Palm Sunday via an independent path", () => {
    // "1 Sunday before Pascha" and the Palm Sunday feast constant must agree.
    const viaRule = resolveSpecialDateRule(
      rule({ direction: "BEFORE", unit: "WEEKDAY", count: 1, weekday: 0 }),
      2026
    );
    expect(viaRule).toEqual(moveableFeastDate("PALM_SUNDAY", 2026));
  });

  it("distinguishes the strict rule from an inclusive one on a year Nativity falls on a Sunday", () => {
    // 2033-12-25 is itself a Sunday.
    expect(moveableFeastDate("NATIVITY", 2033)).toEqual({ year: 2033, month: 12, day: 25 });
    expect(
      resolveSpecialDateRule(
        rule({ reference: "NATIVITY", direction: "BEFORE", unit: "WEEKDAY", count: 1, weekday: 0 }),
        2033
      )
    ).toEqual({ year: 2033, month: 12, day: 18 });
  });

  it("allows a day offset of zero -- the feast itself", () => {
    expect(resolveSpecialDateRule(rule({ unit: "DAYS", count: 0 }), 2026)).toEqual(
      moveableFeastDate("PASCHA", 2026)
    );
    // Direction is irrelevant at zero.
    expect(
      resolveSpecialDateRule(rule({ direction: "BEFORE", unit: "DAYS", count: 0 }), 2026)
    ).toEqual(resolveSpecialDateRule(rule({ direction: "AFTER", unit: "DAYS", count: 0 }), 2026));
  });

  it("derives Ascension and the 40-days-before mirror from day offsets", () => {
    expect(resolveSpecialDateRule(rule({ unit: "DAYS", count: 39 }), 2026)).toEqual({
      year: 2026,
      month: 5,
      day: 21,
    });
    expect(
      resolveSpecialDateRule(rule({ direction: "BEFORE", unit: "DAYS", count: 40 }), 2026)
    ).toEqual({ year: 2026, month: 3, day: 3 });
  });

  it("can resolve into the following or preceding calendar year", () => {
    expect(
      resolveSpecialDateRule(rule({ reference: "NATIVITY", unit: "DAYS", count: 15 }), 2026)
    ).toEqual({ year: 2027, month: 1, day: 9 });
    expect(
      resolveSpecialDateRule(
        rule({ reference: "THEOPHANY", direction: "BEFORE", unit: "DAYS", count: 10 }),
        2026
      )
    ).toEqual({ year: 2025, month: 12, day: 27 });
  });

  it("can land on 29 February only in a leap year -- no carry-over applies to a rule", () => {
    // Pascha 2024-05-05 minus 66 days.
    expect(
      resolveSpecialDateRule(rule({ direction: "BEFORE", unit: "DAYS", count: 66 }), 2024)
    ).toEqual({ year: 2024, month: 2, day: 29 });
    expect(
      resolveSpecialDateRule(rule({ direction: "BEFORE", unit: "DAYS", count: 66 }), 2025)
    ).toEqual({ year: 2025, month: 2, day: 13 });
  });
});

describe("formatSpecialDateRule", () => {
  it("names the feast alone when the offset is zero", () => {
    expect(formatSpecialDateRule(rule({ unit: "DAYS", count: 0 }))).toBe("Pascha");
  });

  it("pluralizes a day count correctly", () => {
    expect(formatSpecialDateRule(rule({ unit: "DAYS", count: 1 }))).toBe("1 day after Pascha");
    expect(
      formatSpecialDateRule(
        rule({ reference: "NATIVITY", direction: "BEFORE", unit: "DAYS", count: 3 })
      )
    ).toBe("3 days before Nativity");
  });

  it("formats weekday rules with the right ordinal", () => {
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 1, weekday: 0 }))).toBe(
      "1st Sunday after Pascha"
    );
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 2, weekday: 0 }))).toBe(
      "2nd Sunday after Pascha"
    );
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 3, weekday: 1 }))).toBe(
      "3rd Monday after Pascha"
    );
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 4, weekday: 2 }))).toBe(
      "4th Tuesday after Pascha"
    );
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 11, weekday: 3 }))).toBe(
      "11th Wednesday after Pascha"
    );
    expect(formatSpecialDateRule(rule({ unit: "WEEKDAY", count: 21, weekday: 4 }))).toBe(
      "21st Thursday after Pascha"
    );
  });
});
