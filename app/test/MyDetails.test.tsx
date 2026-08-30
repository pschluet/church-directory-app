import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MeDto } from "@shared";
import { MyDetails } from "../src/pages/MyDetails";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

const meState = {
  me: null as MeDto | null,
  isSuperAdmin: false,
};
const reload = vi.fn().mockResolvedValue(undefined);
const switchOrganization = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: meState.me,
    loading: false,
    error: null,
    reload,
    isSuperAdmin: meState.isSuperAdmin,
    isAdmin: meState.isSuperAdmin,
    organizationId: meState.me?.organization?.id ?? null,
    switchOrganization,
  }),
}));

function buildMe(overrides: {
  personId?: string | null;
  homeOrganizationId?: string | null;
  viewing?: { id: string; name: string } | null;
  available?: { id: string; name: string }[];
}): MeDto {
  return {
    appUser: {
      id: "user-1",
      email: "paul@example.com",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      organizationId: overrides.homeOrganizationId ?? null,
      organizationName: null,
      personId: overrides.personId ?? null,
      personName: null,
    },
    person: null,
    organization: overrides.viewing ?? null,
    availableOrganizations: overrides.available ?? [],
  } as unknown as MeDto;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/me"]}>
      <Routes>
        <Route path="/me" element={<MyDetails />} />
        <Route path="/people/:id" element={<p>Person page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  api.mockReset();
  reload.mockClear();
  switchOrganization.mockClear();
  meState.isSuperAdmin = false;
  meState.me = null;
});

describe("MyDetails", () => {
  it("goes straight to the record when it is in the parish being viewed", () => {
    meState.me = buildMe({
      personId: "person-1",
      homeOrganizationId: "org-1",
      viewing: { id: "org-1", name: "All Saints" },
    });
    renderPage();
    expect(screen.getByText("Person page")).toBeInTheDocument();
    expect(switchOrganization).not.toHaveBeenCalled();
  });

  it("switches to the caller's own parish first when they are viewing another", async () => {
    // GET /persons/:id is organization-scoped, so redirecting without switching
    // would land on a 404.
    meState.isSuperAdmin = true;
    meState.me = buildMe({
      personId: "person-1",
      homeOrganizationId: "org-1",
      viewing: { id: "org-2", name: "St. George" },
    });

    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/switching to your church/i);
    expect(screen.queryByText("Person page")).not.toBeInTheDocument();
    await waitFor(() => expect(switchOrganization).toHaveBeenCalledWith("org-1"));
  });

  describe("a super admin with no record", () => {
    beforeEach(() => {
      meState.isSuperAdmin = true;
      meState.me = buildMe({
        personId: null,
        homeOrganizationId: null,
        viewing: { id: "org-1", name: "All Saints" },
        available: [
          { id: "org-1", name: "All Saints" },
          { id: "org-2", name: "St. George" },
        ],
      });
    });

    it("offers a parish to join instead of a dead end", () => {
      renderPage();
      expect(screen.getByLabelText(/church/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /join this church/i })).toBeInTheDocument();
    });

    it("will not submit without a first name", () => {
      renderPage();
      expect(screen.getByRole("button", { name: /join this church/i })).toBeDisabled();
    });

    it("posts the chosen parish and name, then reloads", async () => {
      api.mockResolvedValue({});
      renderPage();

      await userEvent.selectOptions(screen.getByLabelText(/church/i), "org-2");
      await userEvent.type(screen.getByLabelText(/first name/i), "Paul");
      await userEvent.type(screen.getByLabelText(/last name/i), "Schlueter");
      await userEvent.click(screen.getByRole("button", { name: /join this church/i }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/me/organization", {
          method: "PUT",
          body: { organizationId: "org-2", firstName: "Paul", lastName: "Schlueter" },
          withOrg: false,
        })
      );
      expect(reload).toHaveBeenCalled();
    });

    it("surfaces a failure rather than looking like it worked", async () => {
      api.mockRejectedValue(new Error("Organization not found"));
      renderPage();

      await userEvent.type(screen.getByLabelText(/first name/i), "Paul");
      await userEvent.click(screen.getByRole("button", { name: /join this church/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Organization not found");
      expect(reload).not.toHaveBeenCalled();
    });

    it("says so when there are no churches to join yet", () => {
      meState.me = buildMe({ personId: null, homeOrganizationId: null, available: [] });
      renderPage();
      expect(screen.getByRole("alert")).toHaveTextContent(/no churches yet/i);
    });
  });

  it("tells an ordinary member to ask an administrator", () => {
    meState.isSuperAdmin = false;
    meState.me = buildMe({
      personId: null,
      homeOrganizationId: "org-1",
      viewing: { id: "org-1", name: "All Saints" },
    });
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(/ask a parish administrator/i);
  });
});
