import { describe, expect, it } from "vitest";
import {
  displayPhone,
  formatChatDay,
  formatEventTimes,
  formatTime12,
  localDayIso,
  formatMonthDay,
  formatMonthDayShort,
  formatMultilineAddress,
  formatPostedAt,
  formatSingleLineAddress,
  hasMappableAddress,
  initials,
  memberPreview,
  specialDateDateText,
  specialDateDetail,
  specialDateLabel,
  specialDatePartner,
  specialDateRuleText,
} from "../src/lib/format";

describe("displayPhone", () => {
  it("formats a US number for reading", () => {
    expect(displayPhone("+13125551234")).toBe("(312) 555-1234");
  });

  it("leaves an international number alone", () => {
    expect(displayPhone("+442071234567")).toBe("+442071234567");
  });

  it("handles a missing number", () => {
    expect(displayPhone(null)).toBeNull();
  });
});

describe("specialDateLabel", () => {
  it("calls a feast day a name day, which is what people say", () => {
    expect(specialDateLabel("FEAST_DAY")).toBe("Name Day");
    expect(specialDateLabel("BIRTHDAY")).toBe("Birthday");
    expect(specialDateLabel("ANNIVERSARY")).toBe("Wedding Anniversary");
  });
});

describe("specialDateDetail", () => {
  it("shows an age when the person opted in", () => {
    expect(specialDateDetail({ type: "BIRTHDAY", yearCount: 41 })).toBe("Turning 41");
  });

  it("says nothing when they did not", () => {
    expect(specialDateDetail({ type: "BIRTHDAY", yearCount: null })).toBeNull();
  });

  it("pluralises anniversary years", () => {
    expect(specialDateDetail({ type: "ANNIVERSARY", yearCount: 1 })).toBe("1 year married");
    expect(specialDateDetail({ type: "ANNIVERSARY", yearCount: 16 })).toBe("16 years married");
  });

  it("uses the patron saint for a name day", () => {
    expect(specialDateDetail({ type: "FEAST_DAY", patronSaint: "St. Anna" })).toBe("St. Anna");
    expect(specialDateDetail({ type: "FEAST_DAY", patronSaint: null })).toBeNull();
  });
});

describe("specialDateRuleText", () => {
  it("says nothing for a fixed date", () => {
    expect(specialDateRuleText({ rule: null })).toBeNull();
  });

  it("names the rule for a moving name day", () => {
    expect(
      specialDateRuleText({
        rule: { reference: "PASCHA", direction: "AFTER", unit: "WEEKDAY", count: 1, weekday: 0 },
      })
    ).toBe("1st Sunday after Pascha");
  });
});

describe("specialDateDateText", () => {
  it("formats a fixed date exactly as formatMonthDay does", () => {
    expect(specialDateDateText({ month: 5, day: 4, year: null, rule: null })).toBe("May 4");
    expect(specialDateDateText({ month: 5, day: 4, year: 1985, rule: null })).toBe("May 4, 1985");
  });

  it("resolves a moving date to its next occurrence, with the year shown", () => {
    const rule = {
      reference: "PASCHA" as const,
      direction: "AFTER" as const,
      unit: "WEEKDAY" as const,
      count: 1,
      weekday: 0,
    };
    // Pascha 2026-04-12, so Thomas Sunday is 2026-04-19.
    expect(specialDateDateText({ month: null, day: null, year: null, rule }, "2026-01-01")).toBe(
      "April 19, 2026"
    );
  });

  it("counts today itself as the next occurrence", () => {
    const rule = {
      reference: "PASCHA" as const,
      direction: "AFTER" as const,
      unit: "DAYS" as const,
      count: 0,
      weekday: null,
    };
    expect(specialDateDateText({ month: null, day: null, year: null, rule }, "2026-04-12")).toBe(
      "April 12, 2026"
    );
  });

  it("moves on to next year's occurrence once this year's has passed", () => {
    const rule = {
      reference: "PASCHA" as const,
      direction: "AFTER" as const,
      unit: "WEEKDAY" as const,
      count: 1,
      weekday: 0,
    };
    // Thomas Sunday 2026 is 2026-04-19; asking the day after should resolve to
    // Thomas Sunday 2027, which is Pascha 2027 (2027-05-02) plus 7 days.
    expect(specialDateDateText({ month: null, day: null, year: null, rule }, "2026-04-20")).toBe(
      "May 9, 2027"
    );
  });
});

