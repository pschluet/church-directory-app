import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import type { FamilyAnniversaryDto, FamilyMemberDto } from "@shared";
import { FamilyMemberList, move } from "../src/components/FamilyMemberList";

/**
 * `window.matchMedia` is stubbed to report no match (see test/setup.ts), so
 * every case here exercises the phone layout -- the compact rows. That is the
 * deliberate default: it is the layout the whole page is designed around, and
 * the tile variant differs only in its markup, not in what it shows.
 */

function member(overrides: Partial<FamilyMemberDto> & { id: string; firstName: string }) {
  return {
    organizationId: "org-1",
    familyId: "fam-1",
    familyName: "Haddad",
    appUserId: "user-x",
    lastName: "Haddad",
    email: null,
    phone: null,
    altPhone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    patronSaint: null,
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    canEdit: true,
    age: null,
    ...overrides,
  } as unknown as FamilyMemberDto;
}

const PAUL = member({ id: "p1", firstName: "Paul", age: 41, patronSaint: "St. Paul" });
const SARAH = member({ id: "p2", firstName: "Sarah", age: 39, patronSaint: "St. Anne" });
const ANNA = member({ id: "p3", firstName: "Anna", appUserId: null, age: 12 });
const LUKE = member({ id: "p4", firstName: "Luke", appUserId: null });

const MARRIED: FamilyAnniversaryDto = {
  personIds: ["p1", "p2"],
  month: 6,
  day: 14,
  yearCount: 16,
};

function renderList(props: Partial<Parameters<typeof FamilyMemberList>[0]> = {}) {
  const onRemove = vi.fn();
  const onReorder = vi.fn();
  renderWithProviders(
    <FamilyMemberList
      members={[PAUL, SARAH, ANNA, LUKE]}
      anniversaries={[]}
      canEdit
      myPersonId="p1"
      onRemove={onRemove}
      onReorder={onReorder}
      {...props}
    />
  );
  return { onRemove, onReorder };
}

