import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuditChanges, humanizeField } from "../src/components/AuditChanges";

/**
 * `audit_log.changes` is untyped jsonb and every call site passes its own
 * shape, so what this component does is dispatch on shape. These are the four
 * branches, and the one distinction that matters most: a payload is not a diff,
 * and must not be presented as one.
 */
describe("AuditChanges", () => {
  it("says so when nothing was recorded", () => {
    render(<AuditChanges changes={null} />);
    expect(screen.getByText(/no details were recorded/i)).toBeInTheDocument();
  });

  describe("a genuine before and after", () => {
    it("renders a bare {from, to} as a change", () => {
      render(<AuditChanges changes={{ from: "old@example.com", to: "new@example.com" }} />);

      expect(screen.getByText("Changes")).toBeInTheDocument();
      expect(screen.getByText("old@example.com")).toBeInTheDocument();
      expect(screen.getByText("new@example.com")).toBeInTheDocument();
      // The arrow is decorative; this is what a screen reader gets instead.
      expect(screen.getByText("changed to")).toBeInTheDocument();
    });

    it("renders an object of {from, to} values as changes", () => {
      render(
        <AuditChanges
          changes={{
            phone: { from: "+13125551234", to: "+13125559999" },
            city: { from: "Chicago", to: "Evanston" },
          }}
        />
      );

      expect(screen.getByText("Changes")).toBeInTheDocument();
      expect(screen.getByText("Phone")).toBeInTheDocument();
      expect(screen.getByText("Evanston")).toBeInTheDocument();
    });

    /*
     * A {from, to} sitting among ordinary fields is not a diff of anything, and
     * showing it as one would invent a before value for every other field.
     */
    it("does not treat a mixed object as a diff", () => {
      render(<AuditChanges changes={{ name: "Popov", note: { from: "a", to: "b" } }} />);
      expect(screen.queryByText("Changes")).not.toBeInTheDocument();
    });
  });

  describe("a submitted payload", () => {
    /*
     * The common case, and the reason for the wording. The update handlers pass
     * `changes: payload` -- the new state, with no record of the old -- so
     * calling this "Changes" and laying it out as a diff would show a reader
     * something the data does not contain.
     */
    it("is labelled as submitted values, not as changes", () => {
      render(<AuditChanges changes={{ firstName: "Maria", lastName: "Schlueter" }} />);

      expect(screen.getByText("Submitted values")).toBeInTheDocument();
      expect(screen.queryByText("Changes")).not.toBeInTheDocument();
      // The note under this heading said the same thing on every row -- the
      // previous values are recorded for no action at all -- so the heading
      // carries it alone.
      expect(screen.queryByText(/previous values were not recorded/i)).not.toBeInTheDocument();
    });

    it("formats the values the way the rest of the app does", () => {
      render(
        <AuditChanges
          changes={{
            phone: "+13125551234",
            showYearCount: true,
            inheritEmail: false,
            birthDate: "1985-05-04",
            patronSaint: null,
            yearCount: 16,
          }}
        />
      );

      expect(screen.getByText("(312) 555-1234")).toBeInTheDocument();
      expect(screen.getByText("Yes")).toBeInTheDocument();
      expect(screen.getByText("No")).toBeInTheDocument();
      expect(screen.getByText("May 4, 1985")).toBeInTheDocument();
      expect(screen.getByText("16")).toBeInTheDocument();
      // Clearing a value is a real thing to have done, so it reads as one.
      expect(screen.getByText("not set")).toBeInTheDocument();
    });
  });

  describe("ids resolved to names", () => {
    const PERSON_ID = "11111111-1111-4111-8111-111111111111";

    it("renders a resolved uuid as a name, with the raw id in the title", () => {
      render(
        <AuditChanges
          changes={{ personId: PERSON_ID }}
          references={{ [PERSON_ID]: { label: "Maria Schlueter", type: "person" } }}
        />
      );

      const name = screen.getByText("Maria Schlueter");
      expect(name).toBeInTheDocument();
      expect(name.closest("span")).toHaveAttribute("title", PERSON_ID);
      expect(screen.queryByText(PERSON_ID)).not.toBeInTheDocument();
    });

    it("renders an unresolved uuid verbatim", () => {
      render(<AuditChanges changes={{ personId: PERSON_ID }} references={{}} />);
      expect(screen.getByText(PERSON_ID)).toBeInTheDocument();
    });

    it("renders an array of ids as a numbered list of names", () => {
      const other = "22222222-2222-4222-8222-222222222222";
      render(
        <AuditChanges
          changes={{ personIds: [PERSON_ID, other] }}
          references={{
            [PERSON_ID]: { label: "Maria Schlueter", type: "person" },
            [other]: { label: "Paul Schlueter", type: "person" },
          }}
        />
      );

      const list = screen.getByRole("list");
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent)
      ).toEqual(["Maria Schlueter", "Paul Schlueter"]);
    });
  });

  describe("known enum values", () => {
    /*
     * Field and value must both match. A `role` of "ADMIN" is a real role; a
     * `note` that happens to read "ADMIN" is somebody's free text, and the
     * field name is the only thing that tells the two apart.
     */
    it("labels a known role but leaves free text with the same word alone", () => {
      render(<AuditChanges changes={{ role: "ADMIN", note: "ADMIN" }} />);
      expect(screen.getByText("Administrator")).toBeInTheDocument();
      expect(screen.getByText("ADMIN")).toBeInTheDocument();
    });

    it("leaves an unrecognised role as the raw string", () => {
      render(<AuditChanges changes={{ role: "WIZARD" }} />);
      expect(screen.getByText("WIZARD")).toBeInTheDocument();
    });
  });

  describe("hidden fields", () => {
    it("hides placeId from the layout but keeps it in the raw details", async () => {
      const user = userEvent.setup();
      render(<AuditChanges changes={{ addressLine1: "1 Main St", placeId: "ChIJabc123" }} />);

      expect(screen.getByText("Address line 1")).toBeInTheDocument();
      expect(screen.queryByText("ChIJabc123")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /show raw details/i }));
      expect(screen.getByText(/"placeId"/)).toBeInTheDocument();
    });
  });

  describe("the raw details escape hatch", () => {
    it("is offered for a flat payload too, not only when nothing else could render", async () => {
      const user = userEvent.setup();
      render(<AuditChanges changes={{ firstName: "Maria" }} />);

      expect(screen.getByText("Submitted values")).toBeInTheDocument();
      const button = screen.getByRole("button", { name: /show raw details/i });
      await user.click(button);
      expect(screen.getByText(/"firstName"/)).toBeInTheDocument();
    });
  });

  describe("a shape with no layout", () => {
    /*
     * Nested and array payloads -- the merge result, a list of reordered ids.
     * They fall back to JSON rather than being partly rendered: showing four of
     * six fields and dropping the rest would be worse than showing all of it
     * plainly, on a page whose only job is to be complete.
     */
    it("offers the raw JSON, collapsed", async () => {
      const user = userEvent.setup();
      render(<AuditChanges changes={{ personIds: ["a", "b"], nested: { deep: 1 } }} />);

      expect(screen.getByText("Details")).toBeInTheDocument();
      expect(screen.queryByText(/personIds/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /show raw details/i }));
      expect(screen.getByText(/"personIds"/)).toBeInTheDocument();
    });

    it("falls back for a value that is not an object at all", () => {
      render(<AuditChanges changes={["a", "b"]} />);
      expect(screen.getByText("Details")).toBeInTheDocument();
    });

    it("falls back for an empty object rather than showing an empty list", () => {
      render(<AuditChanges changes={{}} />);
      expect(screen.getByText("Details")).toBeInTheDocument();
    });
  });
});

describe("humanizeField", () => {
  it("turns a camelCase field into a sentence", () => {
    expect(humanizeField("addressLine1")).toBe("Address line 1");
    expect(humanizeField("firstName")).toBe("First name");
    expect(humanizeField("mapViewEnabled")).toBe("Map view enabled");
  });

  it("uses the override for the ones it would get wrong", () => {
    expect(humanizeField("e164")).toBe("Phone number");
    expect(humanizeField("patronSaint")).toBe("Patron saint");
    // The value renders as a name (see the uuid tests below), so a label
    // ending in "id" would be wrong even though it is what the generic path
    // would produce.
    expect(humanizeField("inheritLastNameFromPersonId")).toBe("Surname taken from");
  });
});
