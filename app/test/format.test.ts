import { describe, expect, it } from "vitest";
import {
  displayPhone,
  formatAddress,
  formatMonthDay,
  formatMultilineAddress,
  initials,
  specialDateDetail,
  specialDateLabel,
  specialDatePartnerName,
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

describe("specialDatePartnerName", () => {
  const anniversary = {
    personId: "paul",
    personName: "Paul Schlueter",
    relatedPersonId: "sarah",
    relatedPersonName: "Sarah Schlueter",
  };

  it("names whoever is not the person whose page it is", () => {
    expect(specialDatePartnerName(anniversary, "paul")).toBe("Sarah Schlueter");
    expect(specialDatePartnerName(anniversary, "sarah")).toBe("Paul Schlueter");
  });

  it("says nothing for a date that links no one", () => {
    expect(
      specialDatePartnerName(
        { ...anniversary, relatedPersonId: null, relatedPersonName: null },
        "paul"
      )
    ).toBeNull();
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

  it("joins a one-line address, skipping what is missing", () => {
    expect(formatAddress(person)).toBe("4129 W Newport Ave · Chicago, IL · 60641");
    expect(formatAddress({ city: "Chicago" })).toBe("Chicago");
    expect(formatAddress({})).toBeNull();
  });

  it("splits a multi-line address without leaving blank lines", () => {
    expect(formatMultilineAddress(person)).toEqual(["4129 W Newport Ave", "Chicago IL 60641"]);
    expect(formatMultilineAddress({})).toEqual([]);
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
