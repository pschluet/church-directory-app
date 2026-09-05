import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./utils";
import type { FamilySummaryDto, MeDto } from "@shared";
import { Families } from "../src/pages/Families";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

const meState = {
  personId: null as string | null,
  familyId: null as string | null,
  isAdmin: false,
};
const reload = vi.fn().mockResolvedValue(undefined);
const navigate = vi.fn();

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: {
      appUser: { personId: meState.personId },
      person: meState.familyId ? { familyId: meState.familyId } : null,
      organization: { id: "org-1", name: "All Saints" },
      availableOrganizations: [],
    } as unknown as MeDto,
    loading: false,
    error: null,
    reload,
    isAdmin: meState.isAdmin,
    isSuperAdmin: false,
    organizationId: "org-1",
    switchOrganization: vi.fn(),
  }),
}));

function family(
  overrides: Partial<FamilySummaryDto> & { id: string; name: string }
): FamilySummaryDto {
  return {
    memberCount: 1,
    memberNames: [],
    pendingJoinRequestId: null,
    ...overrides,
  };
}

const HADDAD = family({
  id: "fam-1",
  name: "Haddad",
  memberCount: 3,
  memberNames: ["Layla", "Sami"],
});
const NASSIF = family({ id: "fam-2", name: "Nassif" });

function renderPage() {
  return renderWithProviders(<Families />, { initialEntries: ["/families"] });
}

describe("Families", () => {
  beforeEach(() => {
    api.mockReset();
    reload.mockClear();
    navigate.mockClear();
    meState.personId = "person-1";
    meState.familyId = null;
    meState.isAdmin = false;
    api.mockResolvedValue({ families: [HADDAD, NASSIF] });
  });

  it("lists families with their size and a few members", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "Haddad" })).toBeInTheDocument();
    expect(screen.getByText(/3 members — Layla, Sami/)).toBeInTheDocument();
  });

  it("marks the caller's own family instead of offering to join it", async () => {
    meState.familyId = "fam-1";
    renderPage();

    expect(await screen.findByText("Your family")).toBeInTheDocument();
    // The other one is still joinable.
    expect(screen.getAllByRole("button", { name: /ask to join/i })).toHaveLength(1);
  });

  it("remembers a request that is already outstanding, and says what it waits on", async () => {
    api.mockResolvedValue({
      families: [{ ...HADDAD, pendingJoinRequestId: "req-1" }, NASSIF],
    });
    renderPage();

    expect(await screen.findByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /ask to join/i })).toHaveLength(1);
    // The badge alone is a silent swap in the space the button occupied.
    expect(screen.getByText(/You have asked to join the Haddad family/)).toBeInTheDocument();
  });

  it("names every family it is waiting on", async () => {
    api.mockResolvedValue({
      families: [
        { ...HADDAD, pendingJoinRequestId: "req-1" },
        { ...NASSIF, pendingJoinRequestId: "req-2" },
      ],
    });
    renderPage();

    // A pending request is unique per family, not per person, so several at
    // once is a real state and the copy has to be plural.
    expect(await screen.findByText(/You have asked to join 2 families/)).toBeInTheDocument();
    expect(screen.getByText(/Haddad, Nassif/)).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for approval")).toHaveLength(2);
  });

  it("says nothing about waiting when nothing is outstanding", async () => {
    renderPage();

    await screen.findAllByRole("button", { name: /ask to join/i });
    expect(screen.queryByText(/You have asked to join/)).not.toBeInTheDocument();
  });

  it("asks to join and refreshes who the caller is", async () => {
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: /ask to join/i });
    await userEvent.click(buttons[0]!);

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/families/fam-1/join-requests", { method: "POST" })
    );
    expect(reload).toHaveBeenCalled();
  });

  it("warns before moving out of a family the caller already belongs to", async () => {
    meState.familyId = "fam-2";
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /ask to join/i }));

    // Nothing is sent until the warning is accepted.
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toHaveTextContent(/you will move to Haddad/i);

    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/families/fam-1/join-requests", { method: "POST" })
    );
  });

  it("explains itself rather than offering to join when the caller has no record", async () => {
    meState.personId = null;
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/directory record is missing/i);
    expect(screen.queryByRole("button", { name: /ask to join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create a family/i })).not.toBeInTheDocument();
  });

  describe("creating one", () => {
    it("puts a member in the family they create, with no choice about it", async () => {
      api.mockImplementation((_path: string, options?: { method?: string }) =>
        options?.method === "POST"
          ? Promise.resolve({ id: "fam-9", name: "Ivanov" })
          : Promise.resolve({ families: [HADDAD] })
      );
      renderPage();

      await userEvent.click(await screen.findByRole("button", { name: /create a family/i }));
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

      await userEvent.type(screen.getByLabelText(/family name/i), "Ivanov");
      await userEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families", {
          method: "POST",
          body: { name: "Ivanov", join: true },
        })
      );
      expect(reload).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/families/fam-9");
    });

    it("lets an admin set one up for someone else without joining", async () => {
      meState.isAdmin = true;
      api.mockImplementation((_path: string, options?: { method?: string }) =>
        options?.method === "POST"
          ? Promise.resolve({ id: "fam-9", name: "Ivanov" })
          : Promise.resolve({ families: [HADDAD] })
      );
      renderPage();

      await userEvent.click(await screen.findByRole("button", { name: /create a family/i }));
      // Defaulting this on would quietly move the admin out of their own family.
      expect(screen.getByRole("checkbox")).not.toBeChecked();

      await userEvent.type(screen.getByLabelText(/family name/i), "Ivanov");
      await userEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/families", {
          method: "POST",
          body: { name: "Ivanov", join: false },
        })
      );
      expect(navigate).not.toHaveBeenCalled();
    });

    it("points out a name that is already taken without blocking it", async () => {
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: /create a family/i }));
      await userEvent.type(screen.getByLabelText(/family name/i), "Haddad");

      expect(screen.getByText(/already a family called Haddad/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    });
  });

  it("reports a failure without losing the page", async () => {
    api.mockRejectedValue(new Error("Postgres is asleep"));
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Postgres is asleep");
    expect(screen.getByRole("heading", { name: "Families" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
