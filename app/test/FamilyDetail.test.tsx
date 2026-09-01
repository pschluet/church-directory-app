import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderWithProviders } from "./utils";
import type { FamilyDto, FamilyMemberDto, MeDto, UpcomingDatesDto } from "@shared";
import { FamilyDetail } from "../src/pages/FamilyDetail";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
  uploadPhoto: vi.fn(),
}));

const meState = { personId: "person-1" as string | null };
const reload = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { personId: meState.personId }, person: null } as unknown as MeDto,
    loading: false,
    error: null,
    reload,
    isAdmin: false,
    isSuperAdmin: false,
    organizationId: "org-1",
    switchOrganization: vi.fn(),
  }),
}));

function member(overrides: {
  id: string;
  firstName: string;
  appUserId?: string | null;
  age?: number | null;
  patronSaint?: string | null;
}) {
  return {
    organizationId: "org-1",
    familyId: "fam-1",
    familyName: "Haddad",
    appUserId: overrides.appUserId ?? null,
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

const SELF = member({ id: "person-1", firstName: "Layla", appUserId: "user-1" });
const CHILD = member({ id: "person-2", firstName: "Anna" });

const NO_DATES: UpcomingDatesDto = { start: "2026-09-01", end: "2027-08-31", days: [] };

function buildFamily(overrides: Partial<FamilyDto> = {}): FamilyDto {
  return {
    id: "fam-1",
    organizationId: "org-1",
    name: "Haddad",
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    photoWidth: null,
    photoHeight: null,
    members: [SELF, CHILD],
    anniversaries: [],
    pendingJoinRequests: [],
    canEdit: true,
    isMember: true,
    ...overrides,
  };
}

/**
 * The page makes two reads. Everything here answers both, so a test only has to
 * say what is different about the family it cares about.
 */
function respondWith(family: FamilyDto, dates: UpcomingDatesDto = NO_DATES) {
  api.mockImplementation((path: string) =>
    path.startsWith("/special-dates/upcoming") ? Promise.resolve(dates) : Promise.resolve(family)
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/families/:id" element={<FamilyDetail />} />
    </Routes>,
    { initialEntries: ["/families/fam-1"] }
  );
}

/** Opens a member's three-dots menu. */
async function openMemberMenu(firstName: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(`actions for ${firstName}`, "i") })
  );
}

async function openFamilyMenu() {
  await userEvent.click(await screen.findByRole("button", { name: /family actions/i }));
}

/**
 * dnd-kit measures real boxes, and jsdom reports every element as 0x0 -- with
 * no geometry, collision detection finds nothing to drop onto and a drag ends
 * with `over` null. Give each member row a distinct 48px-tall box, stacked, so
 * the sortable list has something to reason about.
 */
