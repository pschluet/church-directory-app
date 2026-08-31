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

function renderCard(overrides: Partial<PersonSummaryDto> = {}) {
  const { container } = render(
    <MemoryRouter>
      <PersonCard person={person(overrides)} />
    </MemoryRouter>
  );
  return container;
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

  it("keeps the height of its text column either way", () => {
    // The mechanism, since jsdom does no layout: a fixed-height column with the
    // lines centred in it, rather than a column that shrinks to its content.
    expect(textColumn(renderCard())).toBeInTheDocument();
    expect(textColumn(renderCard({ familyName: null, phone: null }))).toBeInTheDocument();
  });
});
