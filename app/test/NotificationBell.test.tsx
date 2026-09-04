import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxDto } from "@shared";
import { NotificationBell } from "../src/components/NotificationBell";
import { renderWithProviders } from "./utils";

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

function inbox(overrides: Partial<InboxDto> = {}): InboxDto {
  return {
    unreadCount: 0,
    notifications: [],
    ...overrides,
  };
}

/** Answers the inbox read, and records the mark-read call. */
function stub(value: InboxDto) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/notifications") return Promise.resolve(value);
    return Promise.resolve({ cleared: value.unreadCount });
  });
}

const notification = (id: string, title: string, read = false) => ({
  id,
  type: "PRAYER_REQUEST" as const,
  title,
  prayerRequestId: `pr-${id}`,
  createdAt: new Date().toISOString(),
  read,
});

describe("NotificationBell", () => {
  beforeEach(() => apiMock.mockReset());

  it("shows no badge when nothing is unread", async () => {
    stub(inbox());
    renderWithProviders(<NotificationBell />);
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });

  it("puts the count in the badge and in the accessible name", async () => {
    stub(inbox({ unreadCount: 3, notifications: [notification("1", "For Fr. John")] }));
    renderWithProviders(<NotificationBell />);

    const button = await screen.findByRole("button", { name: "Notifications, 3 unread" });
    expect(button).toHaveTextContent("3");
  });

  it("caps the badge at 9+, where the exact number stops mattering", async () => {
    stub(inbox({ unreadCount: 42, notifications: [] }));
    renderWithProviders(<NotificationBell />);

    const button = await screen.findByRole("button", { name: "Notifications, 42 unread" });
    expect(button).toHaveTextContent("9+");
  });

  it("lists each notification by title, linking to the page", async () => {
    stub(
      inbox({
        unreadCount: 2,
        notifications: [notification("1", "For Fr. John"), notification("2", "For safe travels")],
      })
    );
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: /2 unread/ }));

    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("For Fr. John")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getAllByRole("link")[0]).toHaveAttribute("href", "/prayer-requests");
  });

  it("clears the badge as the panel opens", async () => {
    stub(inbox({ unreadCount: 2, notifications: [notification("1", "For Fr. John")] }));
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: /2 unread/ }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/notifications/read", {
        method: "POST",
        withOrg: false,
      })
    );
    // Optimistically, so the badge goes with the tap rather than a round trip
    // later.
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });

  it("does not call mark-read when there was nothing unread", async () => {
    stub(inbox({ unreadCount: 0, notifications: [notification("1", "Old news", true)] }));
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/notifications/read", expect.anything());
  });

  it("says so when the panel is empty", async () => {
    stub(inbox());
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Nothing new.")).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the bell", async () => {
    stub(inbox({ unreadCount: 1, notifications: [notification("1", "For Fr. John")] }));
    renderWithProviders(<NotificationBell />);

    const button = await screen.findByRole("button", { name: /1 unread/ });
    await userEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /notifications/i })).toHaveFocus();
  });

  it("closes on a tap outside it", async () => {
    stub(inbox({ unreadCount: 1, notifications: [notification("1", "For Fr. John")] }));
    renderWithProviders(
      <>
        <NotificationBell />
        <p>Elsewhere</p>
      </>
    );

    await userEvent.click(await screen.findByRole("button", { name: /1 unread/ }));
    await userEvent.click(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("reads the inbox without an orgId, since it belongs to the account", async () => {
    stub(inbox());
    renderWithProviders(<NotificationBell />);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/notifications",
        expect.objectContaining({ withOrg: false })
      )
    );
  });
});
