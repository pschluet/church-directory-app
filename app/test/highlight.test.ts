import { describe, expect, it } from "vitest";
import { searchTerms } from "@shared";
import { excerpt, highlightRanges, matchesTerm, phoneRanges } from "../src/lib/highlight";

/** What the marks would read, which is what the assertions are really about. */
function marked(text: string, terms: string[]): string[] {
  return highlightRanges(text, terms).map((range) => text.slice(range.start, range.end));
}

describe("searchTerms", () => {
  it("splits on whitespace the way the search route does", () => {
    expect(searchTerms("smith chicago")).toEqual(["smith", "chicago"]);
    expect(searchTerms("  smith   chicago  ")).toEqual(["smith", "chicago"]);
  });

  it("has no terms at all for an empty query", () => {
    // "".split(/\s+/) is [""], which would match every field of every person.
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("stops at eight, so nothing is highlighted that was not filtered on", () => {
    expect(searchTerms("a b c d e f g h i j")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("highlightRanges", () => {
  it("finds a term whatever case either side is in", () => {
    expect(marked("Maria Ivanova", ["ivan"])).toEqual(["Ivan"]);
    expect(marked("maria IVANOVA", ["ivan"])).toEqual(["IVAN"]);
  });

  it("finds every occurrence", () => {
    expect(highlightRanges("Anna Ivanova", ["a"])).toHaveLength(4);
  });

  it("has nothing to mark without terms, or without text", () => {
    expect(highlightRanges("Maria Ivanova", [])).toEqual([]);
    expect(highlightRanges("", ["ivan"])).toEqual([]);
    expect(highlightRanges(null, ["ivan"])).toEqual([]);
  });

  it("merges two terms that overlap into one mark", () => {
    // Otherwise "Iva" and "van" would nest, and the second mark's negative
    // margin would show a seam inside the word.
    expect(marked("Ivanova", ["iva", "van"])).toEqual(["Ivan"]);
  });

  it("merges two terms that merely touch", () => {
    expect(marked("Ivanova", ["iva", "nova"])).toEqual(["Ivanova"]);
  });

  it("merges a term overlapping itself", () => {
    expect(marked("aaa", ["aa"])).toEqual(["aaa"]);
  });

  it("treats regex metacharacters as the literals somebody typed", () => {
    // A RegExp built from the query would match everything for "." and throw
    // outright for "(".
    expect(marked("100% Oak (rear) St.", ["."])).toEqual(["."]);
    expect(marked("100% Oak (rear) St.", ["%"])).toEqual(["%"]);
    expect(marked("100% Oak (rear) St.", ["(rear)"])).toEqual(["(rear)"]);
    expect(marked("100% Oak (rear) St.", ["+"])).toEqual([]);
  });
});

describe("matchesTerm", () => {
  it("ignores case and copes with a field nobody filled in", () => {
    expect(matchesTerm("Chicago", "chic")).toBe(true);
    expect(matchesTerm(null, "chic")).toBe(false);
    expect(matchesTerm(undefined, "chic")).toBe(false);
  });
});

describe("phoneRanges", () => {
  const PHONE = "+13125551234";
  /** displayPhone(PHONE) is "(312) 555-1234". */
  const shown = (terms: string[]) =>
    phoneRanges(PHONE, terms).map((r) => "(312) 555-1234".slice(r.start, r.end));

  it("marks a fragment that survived the formatting", () => {
    expect(shown(["312"])).toEqual(["312"]);
    expect(shown(["1234"])).toEqual(["1234"]);
  });

  it("marks across the separators when the digits line up", () => {
    // "5550140" is nowhere in "(312) 555-1234" as typed, but its digits are.
    expect(shown(["5551234"])).toEqual(["555-1234"]);
  });

  it("marks the whole number when the match is only in the stored form", () => {
    // `search_text` holds the E.164, so these are real matches with nothing
    // narrower to point at. Marking nothing would leave the card unexplained.
    expect(shown(["+1312"])).toEqual(["(312) 555-1234"]);
    expect(shown(["13125551234"])).toEqual(["(312) 555-1234"]);
  });

  it("marks nothing when the match was in some other field", () => {
    expect(shown(["chicago"])).toEqual([]);
    expect(phoneRanges(PHONE, [])).toEqual([]);
    expect(phoneRanges(null, ["312"])).toEqual([]);
  });

  it("falls back to the stored string for a number it cannot format", () => {
    // displayPhone leaves a non-US number as it found it, so the offsets are
    // straight into the E.164 string.
    expect(phoneRanges("+442071234567", ["2071"])).toEqual([{ start: 3, end: 7 }]);
  });
});

describe("excerpt", () => {
  const ADDRESS = "4129 W Newport Ave, Chicago IL 60641, United States";
  const slice = (out: { text: string; ranges: { start: number; end: number }[] }) =>
    out.ranges.map((r) => out.text.slice(r.start, r.end));

  it("leaves anything that already fits alone", () => {
    const ranges = highlightRanges("4129 W Newport Ave", ["newport"]);
    const out = excerpt("4129 W Newport Ave", ranges, 44);
    expect(out.text).toBe("4129 W Newport Ave");
    expect(out.ranges).toEqual(ranges);
  });

  it("windows a long value around the match, and keeps the mark on it", () => {
    const out = excerpt(ADDRESS, highlightRanges(ADDRESS, ["united"]), 44);

    expect(out.text.length).toBeLessThanOrEqual(45);
    expect(out.text.startsWith("…")).toBe(true);
    // The point of the whole exercise: the reason the card is on screen is
    // still on screen.
    expect(slice(out)).toEqual(["United"]);
  });

  it("does not window when the match is already near the front", () => {
    const out = excerpt(ADDRESS, highlightRanges(ADDRESS, ["4129"]), 44);
    expect(out.text.startsWith("…")).toBe(false);
    expect(out.text.endsWith("…")).toBe(true);
    expect(slice(out)).toEqual(["4129"]);
  });

  it("truncates plainly when there is no match to centre on", () => {
    const out = excerpt(ADDRESS, [], 20);
    expect(out.text).toBe("4129 W Newport Ave,…");
    expect(out.ranges).toEqual([]);
  });
});
