import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InheritableAttribute, PersonSummaryDto } from "@shared";
import { InheritToggle, inheritanceCandidates } from "../src/components/InheritToggle";

function person(id: string, firstName: string, lastName: string | null): PersonSummaryDto {
  return {
    id,
    organizationId: "org",
    familyId: "fam",
    familyName: "Schlueter",
    appUserId: null,
    firstName,
    lastName,
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
  };
}

const paul = person("paul", "Paul", "Schlueter");
const maria = person("maria", "Maria", "Schlueter");

describe("InheritToggle", () => {
  it("disables the picker until inheriting is switched on", () => {
    render(
      <InheritToggle
        attribute="address"
        label="address"
        candidates={[paul, maria]}
        sourceId={null}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: /whose address to use/i })).toBeDisabled();
  });

  it("defaults to the first family member when switched on", async () => {
    const onChange = vi.fn();
    render(
      <InheritToggle
        attribute="address"
        label="address"
        candidates={[paul, maria]}
        sourceId={null}
        onChange={onChange}
      />
    );

    await userEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith("paul");
  });

  it("clears the source when switched off", async () => {
    const onChange = vi.fn();
    render(
      <InheritToggle
        attribute="address"
        label="address"
        candidates={[paul, maria]}
        sourceId="paul"
        onChange={onChange}
      />
    );

    await userEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("lets a different family member be chosen", async () => {
    const onChange = vi.fn();
    render(
      <InheritToggle
        attribute="address"
        label="address"
        candidates={[paul, maria]}
        sourceId="paul"
        onChange={onChange}
      />
    );

    await userEvent.selectOptions(screen.getByRole("combobox"), "maria");
    expect(onChange).toHaveBeenCalledWith("maria");
  });

  it("renders nothing when there is nobody to inherit from", () => {
    const { container } = render(
      <InheritToggle
        attribute="address"
        label="address"
        candidates={[]}
        sourceId={null}
        onChange={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("inheritanceCandidates", () => {
  const family = [paul, maria, person("anna", "Anna", null)];

  it("excludes the person themselves", () => {
    const result = inheritanceCandidates("address", "paul", family, new Map());
    expect(result.map((p) => p.id)).toEqual(["maria", "anna"]);
  });

  it("excludes anyone already inheriting the same attribute, so no chain forms", () => {
    // Anna already takes her address from Paul, so inheriting *hers* would be a
    // second hop -- which the API rejects and which could form a cycle.
    const inheriting = new Map<string, Set<InheritableAttribute>>([
      ["anna", new Set<InheritableAttribute>(["address"])],
    ]);
    const result = inheritanceCandidates("address", "maria", family, inheriting);
    expect(result.map((p) => p.id)).toEqual(["paul"]);
  });

  it("only excludes them for that one attribute", () => {
    const inheriting = new Map<string, Set<InheritableAttribute>>([
      ["anna", new Set<InheritableAttribute>(["address"])],
    ]);
    const result = inheritanceCandidates("email", "maria", family, inheriting);
    expect(result.map((p) => p.id)).toEqual(["paul", "anna"]);
  });
});
