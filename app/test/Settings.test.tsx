import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeDto } from "@shared";
import { Settings } from "../src/pages/Settings";
import { renderWithProviders } from "./utils";

/**
 * The notification settings page.
 *
 * The cases worth having are the ones an iPhone hits and a laptop never does:
 * push is unavailable in a Safari tab and the page has to say why, and once
 * permission is refused it can never be asked for again. Both are stubbed here
 * because jsdom has no PushManager at all.
 */

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const pushState = {
  availability: "ready" as "ready" | "denied" | "needs-install" | "unsupported" | "not-configured",
  subscription: null as { endpoint: string; toJSON: () => unknown; unsubscribe: () => void } | null,
  subscribeResult: null as { endpoint: string; toJSON: () => unknown } | null,
};

vi.mock("../src/lib/push", () => ({
  pushAvailability: () => pushState.availability,
  currentSubscription: () => Promise.resolve(pushState.subscription),
  subscribeThisDevice: () => Promise.resolve(pushState.subscribeResult),
  isInstalled: () => false,
}));

const meState = {
  pushPublicKey: "vapid-public-key" as string | null,
  canApprove: false,
};

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { pushPublicKey: meState.pushPublicKey } as unknown as MeDto,
    canApprovePrayerRequests: meState.canApprove,
  }),
}));

const SUBSCRIPTION = {
  endpoint: "https://push.example.test/abc",
  toJSON: () => ({
    endpoint: "https://push.example.test/abc",
    keys: { p256dh: "p", auth: "a" },
  }),
  unsubscribe: vi.fn(() => Promise.resolve(true)),
};

