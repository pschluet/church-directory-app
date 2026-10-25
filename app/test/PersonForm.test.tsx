import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PersonDto, PersonSummaryDto } from "@shared";
import { PersonForm } from "../src/components/PersonForm";
import { renderWithProviders, chooseOption } from "./utils";

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

/*
 * The street field is an AddressAutocomplete, which reads the Google Maps
 * browser key from here. `maps: null` is the case that matters for this file:
 * with no key it renders a plain text input, which is what these cases type
 * into -- and is also what a parish with Map View switched off gets.
 */
vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    organizationId: "org-1",
    mapViewEnabled: false,
    maps: null,
    reload: vi.fn(() => Promise.resolve()),
  }),
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
    placeId: null,
    patronSaint: null,
    occupation: null,
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
  return renderWithProviders(
    <PersonForm person={person()} familyMembers={[PARENT]} onSaved={vi.fn()} {...props} />
  );
}

async function save() {
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
}

/** The body of the PATCH, whatever lookups have been made since. */
function savedBody(): Record<string, unknown> {
  const call = api.mock.calls.find(([, options]) => options?.method === "PATCH")!;
  return (call[1] as { body: Record<string, unknown> }).body;
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

  it("saves the occupation, trimmed, and clears it when emptied", async () => {
    renderForm({ person: person({ occupation: "Nurse" }) });
    const input = screen.getByRole("combobox", { name: "Occupation" });
    expect(input).toHaveValue("Nurse");

    await userEvent.clear(input);
    await userEvent.type(input, "  Teacher ");
    await save();
    await waitFor(() => expect(savedBody().occupation).toBe("Teacher"));
  });

  it("suggests occupations other members have entered, and accepts one", async () => {
    api.mockImplementation((path: string) =>
      Promise.resolve(path === "/directory/occupations" ? { occupations: ["Teacher"] } : person())
    );
    renderForm();

    await userEvent.type(screen.getByRole("combobox", { name: "Occupation" }), "tea");
    await userEvent.click(await screen.findByRole("option", { name: "Teacher" }));
    expect(screen.getByRole("combobox", { name: "Occupation" })).toHaveValue("Teacher");

    await save();
    await waitFor(() => expect(savedBody().occupation).toBe("Teacher"));
  });

  it("drops a picked placeId when only the ZIP is corrected, so the map re-geocodes", async () => {
    renderForm({
      person: person({
        addressLine1: "4741 W Berenice Ave",
        city: "Chicago",
        state: "IL",
        postalCode: "60618",
        placeId: "stale-place",
      }),
    });

    const zip = screen.getByLabelText("ZIP code");
    await userEvent.clear(zip);
    await userEvent.type(zip, "60641");
    await save();

    await waitFor(() => expect(savedBody().postalCode).toBe("60641"));
    expect(savedBody().placeId).toBeNull();
  });

  it("keeps a picked placeId when the address is not touched", async () => {
    renderForm({
      person: person({ addressLine1: "4741 W Berenice Ave", placeId: "kept-place" }),
    });
    await save();
    await waitFor(() => expect(savedBody().placeId).toBe("kept-place"));
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
    expect(screen.getByLabelText(/^family/i)).toHaveTextContent("Haddad");
  });

  it("sends the family unchanged when it was not touched", async () => {
    renderForm({ families: FAMILIES });
    await save();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().familyId).toBe(HADDAD_ID);
  });

  it("moves someone to another family", async () => {
    renderForm({ families: FAMILIES });
    await chooseOption(screen.getByLabelText(/^family/i), NASSIF_ID);
    await save();

    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(lastBody().familyId).toBe(NASSIF_ID);
  });

  it("sends null when they are taken out of every family", async () => {
    renderForm({ families: FAMILIES });
    await chooseOption(screen.getByLabelText(/^family/i), "");
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

    await chooseOption(screen.getByLabelText(/^family/i), NASSIF_ID);

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

  describe("an account holder's email", () => {
    it("cannot be shared from a relative, and says why", () => {
      renderForm({ person: person({ appUserId: "user-1" }) });
      expect(screen.getByLabelText(/same email as/i)).toBeDisabled();
      expect(screen.getByText(/signs? in with/i)).toBeInTheDocument();
    });

    it("holds the change behind a code, and does not call onSaved until it is entered", async () => {
      const onSaved = vi.fn();
      const saved = person({ appUserId: "user-1", email: "old@test.example" });
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (path === `/persons/${PERSON_ID}` && options?.method === "PATCH") {
          return Promise.resolve({
            ...saved,
            pendingEmailChange: { email: "new@test.example", expiresAt: "2099-01-01T00:00:00Z" },
          });
        }
        if (path === "/me/email/confirm") return Promise.resolve({});
        return Promise.resolve(saved);
      });

      renderForm({ person: saved, onSaved });
      await userEvent.clear(screen.getByLabelText(/^email/i));
      await userEvent.type(screen.getByLabelText(/^email/i), "new@test.example");
      await save();

      expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();

      await userEvent.type(screen.getByLabelText("Code"), "123456");
      await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

      await waitFor(() =>
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ email: "new@test.example" }))
      );
      expect(api).toHaveBeenCalledWith(
        "/me/email/confirm",
        expect.objectContaining({ method: "POST", body: { code: "123456" } })
      );
    });

    it("abandons the change on cancel, keeping everything else the save already committed", async () => {
      const onSaved = vi.fn();
      const saved = person({ appUserId: "user-1", email: "old@test.example", firstName: "Changed" });
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (path === `/persons/${PERSON_ID}` && options?.method === "PATCH") {
          return Promise.resolve({
            ...saved,
            pendingEmailChange: { email: "new@test.example", expiresAt: "2099-01-01T00:00:00Z" },
          });
        }
        return Promise.resolve(saved);
      });

      renderForm({ person: person({ appUserId: "user-1" }), onSaved });
      await userEvent.clear(screen.getByLabelText(/^email/i));
      await userEvent.type(screen.getByLabelText(/^email/i), "new@test.example");
      await save();

      await screen.findByText(/check your email/i);
      await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      expect(api).toHaveBeenCalledWith("/me/email", expect.objectContaining({ method: "DELETE" }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    });
  });
});
