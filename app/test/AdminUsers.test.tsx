import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import type {
  AppUserDto,
  DirectoryRequestDto,
  JoinRequestDto,
  MeDto,
  MergeRequestDto,
} from "@shared";
import { AdminUsers } from "../src/pages/AdminUsers";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

const reload = vi.fn().mockResolvedValue(undefined);
const meState = { personId: "admin-person" as string | null };

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: {
      appUser: { id: "admin-1", personId: meState.personId, organizationId: "org-1" },
      person: null,
      organization: { id: "org-1", name: "All Saints" },
      availableOrganizations: [],
    } as unknown as MeDto,
    loading: false,
    error: null,
    reload,
    isAdmin: true,
    isSuperAdmin: false,
    organizationId: "org-1",
    switchOrganization: vi.fn(),
  }),
}));

const USER = {
  id: "user-1",
  email: "layla@example.com",
  role: "USER",
  status: "ACTIVE",
  organizationId: "org-1",
  organizationName: "All Saints",
  personId: "person-1",
  personName: "Layla Haddad",
} as unknown as AppUserDto;

const REQUEST: JoinRequestDto = {
  id: "req-1",
  familyId: "fam-1",
  familyName: "Haddad",
  personId: "person-2",
  personName: "Sami Nassif",
  status: "PENDING",
  requestedAt: "2026-08-01T10:00:00.000Z",
  decidedAt: null,
};

function mockLoad(
  joinRequests: JoinRequestDto[],
  mergeRequests: MergeRequestDto[] = [],
  users: AppUserDto[] = [USER],
  directoryRequests: DirectoryRequestDto[] = []
) {
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return Promise.resolve({ status: "APPROVED" });
    if (options?.method === "DELETE") return Promise.resolve(null);
    if (options?.method === "PATCH") return Promise.resolve({});
    if (path === "/admin/users") return Promise.resolve({ users });
    if (path === "/families") return Promise.resolve({ families: [] });
    if (path === "/families/join-requests/pending") return Promise.resolve({ joinRequests });
    if (path === "/merges/pending") return Promise.resolve({ mergeRequests });
    if (path === "/admin/directory-requests") return Promise.resolve({ directoryRequests });
    return Promise.resolve({ organizations: [] });
  });
}

const MERGE: MergeRequestDto = {
  id: "merge-1",
  accountPersonId: "person-1",
  accountPersonName: "Layla Haddad",
  duplicatePersonId: "person-3",
  duplicatePersonName: "Layla H",
  duplicateFamilyId: "fam-1",
  duplicateFamilyName: "Haddad",
  requestedByPersonId: "person-2",
  requestedByPersonName: "Sami Nassif",
  status: "PENDING",
  requestedAt: "2026-08-01T10:00:00.000Z",
  decidedAt: null,
  canDecide: true,
};

function renderPage() {
  return renderWithProviders(<AdminUsers />, { initialEntries: ["/admin/users"] });
}

