import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupSummaryDto, MeDto } from "@shared";
import { Groups } from "../src/pages/Groups";
import { renderWithProviders } from "./utils";

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { personId: "person-me" } } as unknown as MeDto,
    organizationId: "org-1",
  }),
}));

function group(overrides: Partial<GroupSummaryDto>): GroupSummaryDto {
  return {
    id: "g1",
    title: "Youth Group",
    description: null,
    thumbUrl: null,
    fullUrl: null,
    cardUrl: null,
    visibility: "PUBLIC",
    memberCount: 3,
    archivedAt: null,
    myRole: "MEMBER",
    unreadCount: 0,
    pendingJoinRequestId: null,
    pinned: false,
    ...overrides,
  };
}

describe("Groups", () => {
  beforeEach(() => {
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

  it("keeps a long name clear of the star when the card has no photo, and not when it has one", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/groups"
        ? Promise.resolve({
            groups: [
              group({ id: "g1", title: "A very long group name without a picture" }),
              group({
                id: "g2",
                title: "A very long group name with a picture",
                cardUrl: "/card.webp",
              }),
            ],
          })
        : Promise.resolve({ reports: [] })
    );
    renderWithProviders(<Groups />);
    const plain = (await screen.findByText("A very long group name without a picture")).closest(
      "div.flex"
    );
    const pictured = screen.getByText("A very long group name with a picture").closest("div.flex");
    expect(plain?.className).toContain("pr-8");
    expect(pictured?.className).not.toContain("pr-8");
  });

  it("toggles a star from the card", async () => {
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
});