describe("Settings", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === "/notifications/preferences") {
        return Promise.resolve({ prayerRequests: true, prayerRequestReviews: true });
      }
      return Promise.resolve({});
    });
    pushState.availability = "ready";
    pushState.subscription = null;
    pushState.subscribeResult = SUBSCRIPTION;
    meState.pushPublicKey = "vapid-public-key";
    meState.canApprove = false;
  });

  /*
   * The only reason this page knows about maps: the choice is made in the
   * sheet on the address, and without this row there is nowhere to take it
   * back. See the note in maps.test.ts for why the store has to be supplied.
   */
  describe("the remembered maps app", () => {
    function fakeStorage(seed?: string): void {
      const entries = new Map<string, string>();
      if (seed) entries.set("directory.mapsProvider", seed);
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => entries.get(key) ?? null,
          setItem: (key: string, value: string) => void entries.set(key, value),
          removeItem: (key: string) => void entries.delete(key),
        },
      });
    }

    afterEach(() => {
      Reflect.deleteProperty(globalThis, "localStorage");
    });

    it("is not mentioned at all by somebody who never made a choice", async () => {
      fakeStorage();
      renderWithProviders(<Settings />);
      await screen.findByRole("heading", { name: "Notifications" });

      // A row saying there is nothing to reset is a row nobody needs.
      expect(screen.queryByRole("heading", { name: "Maps" })).not.toBeInTheDocument();
      expect(screen.getByText("Choose what the directory tells you about.")).toBeInTheDocument();
    });

    it("names the app and offers to start asking again", async () => {
      fakeStorage("apple");
      renderWithProviders(<Settings />);

      expect(await screen.findByRole("heading", { name: "Maps" })).toBeInTheDocument();
      expect(screen.getByText(/addresses open in Apple Maps without asking/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /ask me again/i }));

      expect(screen.queryByRole("heading", { name: "Maps" })).not.toBeInTheDocument();
      expect(localStorage.getItem("directory.mapsProvider")).toBeNull();
    });
  });

  it("offers both switches when push is available", async () => {
    renderWithProviders(<Settings />);
    expect(await screen.findByRole("checkbox", { name: /Push notifications/ })).not.toBeChecked();
    expect(await screen.findByRole("checkbox", { name: /New prayer requests/ })).toBeChecked();
  });

  it("says up front what notifications actually do", async () => {
    // The first cut of this page led with "notifications are not set up", which
    // read as though the feature did not exist. It does; this is the sentence
    // that has to say so.
    renderWithProviders(<Settings />);
    expect(await screen.findByText(/badge on the bell/i)).toBeInTheDocument();
    expect(screen.getByText(/notification on your phone or computer/i)).toBeInTheDocument();
  });

  it("puts both switches under the Notifications heading", async () => {
    renderWithProviders(<Settings />);
    const section = (await screen.findByRole("heading", { name: "Notifications" })).closest(
      "section"
    );
    expect(section).not.toBeNull();
    expect(section).toHaveTextContent("Notify me about");
    expect(section).toHaveTextContent("New prayer requests");
    expect(section).toHaveTextContent("On this device");
  });

  it("says the two switches compose, rather than leaving push on with nothing to send", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/notifications/preferences") {
        return Promise.resolve({ prayerRequests: false, prayerRequestReviews: false });
      }
      return Promise.resolve({});
    });
    renderWithProviders(<Settings />);
    expect(
      await screen.findByText(/Nothing to send while everything above is switched off/)
    ).toBeInTheDocument();
  });

  it("subscribes and registers the device", async () => {
    renderWithProviders(<Settings />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /Push notifications/ }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/push/subscriptions", {
        method: "POST",
        body: SUBSCRIPTION.toJSON(),
        withOrg: false,
      })
    );
    expect(await screen.findByRole("checkbox", { name: /Push notifications/ })).toBeChecked();
  });

  it("stays off, without an error, when the browser prompt is declined", async () => {
    pushState.subscribeResult = null;
    renderWithProviders(<Settings />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /Push notifications/ }));

    await waitFor(() =>
      expect(apiMock).not.toHaveBeenCalledWith("/push/subscriptions", expect.anything())
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("unsubscribes the device and the server", async () => {
    pushState.subscription = SUBSCRIPTION;
    renderWithProviders(<Settings />);

    const toggle = await screen.findByRole("checkbox", { name: /Push notifications/ });
    await waitFor(() => expect(toggle).toBeChecked());

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/push/subscriptions", {
        method: "DELETE",
        body: { endpoint: SUBSCRIPTION.endpoint },
        withOrg: false,
      })
    );
    expect(SUBSCRIPTION.unsubscribe).toHaveBeenCalled();
  });

  describe("the approval switch", () => {
    /*
     * Separate from the posted-requests switch because they are separate
     * things: one is news, the other is work. Shown only to the people who
     * would ever get one -- for anybody else it would be a switch with no
     * effect.
     */
    it("is offered to an approver, alongside the posted-requests one", async () => {
      meState.canApprove = true;
      renderWithProviders(<Settings />);

      expect(await screen.findByRole("checkbox", { name: /New prayer requests/ })).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: /Requests waiting for my approval/ })
      ).toBeChecked();
    });

    it("is hidden from somebody who cannot approve", async () => {
      renderWithProviders(<Settings />);
      await screen.findByRole("checkbox", { name: /New prayer requests/ });
      expect(
        screen.queryByRole("checkbox", { name: /Requests waiting for my approval/ })
      ).not.toBeInTheDocument();
    });

    it("saves only itself, leaving the posted-requests switch alone", async () => {
      meState.canApprove = true;
      renderWithProviders(<Settings />);

      await userEvent.click(
        await screen.findByRole("checkbox", { name: /Requests waiting for my approval/ })
      );

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/notifications/preferences", {
          method: "PUT",
          body: { prayerRequestReviews: false },
          withOrg: false,
        })
      );
    });

    it("reassures the approver that switching it off does not remove the work", async () => {
      // The obvious fear on reading it, and the one thing that would stop
      // somebody from using the switch at all.
      meState.canApprove = true;
      renderWithProviders(<Settings />);
      expect(await screen.findByText(/does not stop you approving them/i)).toBeInTheDocument();
      expect(screen.getByText(/still show on the Prayer Requests page/i)).toBeInTheDocument();
    });

    it("explains in plain terms what it is about", async () => {
      meState.canApprove = true;
      renderWithProviders(<Settings />);
      expect(
        await screen.findByText(/needs your approval before the parish can see it/i)
      ).toBeInTheDocument();
    });
  });

  it("saves the prayer request preference", async () => {
    renderWithProviders(<Settings />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /New prayer requests/ }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/notifications/preferences", {
        method: "PUT",
        body: { prayerRequests: false },
        withOrg: false,
      })
    );
  });

  describe("when push cannot work here", () => {
    it("tells an iPhone user to add the app to the home screen", async () => {
      pushState.availability = "needs-install";
      renderWithProviders(<Settings />);

      expect(
        await screen.findByText(/Add the directory to your home screen first/)
      ).toBeInTheDocument();
      expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
      // No switch that would silently do nothing.
      expect(
        screen.queryByRole("checkbox", { name: /Push notifications/ })
      ).not.toBeInTheDocument();
    });

    it("points at the OS settings once permission has been refused", async () => {
      pushState.availability = "denied";
      renderWithProviders(<Settings />);

      expect(await screen.findByText(/Push notifications are blocked/)).toBeInTheDocument();
      expect(screen.getByText(/Settings → Notifications → Directory/)).toBeInTheDocument();
    });

    it("says so when the parish has no keypair, and keeps the bell working", async () => {
      pushState.availability = "not-configured";
      meState.pushPublicKey = null;
      renderWithProviders(<Settings />);

      expect(
        await screen.findByText(/Push notifications are not switched on for this directory/)
      ).toBeInTheDocument();
      // The category switch still matters: it also governs the in-app bell.
      expect(
        await screen.findByRole("checkbox", { name: /New prayer requests/ })
      ).toBeInTheDocument();
    });

    it("says so on a browser that cannot do push at all", async () => {
      pushState.availability = "unsupported";
      renderWithProviders(<Settings />);
      expect(await screen.findByText(/cannot show push notifications/)).toBeInTheDocument();
    });

    it("never blames the whole feature when only push is unavailable", async () => {
      // Every unavailable state has to say *push*, and has to leave the reader
      // knowing the bell still works. The old copy did neither, which is what
      // made the page read as "notifications were never built".
      for (const availability of ["needs-install", "denied", "not-configured"] as const) {
        pushState.availability = availability;
        const { unmount } = renderWithProviders(<Settings />);
        expect(await screen.findByText(/push notification/i)).toBeInTheDocument();
        expect(
          screen.queryByText(/notifications are not set up|were not set up/i)
        ).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