describe("specialDatePartner", () => {
  const anniversary = {
    personId: "paul",
    personName: "Paul Schlueter",
    relatedPersonId: "sarah",
    relatedPersonName: "Sarah Schlueter",
  };

  it("names whoever is not the person whose page it is, with their id to link to", () => {
    expect(specialDatePartner(anniversary, "paul")).toEqual({
      id: "sarah",
      name: "Sarah Schlueter",
    });
    expect(specialDatePartner(anniversary, "sarah")).toEqual({
      id: "paul",
      name: "Paul Schlueter",
    });
  });

  it("says nothing for a date that links no one", () => {
    expect(
      specialDatePartner({ ...anniversary, relatedPersonId: null, relatedPersonName: null }, "paul")
    ).toBeNull();
  });

  it("says nothing when the linked person has no name to show", () => {
    expect(specialDatePartner({ ...anniversary, relatedPersonName: null }, "paul")).toBeNull();
  });
});

describe("formatMonthDay", () => {
  it("omits the year when there is not one", () => {
    expect(formatMonthDay(5, 4)).toBe("May 4");
    expect(formatMonthDay(5, 4, 1985)).toBe("May 4, 1985");
    expect(formatMonthDay(5, 4, null)).toBe("May 4");
  });
});

describe("addresses", () => {
  const person = {
    addressLine1: "4129 W Newport Ave",
    addressLine2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60641",
    country: null,
  };

  it("splits a multi-line address without leaving blank lines", () => {
    expect(formatMultilineAddress(person)).toEqual(["4129 W Newport Ave", "Chicago IL 60641"]);
    expect(formatMultilineAddress({})).toEqual([]);
  });

  it("puts the same fields on one line for a maps query", () => {
    // Asserted from the same fixture as the multi-line form, so the two cannot
    // drift on which fields count or in what order.
    expect(formatSingleLineAddress(person)).toBe("4129 W Newport Ave, Chicago IL 60641");
    expect(formatSingleLineAddress({})).toBe("");
  });

  it("will not map an address with no street, which resolves to nowhere useful", () => {
    expect(hasMappableAddress(person)).toBe(true);
    expect(hasMappableAddress({ city: "Chicago", state: "IL" })).toBe(false);
    expect(hasMappableAddress({ addressLine1: "   " })).toBe(false);
    expect(hasMappableAddress({})).toBe(false);
  });
});

describe("initials", () => {
  it("uses first and last initials", () => {
    expect(initials({ firstName: "Paul", lastName: "Schlueter" })).toBe("PS");
  });

  it("copes with no last name", () => {
    expect(initials({ firstName: "Anna", lastName: null })).toBe("A");
  });
});

describe("formatMonthDayShort", () => {
  it("abbreviates the month to three letters", () => {
    expect(formatMonthDayShort(9, 6)).toBe("Sep 6");
    expect(formatMonthDayShort(6, 14)).toBe("Jun 14");
  });

  it("covers every month", () => {
    expect(Array.from({ length: 12 }, (_, i) => formatMonthDayShort(i + 1, 1))).toEqual([
      "Jan 1",
      "Feb 1",
      "Mar 1",
      "Apr 1",
      "May 1",
      "Jun 1",
      "Jul 1",
      "Aug 1",
      "Sep 1",
      "Oct 1",
      "Nov 1",
      "Dec 1",
    ]);
  });

  it("is shorter than the full form for every month but the three-letter ones", () => {
    // The whole reason it exists: the pill has to fit beside a name.
    expect(formatMonthDayShort(9, 6).length).toBeLessThan(formatMonthDay(9, 6).length);
  });
});

describe("formatPostedAt", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("reads a fresh post as just now", () => {
    expect(formatPostedAt(ago(0), now)).toBe("Just now");
    expect(formatPostedAt(ago(30_000), now)).toBe("Just now");
  });

  it("does not go negative when the browser clock is behind the server's", () => {
    expect(formatPostedAt(new Date(now.getTime() + 5 * MINUTE).toISOString(), now)).toBe(
      "Just now"
    );
  });

  it("counts minutes, then hours, and gets the singular right", () => {
    expect(formatPostedAt(ago(MINUTE), now)).toBe("1 minute ago");
    expect(formatPostedAt(ago(45 * MINUTE), now)).toBe("45 minutes ago");
    expect(formatPostedAt(ago(HOUR), now)).toBe("1 hour ago");
    expect(formatPostedAt(ago(5 * HOUR), now)).toBe("5 hours ago");
  });

  it("names yesterday, then counts days up to a week", () => {
    expect(formatPostedAt(ago(DAY), now)).toBe("Yesterday");
    expect(formatPostedAt(ago(3 * DAY), now)).toBe("3 days ago");
    expect(formatPostedAt(ago(6 * DAY), now)).toBe("6 days ago");
  });

  it("gives way to a date past a week, where counting back stops helping", () => {
    // The one-month window means the oldest thing on the page is ~30 days old,
    // and "27 days ago" is not something anyone converts to a date in their head.
    expect(formatPostedAt(ago(10 * DAY), now)).not.toMatch(/ago/);
    expect(formatPostedAt(ago(10 * DAY), now)).toMatch(/2[45]/);
  });
});

