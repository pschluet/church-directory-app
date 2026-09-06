import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { PersonCard } from "../src/components/PersonCard";

function person(overrides: Partial<PersonSummaryDto> = {}): PersonSummaryDto {
  return {
    id: "person-1",
    organizationId: "org-1",
    familyId: "fam-1",
    familyName: "Haddad",
    appUserId: "user-1",
    firstName: "Layla",
    lastName: "Haddad",
    email: "layla@example.com",
    phone: "+13125551234",
    altPhone: null,
    addressLine1: "4129 W Newport Ave",
    addressLine2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60641",
    country: null,
    patronSaint: "St. Anna",
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    canEdit: true,
    ...overrides,
  };
}

function renderCard(overrides: Partial<PersonSummaryDto> = {}, terms: string[] = []) {
  const { container } = render(
    <MemoryRouter>
      <PersonCard person={person(overrides)} terms={terms} />
    </MemoryRouter>
  );
  return container;
}

/** What the card has marked as matching, in the order it reads. */
function marks(container: HTMLElement): string[] {
  return [...container.querySelectorAll("mark")].map((mark) => mark.textContent ?? "");
}

/** The lines the card grew to explain a match, as "LABEL · value". */
function reveals(container: HTMLElement): string[] {
  return [...container.querySelectorAll("p.text-xs")].map((line) =>
    (line.textContent ?? "").replace(/\s+/g, " ").trim()
  );
}

/** The text column, whose height is fixed so cards line up in the grid. */
function textColumn(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".h-22");
}

