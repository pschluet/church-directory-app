import { describe, expect, it } from "vitest";
import {
  datesBetween,
  entryEditUrl,
  isGeneralOnly,
  parseEntryParam,
  signupFlyerRows,
  slotTitle,
  spotsLeft,
} from "../src/lib/signups";

describe("datesBetween", () => {
  it("lists every day in the range with no weekdays picked", () => {
    expect(datesBetween("2026-12-01", "2026-12-03", [])).toEqual([
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
    ]);
  });

  it("keeps only the picked weekdays -- every Sunday in Advent", () => {
    expect(datesBetween("2026-11-29", "2026-12-24", [0])).toEqual([
      "2026-11-29",
      "2026-12-06",
      "2026-12-13",
      "2026-12-20",
    ]);
  });

  it("crosses a month and year end", () => {
    expect(datesBetween("2026-12-31", "2027-01-01", [])).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("is empty for a backwards or missing range, and capped at the slot limit", () => {
    expect(datesBetween("2026-12-03", "2026-12-01", [])).toEqual([]);
    expect(datesBetween("", "2026-12-01", [])).toEqual([]);
    expect(datesBetween("2026-01-01", "2027-12-31", [])).toHaveLength(100);
  });
});

describe("slots", () => {
  it("names a slot by its date and label", () => {
    expect(slotTitle({ date: null, label: "Dessert" })).toBe("Dessert");
    expect(slotTitle({ date: null, label: null })).toBeNull();
    expect(slotTitle({ date: "2026-12-06", label: "Dinner" })).toMatch(/December 6 · Dinner$/);
  });

  it("knows the one general slot", () => {
    expect(isGeneralOnly([{ date: null, label: null, isWriteIn: false }])).toBe(true);
    expect(
      isGeneralOnly([
        { date: null, label: null, isWriteIn: false },
        { date: null, label: "Bread", isWriteIn: true },
      ])
    ).toBe(true);
    expect(isGeneralOnly([{ date: null, label: "Main", isWriteIn: false }])).toBe(false);
  });

  it("counts spots left, or null for unlimited", () => {
    expect(spotsLeft({ capacity: 4, taken: 3 })).toBe(1);
    expect(spotsLeft({ capacity: 2, taken: 5 })).toBe(0);
    expect(spotsLeft({ capacity: null, taken: 5 })).toBeNull();
  });
});

describe("signupFlyerRows", () => {
  it("lists what is needed, leaving out write-ins", () => {
    expect(
      signupFlyerRows({
        slots: [
          { date: null, label: "Oranges", isWriteIn: false },
          { date: null, label: "Gold coins", isWriteIn: true },
        ],
        closesOn: null,
        importantInfo: null,
      })
    ).toEqual([["NEEDED", "Oranges"]]);
  });

  it("summarizes a long run of dates", () => {
    const slots = datesBetween("2026-12-01", "2026-12-20", []).map((date) => ({
      date,
      label: null,
      isWriteIn: false,
    }));
    const rows = signupFlyerRows({ slots, closesOn: null, importantInfo: null });
    expect(rows[0]?.[0]).toBe("DATES");
    expect(rows[0]?.[1]).toContain("(20 dates)");
  });
});

describe("edit links", () => {
  it("round-trips an entry id and token", () => {
    const url = entryEditUrl("TOKEN", "entry-1", "abc.def");
    const value = new URL(url).searchParams.get("entry");
    expect(parseEntryParam(value)).toEqual({ entryId: "entry-1", token: "abc.def" });
    expect(parseEntryParam(null)).toBeNull();
    expect(parseEntryParam("nodot")).toBeNull();
  });
});
