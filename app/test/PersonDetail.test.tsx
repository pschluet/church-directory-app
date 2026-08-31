import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MeDto, PersonDto, SpecialDateDto } from "@shared";
import { PersonDetail } from "../src/pages/PersonDetail";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
  uploadPhoto: vi.fn(),
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { personId: "person-1" }, person: null } as unknown as MeDto,
    loading: false,
    error: null,
    reload: vi.fn(),
    isAdmin: false,
    isSuperAdmin: false,
    organizationId: "org-1",
    switchOrganization: vi.fn(),
  }),
}));

function birthday(overrides: Partial<SpecialDateDto> = {}): SpecialDateDto {
  return {
    id: "date-1",
    personId: "person-1",
    personName: "Layla Haddad",
    type: "BIRTHDAY",
    month: 5,
    day: 4,
    year: 1985,
    showYearCount: false,
    relatedPersonId: null,
    relatedPersonName: null,
    patronSaint: null,
    ...overrides,
  };
}

function buildPerson(specialDates: SpecialDateDto[]): PersonDto {
  return {
    id: "person-1",
    organizationId: "org-1",
    familyId: null,
    familyName: null,
    appUserId: "user-1",
    firstName: "Layla",
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
    canEdit: false,
    inheritedFrom: {},
    specialDates,
  };
}

function renderPage(specialDates: SpecialDateDto[]) {
  api.mockImplementation((path: string) => {
    if (path === "/persons/person-1") return Promise.resolve(buildPerson(specialDates));
    return Promise.resolve({ people: [], families: [] });
  });
  return render(
    <MemoryRouter initialEntries={["/people/person-1"]}>
      <Routes>
        <Route path="/people/:id" element={<PersonDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const infoButton = () => screen.queryByRole("button", { name: /why can i see the year/i });

describe("PersonDetail special dates", () => {
  beforeEach(() => {
    api.mockReset();
  });

  it("explains a year that others do not get to see", async () => {
    renderPage([birthday()]);
    expect(await screen.findByText("May 4, 1985")).toBeInTheDocument();

    const button = infoButton()!;
    expect(button).toBeInTheDocument();
    expect(screen.queryByText(/other members see only the day and month/i)).toBeNull();

    await userEvent.click(button);
    expect(screen.getByText("Not shown to others")).toBeInTheDocument();
    expect(screen.getByText(/“Show my age to others” is off for this date/i)).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Not shown to others")).toBeNull());
  });

  it("closes the note on a click elsewhere", async () => {
    renderPage([birthday()]);
    await userEvent.click(await screen.findByRole("button", { name: /why can i see the year/i }));
    expect(screen.getByText("Not shown to others")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("heading", { name: "Special dates" }));
    await waitFor(() => expect(screen.queryByText("Not shown to others")).toBeNull());
  });

  it("quotes the anniversary wording for an anniversary", async () => {
    renderPage([
      birthday({
        type: "ANNIVERSARY",
        year: 2010,
        relatedPersonId: "person-2",
        relatedPersonName: "Sami Haddad",
      }),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /why can i see the year/i }));
    expect(screen.getByText(/“Show how many years” is off for this date/i)).toBeInTheDocument();
  });

  // What another member's browser actually receives: the API redacts the year
  // rather than trusting the page to leave it out.
  it("shows only the day and month when the year was withheld", async () => {
    renderPage([birthday({ year: null })]);
    expect(await screen.findByText("May 4")).toBeInTheDocument();
    expect(infoButton()).toBeNull();
  });

  it("offers no explanation when the age was opted in to", async () => {
    renderPage([birthday({ showYearCount: true })]);
    expect(await screen.findByText("May 4, 1985")).toBeInTheDocument();
    expect(infoButton()).toBeNull();
  });
});