describe("PersonCard", () => {
  it("shows the name, family and phone", () => {
    renderCard();

    expect(screen.getByRole("heading", { name: "Layla Haddad" })).toBeInTheDocument();
    expect(screen.getByText("Haddad family")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /call layla/i })).toHaveAttribute(
      "href",
      "tel:+13125551234"
    );
    expect(screen.queryByText("No account")).not.toBeInTheDocument();
  });

  it("leaves off everything else, so every card carries the same fields", () => {
    renderCard();

    expect(screen.queryByText(/newport/i)).not.toBeInTheDocument();
    expect(screen.queryByText("St. Anna")).not.toBeInTheDocument();
    expect(screen.queryByText("layla@example.com")).not.toBeInTheDocument();
  });

  it("flags a person with no account", () => {
    renderCard({ appUserId: null });
    expect(screen.getByText("No account")).toBeInTheDocument();
  });

  it("drops a line it cannot fill instead of leaving it blank", () => {
    renderCard({ familyName: null, phone: null });

    expect(screen.getByRole("heading", { name: "Layla Haddad" })).toBeInTheDocument();
    expect(screen.queryByText(/family/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /call/i })).not.toBeInTheDocument();
  });

  it("marks the typed fragment where it already appears", () => {
    const container = renderCard({}, ["hadd", "3125"]);

    // The name, the family line, and the phone. "3125" is nowhere in
    // "(312) 555-1234" as typed -- its digits had to be lined up against the
    // number's, and the bracket and space between them left unmarked.
    expect(marks(container)).toEqual(["Hadd", "Hadd", "312", "5"]);
    expect(reveals(container)).toEqual([]);
  });

  it("never marks the word it added itself", () => {
    // "family" is the card's own label, not a field the search looked at.
    expect(marks(renderCard({}, ["family"]))).toEqual([]);
  });

  it("reveals the field the search actually matched", () => {
    expect(reveals(renderCard({}, ["newport"]))).toEqual([
      "Address · 4129 W Newport Ave, Chicago…",
    ]);
    expect(reveals(renderCard({}, ["example.com"]))).toEqual(["Email · layla@example.com"]);
    expect(reveals(renderCard({}, ["anna"]))).toEqual(["Saint · St. Anna"]);
    expect(reveals(renderCard({ altPhone: "+13125559999" }, ["9999"]))).toEqual([
      "Other phone · (312) 555-9999",
    ]);
  });

  it("stays as it was when the name already explains the match", () => {
    expect(reveals(renderCard({}, ["layla"]))).toEqual([]);
    expect(textColumn(renderCard({}, ["layla"]))).toBeInTheDocument();
  });

  it("says an address once, however many terms landed in it", () => {
    // A line per term would spend both slots saying the same thing twice. The
    // window is anchored on the first of the two, so the postcode's own mark
    // can fall outside it -- the line is there to explain the card, not to
    // itemise every term that landed in the field.
    const container = renderCard({}, ["newport", "60641"]);
    expect(reveals(container)).toEqual(["Address · 4129 W Newport Ave, Chicago…"]);
    expect(marks(container)).toEqual(["Newport"]);
  });

  it("shows at most two lines, in a fixed order", () => {
    const container = renderCard({ email: "kyriaki@example.org", patronSaint: "St Demetrios" }, [
      "demetrios",
      "kyriaki",
      "newport",
    ]);

    // Address, Email, Saint is the order; the saint is the one dropped, so a
    // greedy record cannot inflate the whole grid row.
    expect(reveals(container)).toEqual([
      "Address · 4129 W Newport Ave, Chicago…",
      "Email · kyriaki@example.org",
    ]);
  });

  it("windows a long value so the mark is not truncated off-screen", () => {
    const container = renderCard({ country: "United States" }, ["united"]);
    expect(reveals(container)[0]).toBe("Address · …IL 60641, United States");
    expect(marks(container)).toEqual(["United"]);
  });

  it("gives up its fixed height only for a revealed line", () => {
    expect(textColumn(renderCard({}, ["newport"]))).not.toBeInTheDocument();
    expect(renderCard({}, ["newport"]).querySelector(".min-h-22")).toBeInTheDocument();
  });

  it("keeps the height of its text column either way", () => {
    // The mechanism, since jsdom does no layout: a fixed-height column with the
    // lines centred in it, rather than a column that shrinks to its content.
    expect(textColumn(renderCard())).toBeInTheDocument();
    expect(textColumn(renderCard({ familyName: null, phone: null }))).toBeInTheDocument();
  });
  /*
   * `persons_resolved.search_text` concatenates thirteen values and the search
   * route filters on all of them, so there are thirteen ways to land on this
   * card. `toSummary` carries every one of them into PersonSummaryDto, which is
   * what lets the card account for the match without another request -- and
   * this is the loop that holds the two lists to the same length. A field added
   * to the view and not to a group here would produce a result with nothing
   * marked on it.
   */
  const SEARCHED_FIELDS: { field: string; overrides: Partial<PersonSummaryDto>; term: string }[] = [
    { field: "first name", overrides: { firstName: "Perpetua" }, term: "perpet" },
    { field: "last name", overrides: { lastName: "Zographou" }, term: "zograph" },
    { field: "family name", overrides: { familyName: "Vlatadon" }, term: "vlatad" },
    { field: "email", overrides: { email: "kyriaki@example.org" }, term: "kyriaki" },
    { field: "phone", overrides: { phone: "+13125559876" }, term: "9876" },
    { field: "alt phone", overrides: { altPhone: "+13125550001" }, term: "0001" },
    { field: "address line 1", overrides: { addressLine1: "88 Tarasios Way" }, term: "tarasios" },
    { field: "address line 2", overrides: { addressLine2: "Apt Theotokos" }, term: "theotokos" },
    { field: "city", overrides: { city: "Thessaloniki" }, term: "thessal" },
    { field: "state", overrides: { state: "Illinois" }, term: "illinois" },
    { field: "postal code", overrides: { postalCode: "99501" }, term: "99501" },
    { field: "country", overrides: { country: "Greece" }, term: "greece" },
    { field: "patron saint", overrides: { patronSaint: "St Demetrios" }, term: "demetrios" },
  ];

  it.each(SEARCHED_FIELDS)("shows why it matched on the $field", ({ overrides, term }) => {
    const container = renderCard(overrides, [term]);

    const marked = marks(container).join(" ").toLowerCase();
    expect(marked).not.toBe("");
    expect(marked).toContain(term);
  });
});
