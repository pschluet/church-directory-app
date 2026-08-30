import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { FamilyDto, MeDto, PersonSummaryDto } from "@shared";
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

function member(overrides: { id: string; firstName: string; appUserId?: string | null }) {
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
    canEdit: true,
    ...overrides,
  } as unknown as PersonSummaryDto;
}

const SELF = member({ id: "person-1", firstName: "Layla", appUserId: "user-1" });
const CHILD = member({ id: "person-2", firstName: "Anna" });

function buildFamily(overrides: Partial<FamilyDto> = {}): FamilyDto {
  return {
    id: "fam-1",
    organizationId: "org-1",
    name: "Haddad",
    photoUrl: null,
    members: [SELF, CHILD],
    pendingJoinRequests: [],
    canEdit: true,
    isMember: true,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/families/fam-1"]}>
      <Routes>
        <Route path="/families/:id" element={<FamilyDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("FamilyDetail", () => {
  beforeEach(() => {
    api.mockReset();
    reload.mockClear();
    meState.personId = "person-1";
    api.mockResolvedValue(buildFamily());
  });

  it("offers no removal to someone who cannot edit the family", async () => {
    api.mockResolvedValue(buildFamily({ canEdit: false, isMember: false }));
    renderPage();

    expect(await screen.findByRole("heading", { name: "Haddad" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove from family/i })).not.toBeInTheDocument();
  });

  it("asks before removing anyone, and sends nothing if the answer is no", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /remove from family/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(1); // the initial load only

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("warns that an accountless person has nobody to put them back", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /remove from family/i }));

    expect(screen.getByRole("dialog")).toHaveTextContent(/no account of their own/i);
  });

  it("removes the member once confirmed", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /remove from family/i }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/families/fam-1/members/person-2", { method: "DELETE" })
    );
    // Removing someone else does not change who the caller is.
    expect(reload).not.toHaveBeenCalled();
  });

  it("calls leaving what it is, and refreshes the caller afterwards", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /leave this family/i }));
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/families/fam-1/members/person-1", { method: "DELETE" })
    );
    expect(reload).toHaveBeenCalled();
  });

  it("keeps the family on screen when a removal fails", async () => {
    api.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === "DELETE"
        ? Promise.reject(new Error("A family needs at least one member."))
        : Promise.resolve(buildFamily())
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /remove from family/i }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one member/i);
    // The whole point: the error must not replace the page.
    expect(screen.getByRole("heading", { name: "Haddad" })).toBeInTheDocument();
  });

  it("adds someone already in the directory", async () => {
    api.mockImplementation((path: string, options?: { method?: string }) => {
      if (path.endsWith("/candidates")) {
        return Promise.resolve({ candidates: [{ id: "person-9", name: "Georgi Popov" }] });
      }
      if (options?.method === "POST") return Promise.resolve(undefined);
      return Promise.resolve(buildFamily());
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /add an existing person/i }));
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
    api.mockImplementation((path: string) =>
      path.endsWith("/candidates")
        ? Promise.resolve({ candidates: [] })
        : Promise.resolve(buildFamily())
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /add an existing person/i }));
    expect(await screen.findByText(/nobody to add/i)).toBeInTheDocument();
  });
});
