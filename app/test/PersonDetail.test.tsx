import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderWithProviders } from "./utils";
import type { MergeRequestDto, MeDto, PersonDto, SpecialDateDto } from "@shared";
import { PersonDetail } from "../src/pages/PersonDetail";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
  uploadPhoto: vi.fn(),
}));

/** Mutable, so a case can change whose record is on screen without re-mocking. */
const meState = { personId: "person-1" as string | null, isAdmin: false };
const reloadMe = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { personId: meState.personId }, person: null } as unknown as MeDto,
    loading: false,
    error: null,
    reload: reloadMe,
    isAdmin: meState.isAdmin,
    isSuperAdmin: false,
    organizationId: "org-1",
    switchOrganization: vi.fn(),
  }),
}));

const navigate = vi.fn();
vi.mock("react-router", async () => ({
  ...(await vi.importActual<typeof import("react-router")>("react-router")),
  useNavigate: () => navigate,
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
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<PersonDetail />} />
    </Routes>,
    { initialEntries: ["/people/person-1"] }
  );
}

const infoButton = () => screen.queryByRole("button", { name: /why can i see the year/i });

describe("PersonDetail special dates", () => {
  beforeEach(() => {
    api.mockReset();
    meState.personId = "person-1";
    meState.isAdmin = false;
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

// ---------------------------------------------------------------------------
// Merging, and deleting an account-less person
// ---------------------------------------------------------------------------
function person(overrides: Partial<PersonDto> = {}): PersonDto {
  return { ...buildPerson([]), ...overrides };
}

function mergeRequest(overrides: Partial<MergeRequestDto> = {}): MergeRequestDto {
  return {
    id: "merge-1",
    accountPersonId: "person-1",
    accountPersonName: "Layla Haddad",
    duplicatePersonId: "dup-1",
    duplicatePersonName: "Layla H",
    duplicateFamilyId: "family-1",
    duplicateFamilyName: "Haddad",
    requestedByPersonId: "cousin-1",
    requestedByPersonName: "Sami Nassif",
    status: "PENDING",
    requestedAt: "2026-08-01T10:00:00.000Z",
    decidedAt: null,
    canDecide: true,
    ...overrides,
  };
}

function render(subject: PersonDto, mergeRequests: MergeRequestDto[] = []) {
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method) return Promise.resolve({ status: "PENDING", id: "merge-new" });
    if (path === `/persons/${subject.id}`) return Promise.resolve(subject);
    if (path === "/merges/pending") return Promise.resolve({ mergeRequests });
    return Promise.resolve({ people: [], families: [] });
  });
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<PersonDetail />} />
    </Routes>,
    { initialEntries: [`/people/${subject.id}`] }
  );
}

const button = (name: RegExp) => screen.queryByRole("button", { name });

