import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxDto } from "@shared";
import { syncAppBadge } from "../src/lib/appBadge";
import { useAppBadge } from "../src/components/useAppBadge";
import { NotificationBell } from "../src/components/NotificationBell";
import { renderWithProviders } from "./utils";

/*
 * The home-screen icon's number. jsdom has no Badging API, which is also the
 * shape of every browser that does not support it, so each case installs the
 * two methods it needs and removes them afterwards.
 */

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const setAppBadge = vi.fn<(n?: number) => Promise<void>>();
const clearAppBadge = vi.fn<() => Promise<void>>();

function installBadging(): void {
  Object.assign(navigator, { setAppBadge, clearAppBadge });
}

function removeBadging(): void {
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.setAppBadge;
  delete nav.clearAppBadge;
}

beforeEach(() => {
  apiMock.mockReset();
  setAppBadge.mockReset().mockResolvedValue(undefined);
  clearAppBadge.mockReset().mockResolvedValue(undefined);
});
afterEach(removeBadging);

describe("syncAppBadge", () => {
  it("sets the count when something is unread", () => {
    installBadging();
    syncAppBadge(4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge at zero rather than showing a 0", () => {
    installBadging();
    syncAppBadge(0);
    expect(clearAppBadge).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("does nothing where the API does not exist", () => {
    expect(() => syncAppBadge(3)).not.toThrow();
  });

  it("swallows a rejection, which is what iOS does without permission", async () => {
    installBadging();
    setAppBadge.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    syncAppBadge(2);
    // Let the rejection settle; an unhandled one would fail the run.
    await Promise.resolve();
    expect(setAppBadge).toHaveBeenCalledWith(2);
  });
});

function Harness() {
  useAppBadge();
  return <NotificationBell />;
}

describe("useAppBadge", () => {
  it("puts the bell's count on the icon, and clears it when the bell is opened", async () => {
    installBadging();
    let current: InboxDto = { unreadCount: 3, notifications: [] };
    apiMock.mockImplementation((path: string) => {
      if (path === "/notifications") return Promise.resolve(current);
      current = { unreadCount: 0, notifications: [] };
      return Promise.resolve({ cleared: 3 });
    });

    renderWithProviders(<Harness />);

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(3));
    expect(clearAppBadge).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /notifications, 3 unread/i }));

    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
  });

  it("leaves the icon alone until the inbox has loaded", () => {
    installBadging();
    apiMock.mockReturnValue(new Promise(() => undefined));

    renderWithProviders(<Harness />);

    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
