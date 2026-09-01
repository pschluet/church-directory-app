import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import type { AppUserDto, JoinRequestDto, MeDto, MergeRequestDto } from "@shared";
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

function mockLoad(joinRequests: JoinRequestDto[], mergeRequests: MergeRequestDto[] = []) {
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return Promise.resolve({ status: "APPROVED" });
    if (path === "/admin/users") return Promise.resolve({ users: [USER] });
    if (path === "/families") return Promise.resolve({ families: [] });
    if (path === "/families/join-requests/pending") return Promise.resolve({ joinRequests });
    if (path === "/merges/pending") return Promise.resolve({ mergeRequests });
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

  it("stays out of the way when there are no merges", async () => {
    mockLoad([]);
    renderPage();

    // Rendered twice -- the mobile card and the table row.
    await screen.findAllByText("layla@example.com");
    expect(screen.queryByText(/pending merge requests/i)).not.toBeInTheDocument();
  });
});
