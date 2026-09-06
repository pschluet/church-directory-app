import { describe, expect, it } from "vitest";
import {
  displayPhone,
  formatMonthDay,
  formatMonthDayShort,
  formatMultilineAddress,
  formatPostedAt,
  formatSingleLineAddress,
  hasMappableAddress,
  initials,
  specialDateDetail,
  specialDateLabel,
  specialDatePartner,
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