describe("PersonDetail merging and deleting", () => {
  beforeEach(() => {
    api.mockReset();
    navigate.mockReset();
    reloadMe.mockClear();
    meState.personId = "person-1";
    meState.isAdmin = false;
  });

  it("offers to absorb a duplicate on your own record, and no delete", async () => {
    render(person({ canEdit: true }));

    expect(
      await screen.findByRole("button", { name: /merge a duplicate into my record/i })
    ).toBeInTheDocument();
    // You cannot delete a record that has an account -- the API refuses it too.
    expect(button(/delete this person/i)).not.toBeInTheDocument();
  });

  it("offers merge and delete on an account-less relative", async () => {
    render(person({ id: "person-1", appUserId: null, canEdit: true, familyId: "family-1" }));
    meState.personId = "someone-else";

    expect(
      await screen.findByRole("button", { name: /merge into an account holder/i })
    ).toBeInTheDocument();
    expect(button(/delete this person/i)).toBeInTheDocument();
  });

  it("offers neither on someone you cannot edit", async () => {
    meState.personId = "someone-else";
    render(person({ appUserId: null, canEdit: false }));

    await screen.findByText("Layla Haddad");
    expect(button(/merge/i)).not.toBeInTheDocument();
    expect(button(/delete this person/i)).not.toBeInTheDocument();
  });

  it("stands down while a merge is already pending", async () => {
    render(person({ canEdit: true }), [mergeRequest({ canDecide: false })]);

    expect(await screen.findByText(/waiting to be approved/i)).toBeInTheDocument();
    expect(button(/merge a duplicate/i)).not.toBeInTheDocument();
  });

  it("sends nothing until the delete is confirmed", async () => {
    meState.personId = "someone-else";
    render(person({ appUserId: null, canEdit: true, familyId: "family-1" }));

    await userEvent.click(await screen.findByRole("button", { name: /delete this person/i }));
    expect(api).not.toHaveBeenCalledWith("/persons/person-1", { method: "DELETE" });

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/persons/person-1", { method: "DELETE" })
    );
    // The record is gone, so staying here would fetch a 404.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/families/family-1", { replace: true })
    );
  });

  it("approves a merge waiting on the caller and reloads them", async () => {
    render(person({ canEdit: true }), [mergeRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/merges/merge-1/approve", { method: "POST" })
    );
    // A merge can move the caller's own family.
    await waitFor(() => expect(reloadMe).toHaveBeenCalled());
  });

  /*
   * The direction of the payload is the subtle part: the person on screen is
   * the account holder in one mode and the duplicate in the other, so the two
   * ids swap places. Getting it backwards would 400 on the API's
   * "surviving record must be the one with an account" check, which is a poor
   * way to find out.
   */
  describe("sending the request", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const pick = async (comboboxName: RegExp, name: string) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole("combobox", { name: comboboxName }), "lay");
      vi.advanceTimersByTime(250);
      await user.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await user.click(screen.getByRole("button", { name: /send request/i }));
    };

    const withLookup = (
      subject: PersonDto,
      found: { id: string; name: string },
      postResponse: unknown = { status: "PENDING", id: "merge-new" }
    ) => {
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method) return Promise.resolve(postResponse);
        if (path === `/persons/${subject.id}`) return Promise.resolve(subject);
        if (path === "/merges/pending") return Promise.resolve({ mergeRequests: [] });
        if (path === "/directory/lookup")
          return Promise.resolve({ people: [{ ...found, familyName: "Haddad" }] });
        return Promise.resolve({ people: [], families: [] });
      });
      return renderWithProviders(
        <Routes>
          <Route path="/people/:id" element={<PersonDetail />} />
        </Routes>,
        { initialEntries: [`/people/${subject.id}`] }
      );
    };

    it("names the caller as the survivor when absorbing a duplicate", async () => {
      withLookup(person({ canEdit: true }), { id: "dup-9", name: "Layla H" });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(
        await screen.findByRole("button", { name: /merge a duplicate into my record/i })
      );
      await pick(/the duplicate record/i, "Layla H");

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/merges", {
          method: "POST",
          body: { accountPersonId: "person-1", duplicatePersonId: "dup-9" },
        })
      );
    });

    it("names the person picked as the survivor when merging a relative", async () => {
      meState.personId = "someone-else";
      withLookup(person({ appUserId: null, canEdit: true, familyId: "family-1" }), {
        id: "holder-9",
        name: "Layla Haddad",
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(
        await screen.findByRole("button", { name: /merge into an account holder/i })
      );
      await pick(/the account holder/i, "Layla Haddad");

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/merges", {
          method: "POST",
          // Swapped: the person on screen is the duplicate this time.
          body: { accountPersonId: "holder-9", duplicatePersonId: "person-1" },
        })
      );
    });
  });

  it("reports a failed decision without emptying the page", async () => {
    api.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.reject(new Error("Already decided"));
      if (path === "/persons/person-1") return Promise.resolve(person({ canEdit: true }));
      if (path === "/merges/pending") return Promise.resolve({ mergeRequests: [mergeRequest()] });
      return Promise.resolve({ people: [], families: [] });
    });
    renderWithProviders(
      <Routes>
        <Route path="/people/:id" element={<PersonDetail />} />
      </Routes>,
      { initialEntries: ["/people/person-1"] }
    );

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already decided");
    // The record is still on screen -- the name appears in the heading and again
    // in the banner, so count rather than expecting one.
    expect(screen.getAllByText("Layla Haddad").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  /*
   * An admin needs no approval, so POST /merges does the merge in the same call
   * and the record this page is showing may be the one just retired. Before,
   * the invalidation refetched it and painted "Person not found" over a merge
   * that had in fact succeeded.
   */
  describe("when the merge happens immediately", () => {
    const MERGED = {
      status: "APPROVED",
      result: {
        personId: "survivor-1",
        mergedPersonId: "person-1",
        familyId: "family-1",
        movedFamily: true,
        discardedBirthdays: 0,
        discardedFeastDays: 0,
        discardedAnniversaries: 0,
      },
    };

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      meState.isAdmin = true;
      meState.personId = "admin-person";
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const duplicatePage = (postResponse: unknown) => {
      const subject = person({
        id: "person-1",
        appUserId: null,
        canEdit: true,
        familyId: "family-1",
      });
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method) return Promise.resolve(postResponse);
        if (path === "/persons/person-1") return Promise.resolve(subject);
        if (path === "/merges/pending") return Promise.resolve({ mergeRequests: [] });
        if (path === "/directory/lookup")
          return Promise.resolve({
            people: [{ id: "survivor-1", name: "Layla Haddad", familyName: "Haddad" }],
          });
        return Promise.resolve({ people: [], families: [] });
      });
      return renderWithProviders(
        <Routes>
          <Route path="/people/:id" element={<PersonDetail />} />
        </Routes>,
        { initialEntries: ["/people/person-1"] }
      );
    };

    const askToMerge = async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(
        await screen.findByRole("button", { name: /merge into an account holder/i })
      );
      await user.type(screen.getByRole("combobox", { name: /the account holder/i }), "lay");
      vi.advanceTimersByTime(250);
      await user.click(await screen.findByRole("option", { name: /layla haddad/i }));
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await user.click(screen.getByRole("button", { name: /merge now/i }));
    };

    it("follows the surviving record instead of 404ing on the retired one", async () => {
      duplicatePage(MERGED);
      await askToMerge();

      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith("/people/survivor-1", { replace: true })
      );
      expect(screen.queryByText(/person not found/i)).not.toBeInTheDocument();
    });

    it("tells an admin the merge is immediate rather than a request", async () => {
      duplicatePage(MERGED);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(
        await screen.findByRole("button", { name: /merge into an account holder/i })
      );
      await user.type(screen.getByRole("combobox", { name: /the account holder/i }), "lay");
      vi.advanceTimersByTime(250);
      await user.click(await screen.findByRole("option", { name: /layla haddad/i }));
      await user.click(screen.getByRole("button", { name: /continue/i }));

      expect(screen.getByText(/takes effect straight away/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /merge now/i })).toBeInTheDocument();
    });

    it("stays put when the merge is only a request", async () => {
      meState.isAdmin = false;
      duplicatePage({ status: "PENDING", id: "merge-new" });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(
        await screen.findByRole("button", { name: /merge into an account holder/i })
      );
      await user.type(screen.getByRole("combobox", { name: /the account holder/i }), "lay");
      vi.advanceTimersByTime(250);
      await user.click(await screen.findByRole("option", { name: /layla haddad/i }));
      await user.click(screen.getByRole("button", { name: /continue/i }));
      await user.click(screen.getByRole("button", { name: /send request/i }));

      await waitFor(() => expect(api).toHaveBeenCalledWith("/merges", expect.anything()));
      // Nothing has been retired yet, so the page it is on is still valid.
      expect(navigate).not.toHaveBeenCalled();
    });

    it("follows the survivor when approving from the retired record's page", async () => {
      const subject = person({
        id: "person-1",
        appUserId: null,
        canEdit: true,
        familyId: "family-1",
      });
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method) return Promise.resolve(MERGED);
        if (path === "/persons/person-1") return Promise.resolve(subject);
        if (path === "/merges/pending")
          return Promise.resolve({
            mergeRequests: [
              mergeRequest({ accountPersonId: "survivor-1", duplicatePersonId: "person-1" }),
            ],
          });
        return Promise.resolve({ people: [], families: [] });
      });
      renderWithProviders(
        <Routes>
          <Route path="/people/:id" element={<PersonDetail />} />
        </Routes>,
        { initialEntries: ["/people/person-1"] }
      );

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(await screen.findByRole("button", { name: "Approve" }));

      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith("/people/survivor-1", { replace: true })
      );
    });
  });
});