/**
 * The names-and-overflow tail of a member preview.
 *
 * Shared by the families list and the map's pins, which disagree about what
 * count belongs in front of it -- so this deliberately has no count of its own.
 * The arithmetic is the bit worth pinning: `total` is the real number of
 * people, which may be larger than the names the caller was handed, because the
 * families endpoint caps them server-side.
 */
describe("memberPreview", () => {
  it("lists everybody when they fit", () => {
    expect(memberPreview(["Anna", "Boris"], 2)).toBe("Anna, Boris");
  });

  it("lists exactly the cap without an overflow", () => {
    expect(memberPreview(["Anna", "Boris", "Dmitri"], 3)).toBe("Anna, Boris, Dmitri");
  });

  it("counts the people it did not name", () => {
    expect(memberPreview(["Anna", "Boris", "Dmitri", "Elena"], 4)).toBe("Anna, Boris, Dmitri +1");
  });

  it("counts against the real total, not the names it was given", () => {
    // The families endpoint sends three names for a family of six.
    expect(memberPreview(["Anna", "Boris", "Dmitri"], 6)).toBe("Anna, Boris, Dmitri +3");
  });

  it("takes a different cap", () => {
    expect(memberPreview(["Anna", "Boris", "Dmitri"], 3, 1)).toBe("Anna +2");
  });

  it("says nothing about nobody", () => {
    expect(memberPreview([], 0)).toBe("");
  });

  it("can count people it has no names for at all", () => {
    expect(memberPreview([], 3)).toBe("+3");
  });

  it("does not invent a negative overflow", () => {
    // A total behind the names is a caller bug, not something to render.
    expect(memberPreview(["Anna", "Boris"], 1)).toBe("Anna, Boris");
  });
});

describe("chat days", () => {
  const now = new Date(2026, 9, 10, 1, 0); // 10 Oct 2026, 1am local

  it("names today and yesterday by calendar day, not by 24-hour span", () => {
    expect(formatChatDay(new Date(2026, 9, 10, 0, 30).toISOString(), now)).toBe("Today");
    // 11pm last night is only two hours ago, but it is yesterday.
    expect(formatChatDay(new Date(2026, 9, 9, 23, 0).toISOString(), now)).toBe("Yesterday");
  });

  it("uses the weekday inside the past week and a date after it", () => {
    const threeDays = new Date(2026, 9, 7, 12, 0);
    expect(formatChatDay(threeDays.toISOString(), now)).toBe(
      threeDays.toLocaleDateString(undefined, { weekday: "long" })
    );
    expect(formatChatDay(new Date(2026, 8, 1, 12, 0).toISOString(), now)).toMatch(/September/);
  });

  it("includes the year for a different year", () => {
    expect(formatChatDay(new Date(2025, 2, 3, 12, 0).toISOString(), now)).toMatch(/2025/);
  });

  it("localDayIso uses the local date, not UTC", () => {
    expect(localDayIso(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(localDayIso(new Date(2026, 11, 31, 23, 55))).toBe("2026-12-31");
  });
});

describe("event times", () => {
  it("reads 24-hour times as 12-hour", () => {
    expect(formatTime12("18:30")).toBe("6:30 PM");
    expect(formatTime12("00:05")).toBe("12:05 AM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
    expect(formatTime12("nonsense")).toBe("nonsense");
  });

  it("shares the AM/PM when both ends are in the same half of the day", () => {
    expect(formatEventTimes("18:30", "20:00")).toBe("6:30 – 8:00 PM");
    expect(formatEventTimes("11:00", "13:00")).toBe("11:00 AM – 1:00 PM");
  });

  it("handles a start with no end, and no times at all", () => {
    expect(formatEventTimes("09:00", null)).toBe("9:00 AM");
    expect(formatEventTimes(null, null)).toBeNull();
  });
});
