import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialDateForm } from "../src/components/SpecialDateForm";

const candidates = [
  {
    id: "spouse-id",
    organizationId: "org",
    familyId: "fam",
    familyName: "Schlueter",
    appUserId: "user",
    firstName: "Maria",
    lastName: "Schlueter",
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
    canEdit: false,
  },
];

function renderForm() {
  return render(
    <SpecialDateForm
      personId="person-id"
      candidates={candidates}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

/**
 * The year field is the only textbox on the form (month and day are selects),
 * so query it by role: a text match on /year/i also hits the age checkbox's
 * "enter a year first" help text.
 */
const yearInput = () => screen.getByRole("textbox", { name: /year/i });

describe("SpecialDateForm", () => {
  it("keeps the age checkbox disabled until a year is entered", async () => {
    renderForm();

    const checkbox = screen.getByRole("checkbox", { name: /show my age/i });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/enter a year first/i)).toBeInTheDocument();

    await userEvent.type(yearInput(), "1985");

    expect(checkbox).toBeEnabled();
    expect(screen.getByText(/off by default/i)).toBeInTheDocument();
  });

  it("clearing the year turns the age option back off", async () => {
    renderForm();
    const year = yearInput();
    await userEvent.type(year, "1985");
    await userEvent.click(screen.getByRole("checkbox", { name: /show my age/i }));
    expect(screen.getByRole("checkbox", { name: /show my age/i })).toBeChecked();

    await userEvent.clear(year);
    expect(screen.getByRole("checkbox", { name: /show my age/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /show my age/i })).toBeDisabled();
  });

  it("asks who the anniversary is with, and requires a year", async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByLabelText(/occasion/i), "ANNIVERSARY");

    expect(screen.getByLabelText(/married to/i)).toBeRequired();
    expect(yearInput()).toBeRequired();
    expect(screen.getByText(/links the two of you/i)).toBeInTheDocument();
  });

  it("drops the year entirely for a name day", async () => {
    renderForm();
    await userEvent.type(yearInput(), "1985");
    await userEvent.selectOptions(screen.getByLabelText(/occasion/i), "FEAST_DAY");

    expect(screen.queryByRole("textbox", { name: /year/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /show/i })).not.toBeInTheDocument();
    expect(screen.getByText(/patron saint/i)).toBeInTheDocument();
  });

  it("offers 29 February for a recurring date but not in a common year", async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByLabelText(/month/i), "2");

    // No year given: the date recurs, so the 29th is valid.
    expect(screen.getByRole("option", { name: "29" })).toBeInTheDocument();

    await userEvent.type(yearInput(), "2027");
    expect(screen.queryByRole("option", { name: "29" })).not.toBeInTheDocument();

    await userEvent.clear(yearInput());
    await userEvent.type(yearInput(), "2028");
    expect(screen.getByRole("option", { name: "29" })).toBeInTheDocument();
  });

  it("never offers 31 April", async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByLabelText(/month/i), "4");
    expect(screen.getByRole("option", { name: "30" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "31" })).not.toBeInTheDocument();
  });
});
