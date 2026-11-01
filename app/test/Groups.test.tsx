import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupSummaryDto, MeDto } from "@shared";
import { Groups } from "../src/pages/Groups";
import { renderWithProviders } from "./utils";

const apiMock = vi.fn();
const adminState = { isAdmin: false };

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { personId: "person-me" } } as unknown as MeDto,
    isAdmin: adminState.isAdmin,
    organizationId: "org-1",
  }),
}));

function group(overrides: Partial<GroupSummaryDto>): GroupSummaryDto {
  return {
    id: "g1",
    title: "Youth Group",
    description: null,
    visibility: "PUBLIC",
    memberCount: 3,
    archivedAt: null,
    myRole: "MEMBER",
    unreadCount: 0,
    pendingJoinRequestId: null,
    pinned: false,
    parishWide: false,
    ...overrides,
  };
}

describe("Groups", () => {
  beforeEach(() => {
    adminState.isAdmin = false;
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === "/groups")
        return Promise.resolve({
          groups: [
            group({ id: "g1", title: "Youth Group" }),
            group({ id: "g2", title: "Choir", pinned: true }),
          ],
        });
      return Promise.resolve({ reports: [] });
    });
  });

  it("marks the typed fragment inside a matching title", async () => {
    renderWithProviders(<Groups />, { initialEntries: ["/groups?q=yout"] });
    const mark = await screen.findByText("Yout", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(screen.queryByText("Choir")).not.toBeInTheDocument();
  });

  it("renders titles plainly when nothing is being searched", async () => {
    renderWithProviders(<Groups />);
    await screen.findByText("Youth Group");
    expect(document.querySelector("mark")).toBeNull();
  });

  it("shows each group's visibility and member count on one line, without its description", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/groups"
        ? Promise.resolve({
            groups: [
              group({ id: "g1", title: "Open", visibility: "PUBLIC", memberCount: 1 }),
              group({
                id: "g2",
                title: "Closed",
                visibility: "PRIVATE",
                memberCount: 12,
                description: "Not shown here",
              }),
              group({ id: "g3", title: "Hidden", visibility: "SECRET", memberCount: 4 }),
            ],
          })
        : Promise.resolve({ reports: [] })
    );
    renderWithProviders(<Groups />);
    const row = (title: string) => screen.getByText(title).closest("a")!;
    await screen.findByText("Open");
    expect(row("Open")).not.toHaveTextContent("Public group");
    expect(row("Open").querySelector("svg title, [title$='group']")).toBeNull();
    expect(row("Open")).toHaveTextContent(/1\s*member$/);
    expect(row("Closed")).toHaveTextContent("Private group");
    expect(row("Closed")).toHaveTextContent(/12\s*members$/);
    expect(row("Hidden")).toHaveTextContent("Secret group");
    expect(row("Hidden").querySelector(".text-primary svg")).not.toBeNull();
    expect(screen.queryByText("Not shown here")).not.toBeInTheDocument();
  });

  it("bolds a group with unread messages instead of showing unread or admin badges", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/groups"
        ? Promise.resolve({
            groups: [
              group({ id: "g1", title: "Busy", unreadCount: 2, myRole: "ADMIN" }),
              group({ id: "g2", title: "Quiet", unreadCount: 0 }),
            ],
          })
        : Promise.resolve({ reports: [] })
    );
    renderWithProviders(<Groups />);
    const busy = (await screen.findByText("Busy")).closest("h3")!;
    const quiet = screen.getByText("Quiet").closest("h3")!;
    expect(busy).toHaveClass("font-bold");
    expect(busy).toHaveTextContent("unread messages");
    expect(quiet).toHaveClass("font-normal");
    expect(quiet).not.toHaveClass("font-bold");
    expect(screen.queryByText("2 new")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });

  it("toggles a star from the row", async () => {
    renderWithProviders(<Groups />);
    const pinned = await screen.findByRole("button", { name: "Unstar Choir" });
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Star Youth Group" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await userEvent.click(pinned);
    expect(apiMock).toHaveBeenCalledWith("/groups/g2/pin", { method: "DELETE" });
  });

  it("marks a parish-wide group with a badge", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/groups"
        ? Promise.resolve({
            groups: [
              group({ id: "g1", title: "Everyone", parishWide: true }),
              group({ id: "g2", title: "Choir" }),
            ],
          })
        : Promise.resolve({ reports: [] })
    );
    renderWithProviders(<Groups />);
    await screen.findByText("Everyone");
    expect(screen.getByText("Everyone").closest("a")).toHaveTextContent("Parish wide");
    expect(screen.getByText("Everyone").closest("a")).not.toHaveTextContent(/member/);
    expect(screen.getByText("Choir").closest("a")).not.toHaveTextContent("Parish wide");
    expect(screen.getByText("Choir").closest("a")).toHaveTextContent(/3\s*members$/);
  });

  describe("starting a group", () => {
    async function openCreate() {
      renderWithProviders(<Groups />);
      await screen.findByText("Youth Group");
      await userEvent.click(screen.getByRole("button", { name: "Start a group" }));
    }

    it("offers Parish wide to an admin, and sends it", async () => {
      adminState.isAdmin = true;
      await openCreate();
      await userEvent.type(await screen.findByRole("textbox", { name: "Title" }), "Everyone");
      await userEvent.click(screen.getByRole("checkbox", { name: /Parish wide/ }));
      await userEvent.click(screen.getByRole("button", { name: "Create" }));
      expect(apiMock).toHaveBeenCalledWith(
        "/groups",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ parishWide: true }),
        })
      );
    });

    it("only offers Parish wide while the group is public", async () => {
      adminState.isAdmin = true;
      await openCreate();
      await userEvent.click(await screen.findByRole("radio", { name: /Private/ }));
      expect(screen.queryByRole("checkbox", { name: /Parish wide/ })).not.toBeInTheDocument();
    });

    it("does not offer Parish wide to anyone else", async () => {
      await openCreate();
      await screen.findByRole("textbox", { name: "Title" });
      expect(screen.queryByRole("checkbox", { name: /Parish wide/ })).not.toBeInTheDocument();
    });
  });
});
