import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxDto, NotificationType } from "@shared";
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

/**
 * Answers the inbox read, and records the mark-read call.
 *
 * Stateful, because the bell now settles its optimistic update against the
 * server: mark-read invalidates the inbox, so a stub that kept replying with
 * the old unread count would be modelling a server that ignores the write, and
 * the badge would correctly come back.
 *
 * `afterRead` overrides what the inbox reports once the write has happened, for
 * the case where the two legitimately disagree.
 */
function stub(value: InboxDto, { afterRead }: { afterRead?: InboxDto } = {}) {
  let current = value;
  apiMock.mockImplementation((path: string) => {
    if (path === "/notifications") return Promise.resolve(current);
    const cleared = current.unreadCount;
    current = afterRead ?? {
      unreadCount: 0,
      notifications: current.notifications.map((n) => ({ ...n, read: true })),
    };
    return Promise.resolve({ cleared });
  });
}

const notification = (
  id: string,
  title: string,
  read = false,
  type: NotificationType = "PRAYER_REQUEST"
) => ({
  id,
  type,
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
    // later -- and it stays gone once the settle refetch agrees.
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });

  it("settles the badge against the server rather than trusting the guess", async () => {
    /*
     * The regression the onSettled refetch exists to stop. The optimistic
     * update sets the badge to 0; here something arrives while the panel is
     * open, so the server still reports one unread. With polling gone that
     * refetch is the only thing that can correct the guess -- without it the
     * bell would claim zero until the next window focus, and if the write had
     * failed outright, indefinitely.
     */
    stub(inbox({ unreadCount: 2, notifications: [notification("1", "For Fr. John")] }), {
      afterRead: inbox({
        unreadCount: 1,
        notifications: [notification("2", "For safe travels")],
      }),
    });
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: /2 unread/ }));

    expect(
      await screen.findByRole("button", { name: "Notifications, 1 unread" })
    ).toBeInTheDocument();
  });

  it("does not poll", async () => {
    /*
     * Asserted rather than assumed. The bell polled every 60s until push-driven
     * invalidation replaced it, and an interval reintroduced here would cost
     * real money at scale while no other test noticed. See the plan's costing.
     */
    stub(inbox());
    renderWithProviders(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications" });

    const reads = () => apiMock.mock.calls.filter(([path]) => path === "/notifications").length;
    const before = reads();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads()).toBe(before);
  });

  it("does not call mark-read when there was nothing unread", async () => {
    stub(inbox({ unreadCount: 0, notifications: [notification("1", "Old news", true)] }));
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/notifications/read", expect.anything());
  });

  it("distinguishes a request waiting for review from a posted one", async () => {
    /*
     * The title alone is the whole message for a posted request. For one
     * waiting to be reviewed the title only says *which* request, so the label
     * is what tells the reader it needs them.
     */
    stub(
      inbox({
        unreadCount: 2,
        notifications: [
          notification("1", "For Fr. John"),
          notification("2", "For my mother", false, "PRAYER_REQUEST_REVIEW"),
        ],
      })
    );
    renderWithProviders(<NotificationBell />);

    await userEvent.click(await screen.findByRole("button", { name: /2 unread/ }));

    expect(screen.getByText(/^Prayer request ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Needs your approval ·/)).toBeInTheDocument();
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

/**
 * jsdom gives every element a 0x0 box, so placement cannot be exercised without
 * saying where things are. Describes where the panel lands from its `right-0`
 * placement, in a viewport of `viewport`.
 */
function stubGeometry({
  viewport,
  panelLeft,
  panelWidth = 288,
}: {
  viewport: number;
  panelLeft: number;
  panelWidth?: number;
}) {
  Object.defineProperty(window, "innerWidth", { writable: true, value: viewport });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isPanel = this.getAttribute("role") === "dialog";
    const left = isPanel ? panelLeft : viewport - 100 - 44;
    const width = isPanel ? panelWidth : 44;
    return {
      x: left,
      y: 0,
      top: 0,
      bottom: isPanel ? 60 : 44,
      left,
      right: left + width,
      width,
      height: isPanel ? 60 : 44,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/** The panel's left edge once the nudge in `style.right` has been applied. */
function leftEdgeOf(panel: HTMLElement, panelLeft: number): number {
  const nudge = panel.style.right === "" ? 0 : -Number.parseInt(panel.style.right, 10);
  return panelLeft + nudge;
}

describe("NotificationBell placement", () => {
  beforeEach(() => apiMock.mockReset());

  async function openPanel() {
    stub(inbox());
    renderWithProviders(<NotificationBell />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    return screen.getByRole("dialog", { name: "Notifications" });
  }

  it("leaves the panel right-aligned to the bell when it fits", async () => {
    stubGeometry({ viewport: 412, panelLeft: 24 });
    expect((await openPanel()).style.right).toBe("");
  });

  it("nudges the panel back on screen on a 360px phone", async () => {
    /*
     * The bug this guards: the panel is right-aligned to the bell, and the
     * settings gear and hamburger sit outside the bell, so 288px of panel needs
     * a 388px viewport. A 1080px screen at DPR 3 gives 360px and chopped 28px
     * off the left of the panel, with no horizontal scroll to reach the rest.
     */
    stubGeometry({ viewport: 360, panelLeft: -28 });
    const panel = await openPanel();

    expect(panel.style.right).toBe("-44px");
    expect(leftEdgeOf(panel, -28)).toBe(16);
  });

  it("keeps the left edge in view when the panel is wider than the viewport", async () => {
    // Nothing to trade: clearing the left edge fully would put the right edge
    // over the other side, so it stops at the right gutter. The left edge is
    // the one worth keeping -- it is where the text starts.
    stubGeometry({ viewport: 360, panelLeft: -100, panelWidth: 400 });
    const panel = await openPanel();

    expect(panel.style.right).toBe("-44px");
    expect(leftEdgeOf(panel, -100)).toBeLessThan(16);
  });

  it("measures again on the next open, rather than reusing the last nudge", async () => {
    stubGeometry({ viewport: 360, panelLeft: -28 });
    const panel = await openPanel();
    expect(panel.style.right).toBe("-44px");

    const bell = screen.getByRole("button", { name: "Notifications" });
    await userEvent.click(bell);
    stubGeometry({ viewport: 412, panelLeft: 24 });
    await userEvent.click(bell);

    expect(screen.getByRole("dialog", { name: "Notifications" }).style.right).toBe("");
  });
});
