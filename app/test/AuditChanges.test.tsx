import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(humanizeField("inheritLastNameFromPersonId")).toBe("Inherit last name from person id");
  });

  it("uses the override for the ones it would get wrong", () => {
    expect(humanizeField("e164")).toBe("Phone number");
    expect(humanizeField("patronSaint")).toBe("Patron saint");
  });
});