function stubRowGeometry(): void {
  const ROW_HEIGHT = 48;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest("li");
    const index = row?.parentElement ? [...row.parentElement.children].indexOf(row) : 0;
    const top = index * ROW_HEIGHT;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 320,
      bottom: top + ROW_HEIGHT,
      width: 320,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/** Picks a member up, moves them one place down, and drops them. */
async function keyboardDrag(name: RegExp): Promise<void> {
  const grip = await screen.findByRole("button", { name });
  grip.focus();
  await userEvent.keyboard("{ }");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{ }");
}

describe("FamilyDetail", () => {
  beforeEach(() => {
    api.mockReset();
    reload.mockClear();
    meState.personId = "person-1";
    respondWith(buildFamily());
  });

  // -------------------------------------------------------------------------
  describe("the family menu", () => {
    it("keeps every management action behind one button", async () => {
      renderPage();
      await openFamilyMenu();

      const menu = screen.getByRole("menu");
      for (const label of [
        /add a photo/i,
        /create a new person/i,
        /add an existing person/i,
        /rename family/i,
      ]) {
        expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
      }
      expect(menu).toBeInTheDocument();
    });

    it("shows none of it to someone who cannot edit the family", async () => {
      respondWith(buildFamily({ canEdit: false, isMember: false }));
      renderPage();

      expect(await screen.findByRole("heading", { name: "Haddad" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /family actions/i })).not.toBeInTheDocument();
    });

    it("offers joining to an outsider as a plain button, not a menu item", async () => {
      respondWith(buildFamily({ canEdit: false, isMember: false }));
      renderPage();

      expect(
        await screen.findByRole("button", { name: /ask to join this family/i })
      ).toBeInTheDocument();
    });

    it("renames the family", async () => {
      renderPage();
      await openFamilyMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: /rename family/i }));

      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, "Haddad-Nasser");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1", {
          method: "PATCH",
          body: { name: "Haddad-Nasser" },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("the family photo", () => {
    it("shows no photo and no placeholder until one has been added", async () => {
      renderPage();
      expect(await screen.findByRole("heading", { name: "Haddad" })).toBeInTheDocument();

      // The old page always rendered an initials placeholder plus a button.
      expect(screen.queryByRole("button", { name: /^add photo$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("img", { name: /haddad family/i })).not.toBeInTheDocument();
    });

    it("offers adding one from the menu instead", async () => {
      renderPage();
      await openFamilyMenu();

      expect(screen.getByRole("menuitem", { name: /add a photo/i })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /remove photo/i })).not.toBeInTheDocument();
    });

    it("switches to changing and removing once there is a photo", async () => {
      respondWith(buildFamily({ thumbUrl: "/photos/t", fullUrl: "/photos/f" }));
      renderPage();
      await openFamilyMenu();

      expect(screen.getByRole("menuitem", { name: /change photo/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /remove photo/i })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /add a photo/i })).not.toBeInTheDocument();
    });

    it("clears the photo when asked to remove it", async () => {
      respondWith(buildFamily({ thumbUrl: "/photos/t", fullUrl: "/photos/f" }));
      renderPage();
      await openFamilyMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: /remove photo/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1/photo", {
          method: "PUT",
          body: { photoKey: null },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("removing a member", () => {
    it("offers nothing to someone who cannot edit the family", async () => {
      respondWith(buildFamily({ canEdit: false, isMember: false }));
      renderPage();

      expect(await screen.findByRole("heading", { name: "Haddad" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /actions for/i })).not.toBeInTheDocument();
    });

    it("asks first, and sends nothing if the answer is no", async () => {
      renderPage();
      await openMemberMenu("Anna");
      await userEvent.click(screen.getByRole("menuitem", { name: /remove from family/i }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const before = api.mock.calls.length;

      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(api).toHaveBeenCalledTimes(before);
    });

    it("warns that an accountless person has nobody to put them back", async () => {
      renderPage();
      await openMemberMenu("Anna");
      await userEvent.click(screen.getByRole("menuitem", { name: /remove from family/i }));

      expect(screen.getByRole("dialog")).toHaveTextContent(/no account of their own/i);
    });

    it("removes the member once confirmed", async () => {
      renderPage();
      await openMemberMenu("Anna");
      await userEvent.click(screen.getByRole("menuitem", { name: /remove from family/i }));
      await userEvent.click(screen.getByRole("button", { name: "Remove" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1/members/person-2", { method: "DELETE" })
      );
      // Removing someone else does not change who the caller is.
      expect(reload).not.toHaveBeenCalled();
    });

    it("calls leaving what it is, and refreshes the caller afterwards", async () => {
      renderPage();
      await openMemberMenu("Layla");
      await userEvent.click(screen.getByRole("menuitem", { name: /leave this family/i }));
      await userEvent.click(screen.getByRole("button", { name: "Leave" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1/members/person-1", { method: "DELETE" })
      );
      expect(reload).toHaveBeenCalled();
    });

    it("keeps the family on screen when a removal fails", async () => {
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method === "DELETE") {
          return Promise.reject(new Error("A family needs at least one member."));
        }
        return path.startsWith("/special-dates/upcoming")
          ? Promise.resolve(NO_DATES)
          : Promise.resolve(buildFamily());
      });
      renderPage();

      await openMemberMenu("Anna");
      await userEvent.click(screen.getByRole("menuitem", { name: /remove from family/i }));
      await userEvent.click(screen.getByRole("button", { name: "Remove" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/at least one member/i);
      // The whole point: the error must not replace the page.
      expect(screen.getByRole("heading", { name: "Haddad" })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe("adding a member", () => {
    it("adds someone already in the directory", async () => {
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (path.endsWith("/candidates")) {
          return Promise.resolve({ candidates: [{ id: "person-9", name: "Georgi Popov" }] });
        }
        if (path.startsWith("/special-dates/upcoming")) return Promise.resolve(NO_DATES);
        if (options?.method === "POST") return Promise.resolve(undefined);
        return Promise.resolve(buildFamily());
      });
      renderPage();

      await openFamilyMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: /add an existing person/i }));
      await userEvent.selectOptions(await screen.findByRole("combobox"), "person-9");
      await userEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1/members", {
          method: "POST",
          body: { personId: "person-9" },
        })
      );
    });

    it("says so when there is nobody left to add", async () => {
      api.mockImplementation((path: string) => {
        if (path.endsWith("/candidates")) return Promise.resolve({ candidates: [] });
        if (path.startsWith("/special-dates/upcoming")) return Promise.resolve(NO_DATES);
        return Promise.resolve(buildFamily());
      });
      renderPage();

      await openFamilyMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: /add an existing person/i }));
      expect(await screen.findByText(/nobody to add/i)).toBeInTheDocument();
    });

    it("creates a new person without an account", async () => {
      renderPage();
      await openFamilyMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: /create a new person/i }));

      await userEvent.type(screen.getByRole("textbox", { name: /first name/i }), "Rami");
      await userEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/persons", {
          method: "POST",
          body: { firstName: "Rami", lastName: null, familyId: "fam-1" },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("the year ahead", () => {
    it("asks for a year of this family's dates, starting today", async () => {
      renderPage();
      await screen.findByRole("heading", { name: "Haddad" });

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          "/special-dates/upcoming",
          expect.objectContaining({
            query: expect.objectContaining({ days: 365, familyId: "fam-1" }),
          })
        )
      );
    });

    it("lists what is coming up", async () => {
      respondWith(buildFamily(), {
        start: "2026-09-01",
        end: "2027-08-31",
        days: [
          {
            date: "2026-09-04",
            dates: [
              {
                id: "sd-1",
                personId: "person-2",
                personName: "Anna Haddad",
                type: "BIRTHDAY",
                month: 9,
                day: 4,
                year: 2014,
                showYearCount: true,
                relatedPersonId: null,
                relatedPersonName: null,
                patronSaint: null,
                date: "2026-09-04",
                yearCount: 12,
              },
            ],
          },
        ],
      });
      renderPage();

      expect(await screen.findByRole("heading", { name: /the year ahead/i })).toBeInTheDocument();
      expect(await screen.findByText(/turning 12/i)).toBeInTheDocument();
    });

    it("says so when the year is empty", async () => {
      renderPage();
      expect(await screen.findByText(/no special dates in the next year/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe("rearranging the family", () => {
    it("saves the new order after a keyboard drag", async () => {
      stubRowGeometry();
      renderPage();
      await keyboardDrag(/reorder layla/i);

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families/fam-1/member-order", {
          method: "PUT",
          body: { personIds: ["person-2", "person-1"] },
        })
      );
    });

    it("gives nobody without edit rights a handle to drag", async () => {
      respondWith(buildFamily({ canEdit: false, isMember: false }));
      renderPage();

      expect(await screen.findByRole("heading", { name: "Haddad" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reorder/i })).not.toBeInTheDocument();
    });

    it("reports a failure without losing the page", async () => {
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method === "PUT") return Promise.reject(new Error("Could not save."));
        return path.startsWith("/special-dates/upcoming")
          ? Promise.resolve(NO_DATES)
          : Promise.resolve(buildFamily());
      });
      stubRowGeometry();
      renderPage();
      await keyboardDrag(/reorder layla/i);

      expect(await screen.findByRole("alert")).toHaveTextContent(/could not save/i);
      expect(screen.getByRole("heading", { name: "Haddad" })).toBeInTheDocument();
    });
  });
});