describe("FamilyMemberList", () => {
  describe("what it shows about each member", () => {
    it("shows the name, the age and the patron saint", () => {
      renderList();

      expect(screen.getByText("Paul Haddad")).toBeInTheDocument();
      expect(screen.getByText("41")).toBeInTheDocument();
      expect(screen.getByText("St. Paul")).toBeInTheDocument();
    });

    it("says nothing at all where there is no age", () => {
      renderList({ members: [LUKE] });

      expect(screen.getByText("Luke Haddad")).toBeInTheDocument();
      // An absent age has to read as trimmed, not as a hole with a dash in it.
      expect(screen.queryByText("—")).not.toBeInTheDocument();
      expect(screen.queryByText("null")).not.toBeInTheDocument();
    });

    it("links each member to their own page", () => {
      renderList();

      expect(screen.getByRole("link", { name: /Paul Haddad/ })).toHaveAttribute(
        "href",
        "/people/p1"
      );
    });

    it("still marks who has no account of their own", () => {
      renderList();
      expect(screen.getAllByText("No account")).toHaveLength(2);
    });

    it("never abbreviates a name, however much else the row carries", () => {
      // The worst case: a long name, an age, an anniversary and no account, all
      // on one member. Every one of these used to compete with the name for a
      // single line.
      const crowded = member({
        id: "p9",
        firstName: "Konstantina",
        lastName: "Papadopoulou-Nasser",
        appUserId: null,
        age: 38,
        patronSaint: "St. Konstantina",
      });
      renderList({
        members: [crowded],
        anniversaries: [{ personIds: ["p9", "p1"], month: 6, day: 14, yearCount: 12 }],
      });

      const name = screen.getByText("Konstantina Papadopoulou-Nasser");
      expect(name).toBeInTheDocument();
      // `truncate` is what clipped it: overflow-hidden plus text-ellipsis.
      expect(name.className).not.toMatch(/truncate/);
    });

    it("keeps the name on a line of its own, sharing it only with the age", () => {
      renderList({ members: [PAUL], anniversaries: [] });

      const nameLine = screen.getByText("Paul Haddad").parentElement;
      // The patron saint and any pills belong to the second line, not this one.
      expect(nameLine?.textContent).toBe("Paul Haddad41");
    });

    it("keeps the family's order rather than sorting it again", () => {
      renderList({ members: [LUKE, ANNA, PAUL] });

      const names = screen.getAllByRole("link").map((link) => link.textContent);
      expect(names[0]).toContain("Luke");
      expect(names[1]).toContain("Anna");
      expect(names[2]).toContain("Paul");
    });
  });

  describe("marking the couple", () => {
    it("puts the same badge on both spouses and on nobody else", () => {
      renderList({ anniversaries: [MARRIED] });

      // The visible pill is the date; the label spells the rest out.
      expect(screen.getAllByText("Jun 14")).toHaveLength(2);
      expect(screen.getByText(/Married to Sarah, 16 years/)).toBeInTheDocument();
      expect(screen.getByText(/Married to Paul, 16 years/)).toBeInTheDocument();
    });

    it("marks the pair without the years when they did not opt in", () => {
      renderList({ anniversaries: [{ ...MARRIED, yearCount: null }] });

      expect(screen.getAllByText("Jun 14")).toHaveLength(2);
      expect(screen.getByText(/Married to Sarah, anniversary/)).toBeInTheDocument();
      expect(screen.queryByText(/16 years/)).not.toBeInTheDocument();
    });

    it("says year rather than years for a first anniversary", () => {
      renderList({ anniversaries: [{ ...MARRIED, yearCount: 1 }] });

      expect(screen.getByText(/Married to Sarah, 1 year,/)).toBeInTheDocument();
    });

    it("marks two couples in one family separately", () => {
      renderList({
        anniversaries: [MARRIED, { personIds: ["p3", "p4"], month: 8, day: 2, yearCount: 3 }],
      });

      expect(screen.getAllByText("Jun 14")).toHaveLength(2);
      expect(screen.getAllByText("Aug 2")).toHaveLength(2);
    });

    it("ignores a couple whose other half is not in the list", () => {
      renderList({ anniversaries: [{ ...MARRIED, personIds: ["p1", "gone"] }] });

      expect(screen.queryByText("Jun 14")).not.toBeInTheDocument();
    });
  });

  describe("per-member actions", () => {
    it("hides them behind a menu rather than a button on every row", async () => {
      const { onRemove } = renderList();

      // Nothing on the row itself.
      expect(screen.queryByRole("button", { name: /remove from family/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /actions for Sarah Haddad/i }));
      await userEvent.click(screen.getByRole("menuitem", { name: /remove from family/i }));

      expect(onRemove).toHaveBeenCalledWith(SARAH);
    });

    it("calls it leaving when the member is the caller", async () => {
      renderList();
      await userEvent.click(screen.getByRole("button", { name: /actions for Paul Haddad/i }));

      expect(screen.getByRole("menuitem", { name: /leave this family/i })).toBeInTheDocument();
    });

    it("offers no menu and no handle to someone who cannot edit", () => {
      renderList({ canEdit: false });

      expect(screen.queryByRole("button", { name: /actions for/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reorder/i })).not.toBeInTheDocument();
      // The members themselves are still there to read.
      expect(screen.getByText("Paul Haddad")).toBeInTheDocument();
    });

    it("does not clip an open menu against the list box", () => {
      renderList();
      const list = screen.getByText("Paul Haddad").closest("ul");

      // `overflow-hidden` here would confine a row's menu to the list, and
      // focusing an item that sticks out would scroll this container -- sliding
      // the top row out of sight instead of letting the menu overhang.
      expect(list?.className).not.toMatch(/overflow-hidden/);
      // The rows round the corners the list can therefore no longer clip.
      const rows = [...(list?.children ?? [])];
      expect(rows[0]?.className).toMatch(/first:rounded-t-lg/);
      expect(rows[rows.length - 1]?.className).toMatch(/last:rounded-b-lg/);
    });

    it("gives every member a drag handle when the caller may rearrange them", () => {
      renderList();
      expect(screen.getAllByRole("button", { name: /^reorder /i })).toHaveLength(4);
    });
  });
});

describe("move", () => {
  it("moves an item down", () => {
    expect(move(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up", () => {
    expect(move(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves an item one place, which is what a keyboard drag does", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op when the item does not move", () => {
    expect(move(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  it("leaves the original array alone", () => {
    const original = ["a", "b", "c"];
    move(original, 0, 2);
    expect(original).toEqual(["a", "b", "c"]);
  });
});
