import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { InboxDto, NotificationDto } from "@shared";
import { useMarkReadOnArrival } from "../src/components/useMarkReadOnArrival";
import { qk } from "../src/lib/queryKeys";
import { renderWithProviders, testQueryClient } from "./utils";

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

function Probe() {
  useMarkReadOnArrival();
  return null;
}

const row = (id: string, groupPostId: string | null, read = false): NotificationDto => ({
  id,
  type: "GROUP_POST",
  prayerRequestId: null,
  groupId: "g1",
  groupPostId,
  groupPostParentId: null,
  groupPostParentKind: null,
  directoryRequestId: null,
  title: "Choir",
  createdAt: new Date().toISOString(),
  read,
});

describe("useMarkReadOnArrival", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) =>
      path === "/notifications" ? new Promise(() => {}) : Promise.resolve({ cleared: 1 })
    );
  });

  function seeded(): ReturnType<typeof testQueryClient> {
    const queryClient = testQueryClient();
    queryClient.setQueryData<InboxDto>(qk.notifications(), {
      unreadCount: 3,
      notifications: [row("n1", "p1"), row("n2", "p2"), row("n3", "p3")],
    });
    return queryClient;
  }

  it("marks the message read when arriving from a push", async () => {
    const queryClient = seeded();
    renderWithProviders(<Probe />, {
      initialEntries: ["/groups/g1?message=p2&from=push"],
      queryClient,
    });

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/notifications/posts/p2/read", {
        method: "POST",
        withOrg: false,
      })
    );
    const inbox = queryClient.getQueryData<InboxDto>(qk.notifications());
    expect(inbox?.unreadCount).toBe(2);
    expect(inbox?.notifications.find((n) => n.id === "n2")?.read).toBe(true);
    expect(inbox?.notifications.find((n) => n.id === "n1")?.read).toBe(false);
  });

  it("marks the message read when arriving from an email", async () => {
    const queryClient = seeded();
    renderWithProviders(<Probe />, {
      initialEntries: ["/groups/g1/threads/p1?message=p3&from=email"],
      queryClient,
    });

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/notifications/posts/p3/read", {
        method: "POST",
        withOrg: false,
      })
    );
    expect(queryClient.getQueryData<InboxDto>(qk.notifications())?.unreadCount).toBe(2);
  });

  it("leaves a plain message link (the bell's) alone", async () => {
    const queryClient = seeded();
    renderWithProviders(<Probe />, {
      initialEntries: ["/groups/g1?message=p2"],
      queryClient,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMock).not.toHaveBeenCalledWith("/notifications/posts/p2/read", expect.anything());
    expect(queryClient.getQueryData<InboxDto>(qk.notifications())?.unreadCount).toBe(3);
  });
});
