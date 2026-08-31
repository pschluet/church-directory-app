import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PersonDto, PersonSummaryDto } from "@shared";
import { PersonForm } from "../src/components/PersonForm";

const PERSON_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";
const HADDAD_ID = "33333333-3333-4333-8333-333333333333";
const NASSIF_ID = "44444444-4444-4444-8444-444444444444";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  ApiError: class ApiError extends Error {},
  DEV_AUTH: false,
}));

function summary(overrides: { id: string; firstName: string }): PersonSummaryDto {
  return {
    organizationId: "org-1",
    familyId: HADDAD_ID,
    familyName: "Haddad",
    appUserId: null,
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
    ...overrides,
  } as unknown as PersonSummaryDto;
}

const PARENT = summary({ id: PARENT_ID, firstName: "Layla" });

function person(overrides: Partial<PersonDto> = {}): PersonDto {
  return {
    ...summary({ id: PERSON_ID, firstName: "Anna" }),
    inheritedFrom: {},
    specialDates: [],
    ...overrides,
  } as PersonDto;
}

const FAMILIES = [
  { id: HADDAD_ID, name: "Haddad" },
  { id: NASSIF_ID, name: "Nassif" },
];

function renderForm(props: Partial<React.ComponentProps<typeof PersonForm>> = {}) {
  return render(
    <PersonForm person={person()} familyMembers={[PARENT]} onSaved={vi.fn()} {...props} />
  );
}

async function save() {
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
}

function lastBody(): Record<string, unknown> {
  const call = api.mock.calls.at(-1)!;
  return (call[1] as { body: Record<string, unknown> }).body;
}

describe("PersonForm", () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue(person());
  });

  it("offers no family picker, and never mentions familyId, without the list", async () => {
    renderForm();
    expect(screen.queryByLabelText(/^family/i)).not.toBeInTheDocument();

    await save();
    await waitFor(() => expect(api).toHaveBeenCalled());
    // The API treats the key being present as an instruction to move, so its
    // absence is the whole contract for a non-admin.
    expect(lastBody()).not.toHaveProperty("familyId");
  });

  it("shows the picker set to their current family when the list is supplied", async () => {
    renderForm({ families: FAMILIES });
    expect(screen.getByLabelText(/^family/i)).toHaveValue(HADDAD_ID);
  });

  it("sends the family unchanged when it was not touched", async () => {
    renderForm({ families: FAMILIES });
    await save();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().familyId).toBe(HADDAD_ID);
  });

  it("moves someone to another family", async () => {
    renderForm({ families: FAMILIES });
    await userEvent.selectOptions(screen.getByLabelText(/^family/i), NASSIF_ID);
    await save();

    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().familyId).toBe(NASSIF_ID);
  });

  it("sends null when they are taken out of every family", async () => {
    renderForm({ families: FAMILIES });
    await userEvent.selectOptions(screen.getByLabelText(/^family/i), "");
    await save();

    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().familyId).toBeNull();
  });

  it("drops inheritance on a move, because the API validates it against the destination", async () => {
    renderForm({
      person: person({
        inheritedFrom: { lastName: { personId: PARENT.id, name: "Layla Haddad" } },
      }),
      families: FAMILIES,
    });

    await userEvent.selectOptions(screen.getByLabelText(/^family/i), NASSIF_ID);

    // The toggles go read-only rather than offering sources from the old family.
    expect(screen.getByLabelText(/same last name as/i)).toBeDisabled();
    expect(screen.getByText(/save the move first/i)).toBeInTheDocument();

    await save();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({
      familyId: NASSIF_ID,
      inheritLastNameFromPersonId: null,
      inheritEmailFromPersonId: null,
      inheritAddressFromPersonId: null,
    });
  });

  it("keeps inheritance intact when the family is left alone", async () => {
    renderForm({
      person: person({
        inheritedFrom: { lastName: { personId: PARENT.id, name: "Layla Haddad" } },
      }),
      families: FAMILIES,
    });

    expect(screen.getByLabelText(/same last name as/i)).toBeEnabled();
    await save();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().inheritLastNameFromPersonId).toBe(PARENT.id);
  });
});