describe("AdminUsers", () => {
  beforeEach(() => {
    api.mockReset();
    reload.mockClear();
    meState.personId = "admin-person";
  });

  it("shows every pending request in the parish", async () => {
    mockLoad([REQUEST]);
    renderPage();

    expect(await screen.findByText(/pending join requests \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Sami Nassif → Haddad family/)).toBeInTheDocument();
  });

  it("stays out of the way when there are none", async () => {
    mockLoad([]);
    renderPage();

    expect(await screen.findByRole("heading", { name: /people & accounts/i })).toBeInTheDocument();
    expect(screen.queryByText(/pending join requests/i)).not.toBeInTheDocument();
  });

  it("approves a request and reloads", async () => {
    mockLoad([REQUEST]);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/families/join-requests/req-1/approve", { method: "POST" })
    );
    // Someone else's request cannot change which family the admin is in.
    expect(reload).not.toHaveBeenCalled();
  });

  it("refreshes the admin when they approve their own request", async () => {
    meState.personId = REQUEST.personId;
    mockLoad([REQUEST]);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("reports a failed decision without emptying the page", async () => {
    api.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.reject(new Error("Already decided"));
      if (path === "/admin/users") return Promise.resolve({ users: [USER] });
      if (path === "/families") return Promise.resolve({ families: [] });
      if (path === "/families/join-requests/pending")
        return Promise.resolve({ joinRequests: [REQUEST] });
      return Promise.resolve({ organizations: [] });
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Already decided");
    expect(screen.getAllByText("layla@example.com").length).toBeGreaterThan(0);
  });

  it("shows every pending merge in the parish", async () => {
    mockLoad([], [MERGE]);
    renderPage();

    expect(await screen.findByText(/pending merge requests \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Layla H \(Haddad family\) → Layla Haddad/)).toBeInTheDocument();
  });

  it("approves a merge and reloads the caller", async () => {
    mockLoad([], [MERGE]);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/merges/merge-1/approve", { method: "POST" })
    );
    // A merge moves someone between families, which can be the admin's own.
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  describe("the search box", () => {
    const OTHER = {
      ...USER,
      id: "user-2",
      email: "boris@example.com",
      personId: "person-9",
      personName: "Boris Popov",
      role: "ADMIN",
      status: "DISABLED",
    } as unknown as AppUserDto;

    const box = () => screen.getByRole("searchbox", { name: /search people and accounts/i });

    it("is its own search box, not the directory's", async () => {
      /*
       * SearchField hardcoded the directory's label. Two boxes with the same
       * accessible name are indistinguishable to anyone listening rather than
       * looking -- and the Directory suite selects on that exact name.
       */
      mockLoad([]);
      renderPage();
      expect(
        await screen.findByRole("searchbox", { name: /search people and accounts/i })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("searchbox", { name: /search the directory/i })
      ).not.toBeInTheDocument();
    });

    it("narrows the list without asking the server for anything", async () => {
      mockLoad([], [], [USER, OTHER]);
      renderPage();
      await screen.findByText("Layla Haddad");

      const before = api.mock.calls.length;
      await userEvent.type(box(), "boris");

      await waitFor(() => expect(screen.queryByText("Layla Haddad")).not.toBeInTheDocument());
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
      // The accounts are already loaded; searching them is not a request.
      expect(api.mock.calls.length).toBe(before);
    });

    it("searches name and email only, not role or status", async () => {
      mockLoad([], [], [USER, OTHER]);
      renderPage();
      await screen.findByText("Layla Haddad");

      // Boris is a disabled administrator, but those have filters of their own.
      await userEvent.type(box(), "disabled");
      expect(await screen.findByText(/no accounts match/i)).toBeInTheDocument();

      await userEvent.clear(box());
      await userEvent.type(box(), "layla@");
      await waitFor(() => expect(screen.queryByText("Boris Popov")).not.toBeInTheDocument());
      expect(screen.getByText("Layla Haddad")).toBeInTheDocument();
    });

    it("narrows with every term rather than widening", async () => {
      mockLoad([], [], [USER, OTHER]);
      renderPage();
      await screen.findByText("Layla Haddad");

      await userEvent.type(box(), "boris popov");
      await waitFor(() => expect(screen.queryByText("Layla Haddad")).not.toBeInTheDocument());
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();

      // Both terms have to match.
      await userEvent.clear(box());
      await userEvent.type(box(), "boris haddad");
      await waitFor(() => expect(screen.queryByText("Boris Popov")).not.toBeInTheDocument());
    });

    it("says so when nothing matches, and restores the list when cleared", async () => {
      mockLoad([], [], [USER, OTHER]);
      renderPage();
      await screen.findByText("Layla Haddad");

      await userEvent.type(box(), "nobody");
      expect(await screen.findByText(/no accounts match/i)).toBeInTheDocument();

      await userEvent.clear(box());
      expect(await screen.findByText("Layla Haddad")).toBeInTheDocument();
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
    });
  });

  describe("the role and status filters", () => {
    const BORIS = {
      ...USER,
      id: "user-2",
      email: "boris@example.com",
      personId: "person-9",
      personName: "Boris Popov",
      role: "ADMIN",
      status: "DISABLED",
    } as unknown as AppUserDto;
    const NINA = {
      ...USER,
      id: "user-3",
      email: "nina@example.com",
      personId: "person-10",
      personName: "Nina Petrova",
      role: "PRAYER_REQUEST_ADMIN",
      status: "INVITED",
    } as unknown as AppUserDto;

    const pick = async (filter: RegExp, ...options: RegExp[]) => {
      await userEvent.click(screen.getByRole("combobox", { name: filter }));
      for (const option of options) {
        await userEvent.click(screen.getByRole("option", { name: option }));
      }
    };

    it("says what they are filtering by", async () => {
      mockLoad([], [], [USER, BORIS, NINA]);
      renderPage();
      await screen.findByText("Layla Haddad");
      expect(screen.getByRole("combobox", { name: /filter by role/i })).toHaveTextContent(
        "All roles"
      );
      expect(screen.getByRole("combobox", { name: /filter by status/i })).toHaveTextContent(
        "All statuses"
      );
    });

    it("shows only the roles chosen, and stays open for more", async () => {
      mockLoad([], [], [USER, BORIS, NINA]);
      renderPage();
      await screen.findByText("Layla Haddad");

      await pick(/filter by role/i, /^administrator$/i);
      await waitFor(() => expect(screen.queryByText("Layla Haddad")).not.toBeInTheDocument());
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
      expect(screen.queryByText("Nina Petrova")).not.toBeInTheDocument();

      // Still open: a second choice widens the filter.
      expect(screen.getByRole("listbox", { name: /filter by role/i })).toHaveAttribute(
        "aria-multiselectable",
        "true"
      );
      await userEvent.click(screen.getByRole("option", { name: /^member$/i }));
      expect(await screen.findByText("Layla Haddad")).toBeInTheDocument();
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
      expect(screen.queryByText("Nina Petrova")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /filter by role/i })).toHaveTextContent(
        "2 roles"
      );
    });

    it("combines status with role and search", async () => {
      mockLoad([], [], [USER, BORIS, NINA]);
      renderPage();
      await screen.findByText("Layla Haddad");

      await pick(/filter by status/i, /^disabled$/i, /^invited$/i);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByText("Layla Haddad")).not.toBeInTheDocument());
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
      expect(screen.getByText("Nina Petrova")).toBeInTheDocument();

      await userEvent.type(
        screen.getByRole("searchbox", { name: /search people and accounts/i }),
        "nina"
      );
      await waitFor(() => expect(screen.queryByText("Boris Popov")).not.toBeInTheDocument());
      expect(screen.getByText("Nina Petrova")).toBeInTheDocument();
    });

    it("reads the filters from the URL and offers a way out when nothing matches", async () => {
      mockLoad([], [], [USER, BORIS]);
      renderWithProviders(<AdminUsers />, {
        initialEntries: ["/admin/users?role=SUPER_ADMIN&status=ACTIVE"],
      });
      expect(await screen.findByText(/no accounts match these filters/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /clear filters/i }));
      expect(await screen.findByText("Layla Haddad")).toBeInTheDocument();
      expect(screen.getByText("Boris Popov")).toBeInTheDocument();
    });
  });

  describe("inviting", () => {
    it("invites into the church being viewed, with no church to pick", async () => {
      mockLoad([]);
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: /invite someone/i }));

      expect(screen.queryByText(/^church$/i)).not.toBeInTheDocument();
      await userEvent.type(screen.getByLabelText(/first name/i), "Anna");
      await userEvent.type(screen.getByLabelText(/email address/i), "anna@example.com");
      await userEvent.click(screen.getByRole("button", { name: /send invitation/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          "/admin/users",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ email: "anna@example.com", organizationId: "org-1" }),
          })
        )
      );
    });
  });

  describe("the row menu", () => {
    const openMenu = async (name: RegExp) => {
      await userEvent.click(await screen.findByRole("button", { name }));
    };

    it("puts every action behind one kebab", async () => {
      mockLoad([]);
      renderPage();

      await openMenu(/actions for layla haddad/i);
      expect(screen.getByRole("menuitem", { name: /make administrator/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /^disable$/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /delete permanently/i })).toBeInTheDocument();
      // Not a super admin, so no parish move.
      expect(screen.queryByRole("menuitem", { name: /move church/i })).not.toBeInTheDocument();
    });

    it("disables an account from the menu", async () => {
      mockLoad([]);
      renderPage();

      await openMenu(/actions for layla haddad/i);
      await userEvent.click(screen.getByRole("menuitem", { name: /^disable$/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/admin/users/user-1", {
          method: "PATCH",
          body: { status: "DISABLED" },
        })
      );
    });

    it("promotes someone from the menu", async () => {
      mockLoad([]);
      renderPage();

      await openMenu(/actions for layla haddad/i);
      await userEvent.click(screen.getByRole("menuitem", { name: /make administrator/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/admin/users/user-1", {
          method: "PATCH",
          body: { role: "ADMIN" },
        })
      );
    });

    it("offers no menu at all when nothing applies", async () => {
      /*
       * An admin can do nothing to a super admin in their own parish -- no role
       * change, no parish move, no disable, no delete -- so a kebab here would
       * open an empty panel.
       */
      const untouchable = {
        ...USER,
        id: "user-3",
        personName: "Super Person",
        role: "SUPER_ADMIN",
      } as unknown as AppUserDto;
      mockLoad([], [], [untouchable]);
      renderPage();

      await screen.findByText("Super Person");
      expect(
        screen.queryByRole("button", { name: /actions for super person/i })
      ).not.toBeInTheDocument();
    });

    it("does not offer an admin a disable it cannot perform", async () => {
      // The server answers 404 for a super admin outside the caller's reach,
      // so offering the action at all was a dead end.
      const untouchable = {
        ...USER,
        id: "user-3",
        personName: "Super Person",
        role: "SUPER_ADMIN",
      } as unknown as AppUserDto;
      mockLoad([], [], [USER, untouchable]);
      renderPage();

      await screen.findByText("Super Person");
      await userEvent.click(screen.getByRole("button", { name: /actions for layla haddad/i }));
      expect(screen.getByRole("menuitem", { name: /^disable$/i })).toBeInTheDocument();
    });
  });

  describe("deleting an account", () => {
    it("asks first, and says what else goes", async () => {
      mockLoad([]);
      renderPage();

      await userEvent.click(
        await screen.findByRole("button", { name: /actions for layla haddad/i })
      );
      await userEvent.click(screen.getByRole("menuitem", { name: /delete permanently/i }));

      expect(await screen.findByText(/delete layla haddad\?/i)).toBeInTheDocument();
      // The cascade nobody would guess, which the API test pins server-side.
      expect(screen.getByText(/wedding anniversary/i)).toBeInTheDocument();
      expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
      // Nothing has happened yet.
      expect(api).not.toHaveBeenCalledWith("/admin/users/user-1", { method: "DELETE" });
    });

    it("deletes once confirmed", async () => {
      mockLoad([]);
      renderPage();

      await userEvent.click(
        await screen.findByRole("button", { name: /actions for layla haddad/i })
      );
      await userEvent.click(screen.getByRole("menuitem", { name: /delete permanently/i }));
      await userEvent.click(screen.getByRole("button", { name: /delete permanently/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/admin/users/user-1", { method: "DELETE" })
      );
    });

    it("leaves the account alone when the dialog is dismissed", async () => {
      mockLoad([]);
      renderPage();

      await userEvent.click(
        await screen.findByRole("button", { name: /actions for layla haddad/i })
      );
      await userEvent.click(screen.getByRole("menuitem", { name: /delete permanently/i }));
      await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      await waitFor(() =>
        expect(screen.queryByText(/delete layla haddad\?/i)).not.toBeInTheDocument()
      );
      expect(api).not.toHaveBeenCalledWith("/admin/users/user-1", { method: "DELETE" });
    });

    it("shows the reason when the server refuses", async () => {
      mockLoad([]);
      api.mockImplementation((path: string, options?: { method?: string }) => {
        if (options?.method === "DELETE") {
          return Promise.reject(new Error("Only a super admin can delete a super admin"));
        }
        if (path === "/admin/users") return Promise.resolve({ users: [USER] });
        if (path === "/families") return Promise.resolve({ families: [] });
        if (path === "/families/join-requests/pending")
          return Promise.resolve({ joinRequests: [] });
        if (path === "/merges/pending") return Promise.resolve({ mergeRequests: [] });
        return Promise.resolve({ organizations: [] });
      });
      renderPage();

      await userEvent.click(
        await screen.findByRole("button", { name: /actions for layla haddad/i })
      );
      await userEvent.click(screen.getByRole("menuitem", { name: /delete permanently/i }));
      await userEvent.click(screen.getByRole("button", { name: /delete permanently/i }));

      expect(
        await screen.findByText(/only a super admin can delete a super admin/i)
      ).toBeInTheDocument();
    });
  });

  it("stays out of the way when there are no merges", async () => {
    mockLoad([]);
    renderPage();

    await screen.findByText("layla@example.com");
    expect(screen.queryByText(/pending merge requests/i)).not.toBeInTheDocument();
  });

  describe("requests to be added", () => {
    const DIRECTORY_REQUESTS: DirectoryRequestDto[] = [
      {
        id: "dr-1",
        firstName: "Maria",
        lastName: "Lopez",
        email: "maria@example.com",
        organizationId: "org-1",
        requestedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "dr-2",
        firstName: "Tomas",
        lastName: "Reyes",
        email: "tomas@example.com",
        organizationId: "org-1",
        requestedAt: "2026-08-02T10:00:00.000Z",
      },
    ];

    it("is not shown when there are none", async () => {
      mockLoad([]);
      renderWithProviders(<AdminUsers />);
      await screen.findByText("Layla Haddad");
      expect(screen.queryByRole("button", { name: /Requests to be added/ })).toBeNull();
    });

    it("starts collapsed, with the count on the heading either way", async () => {
      mockLoad([], [], [USER], DIRECTORY_REQUESTS);
      renderWithProviders(<AdminUsers />);

      const toggle = await screen.findByRole("button", { name: /Requests to be added/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveTextContent("2");
      expect(screen.queryByText("Maria Lopez")).toBeNull();

      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveTextContent("2");
      expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
      expect(screen.getByText(/tomas@example.com/)).toBeInTheDocument();

      await userEvent.click(toggle);
      expect(screen.queryByText("Maria Lopez")).toBeNull();
    });

    it("approves and declines through the admin routes", async () => {
      mockLoad([], [], [USER], DIRECTORY_REQUESTS);
      renderWithProviders(<AdminUsers />);

      await userEvent.click(await screen.findByRole("button", { name: /Requests to be added/ }));
      const [approveFirst] = screen.getAllByRole("button", { name: "Approve" });
      await userEvent.click(approveFirst!);
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/admin/directory-requests/dr-1/approve", {
          method: "POST",
        })
      );

      const declines = screen.getAllByRole("button", { name: "Decline" });
      await userEvent.click(declines[1]!);
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/admin/directory-requests/dr-2/decline", {
          method: "POST",
        })
      );
    });
  });
});
