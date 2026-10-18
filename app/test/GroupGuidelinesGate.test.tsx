import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { GROUP_GUIDELINES, GROUP_GUIDELINES_VERSION, type MeDto } from "@shared";
import { GroupGuidelinesGate } from "../src/components/GroupGuidelinesGate";

const apiMock = vi.fn();
const reload = vi.fn();
let agreedVersion: number | null = null;

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { groupGuidelinesAgreedVersion: agreedVersion } as unknown as MeDto,
    reload,
  }),
}));

function renderGate() {
  return render(
    <MemoryRouter initialEntries={["/groups"]}>
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route
          path="/groups"
          element={
            <GroupGuidelinesGate>
              <p>Groups page</p>
            </GroupGuidelinesGate>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("GroupGuidelinesGate", () => {
  beforeEach(() => {
    agreedVersion = null;
    apiMock.mockReset().mockResolvedValue(undefined);
    reload.mockReset().mockImplementation(async () => {
      agreedVersion = GROUP_GUIDELINES_VERSION;
    });
  });

  it("shows the guidelines instead of the page until the member agrees", () => {
    renderGate();
    expect(screen.getByRole("dialog", { name: "Group Guidelines" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(GROUP_GUIDELINES.length);
    expect(screen.queryByText("Groups page")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("keeps Agree disabled until the box is ticked, then saves and reloads", async () => {
    renderGate();
    const agree = screen.getByRole("button", { name: "Agree" });
    expect(agree).toBeDisabled();

    await userEvent.click(screen.getByLabelText("I have read and agree to these guidelines"));
    expect(agree).toBeEnabled();
    await userEvent.click(agree);

    expect(apiMock).toHaveBeenCalledWith("/me/group-guidelines", {
      method: "POST",
      body: { version: GROUP_GUIDELINES_VERSION },
      withOrg: false,
    });
    expect(reload).toHaveBeenCalled();
  });

  it("shows an error and stays open when saving fails", async () => {
    apiMock.mockRejectedValue(new Error("network"));
    renderGate();
    await userEvent.click(screen.getByLabelText("I have read and agree to these guidelines"));
    await userEvent.click(screen.getByRole("button", { name: "Agree" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByRole("dialog", { name: "Group Guidelines" })).toBeInTheDocument();
  });

  it("goes home on Not now", async () => {
    renderGate();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText("Home page")).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("ignores Escape", async () => {
    renderGate();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Group Guidelines" })).toBeInTheDocument();
  });

  it("renders the page once the current version is agreed", () => {
    agreedVersion = GROUP_GUIDELINES_VERSION;
    renderGate();
    expect(screen.getByText("Groups page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks again when the agreed version is older", () => {
    agreedVersion = GROUP_GUIDELINES_VERSION - 1;
    renderGate();
    expect(screen.getByRole("dialog", { name: "Group Guidelines" })).toBeInTheDocument();
  });
});
