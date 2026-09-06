import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MeDto } from "@shared";
import { usePushRegistration } from "../src/components/usePushRegistration";

/**
 * The hook that moves this device's push subscription to whoever signed in.
 *
 * The cases that matter are the ones a laptop never reaches: a shared tablet
 * where the row belongs to the previous account, and the several states in
 * which this hook must do *nothing*. The last group is the important one --
 * asking for permission outside a user gesture, or posting a subscription the
 * browser does not have, are both worse than staying quiet.
 */

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const registeredSubscription =
  vi.fn<() => Promise<{ endpoint: string; toJSON: () => unknown } | null>>();
const subscribeThisDevice = vi.fn();

vi.mock("../src/lib/push", () => ({
  registeredSubscription: () => registeredSubscription(),
  subscribeThisDevice: (...args: unknown[]) => subscribeThisDevice(...args),
}));

const meState = { appUserId: "user-1" as string | null };

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: meState.appUserId ? ({ appUser: { id: meState.appUserId } } as unknown as MeDto) : null,
  }),
}));

const originalNotification = globalThis.Notification;

function withPermission(permission: NotificationPermission | null): void {
  if (permission === null) {
    // @ts-expect-error -- modelling a browser with no Notification API
    delete globalThis.Notification;
    return;
  }
  Object.defineProperty(globalThis, "Notification", {
    value: { permission, requestPermission: vi.fn() },
    configurable: true,
    writable: true,
  });
}

/**
 * Long enough for the hook's effect to have posted if it were going to.
 *
 * `await Promise.resolve()` is not: the hook awaits `registeredSubscription`
 * before it can reach the POST, so a single microtask tick lets every negative
 * case below pass against a hook with no guards at all. Verified by removing
 * them -- with a bare microtask flush the suite stayed green.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function subscription(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

const POSTED = {
  endpoint: "https://fcm.googleapis.test/abc",
  keys: { p256dh: "p", auth: "a" },
};

describe("usePushRegistration", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ subscribed: true });
    subscribeThisDevice.mockReset();
    registeredSubscription.mockReset();
    registeredSubscription.mockResolvedValue(subscription("https://fcm.googleapis.test/abc"));
    meState.appUserId = "user-1";
    withPermission("granted");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "Notification", {
      value: originalNotification,
      configurable: true,
      writable: true,
    });
  });

  it("re-registers the existing subscription for the signed-in account", async () => {
    renderHook(() => usePushRegistration());

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/push/subscriptions", {
        method: "POST",
        body: POSTED,
        withOrg: false,
      })
    );
  });

  it("never asks for permission, which only a user gesture may do", async () => {
    renderHook(() => usePushRegistration());

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(subscribeThisDevice).not.toHaveBeenCalled();
    expect(
      (globalThis.Notification as unknown as { requestPermission: () => void }).requestPermission
    ).not.toHaveBeenCalled();
  });

  it("stays quiet when nobody has been asked yet", async () => {
    // `default`, not `denied`: turning push on is the switch's job, and this
    // hook must not pre-empt it.
    withPermission("default");
    renderHook(() => usePushRegistration());

    await settle();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("stays quiet once permission has been refused", async () => {
    withPermission("denied");
    renderHook(() => usePushRegistration());

    await settle();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("stays quiet in a browser with no Notification API at all", async () => {
    withPermission(null);
    const { unmount } = renderHook(() => usePushRegistration());

    await settle();
    expect(apiMock).not.toHaveBeenCalled();
    unmount();
  });

  it("has nothing to post when this browser holds no subscription", async () => {
    registeredSubscription.mockResolvedValue(null);
    renderHook(() => usePushRegistration());

    await settle();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does nothing until an account is loaded", async () => {
    meState.appUserId = null;
    renderHook(() => usePushRegistration());

    await settle();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does not re-post when only the surrounding render changed", async () => {
    // Covers the effect's dependency list rather than the guard below it: a
    // re-render with the same account must not reach the network again.
    const { rerender } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    await settle();

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("does not post the same account and endpoint twice", async () => {
    /*
     * What the (account, endpoint) guard is for. The effect re-runs whenever
     * the signed-in id changes, and `me` briefly reading null and then the same
     * account again -- a /me refetch that errors and recovers -- would
     * otherwise upsert the identical row a second time on every flap.
     *
     * StrictMode (src/main.tsx) is the other reason it is there, though it
     * cannot be shown here: React only double-invokes effects in a development
     * build, and this environment runs the effect once.
     */
    const { rerender } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    meState.appUserId = null;
    rerender();
    await settle();

    meState.appUserId = "user-1";
    rerender();
    await settle();

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("does not post a subscription that resolved after the hook went away", async () => {
    // The `cancelled` half of the same guard. Signing out mid-flight is the
    // real case: the token is gone by the time the POST would be built.
    let release: (value: { endpoint: string; toJSON: () => unknown } | null) => void = () => {};
    registeredSubscription.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const { unmount } = renderHook(() => usePushRegistration());
    unmount();
    release(subscription("https://fcm.googleapis.test/abc"));
    await settle();

    expect(apiMock).not.toHaveBeenCalled();
  });

  it("posts again when a different account signs in on the same device", async () => {
    // The shared-tablet case this hook exists for: same endpoint, new owner.
    const { rerender } = renderHook(() => usePushRegistration());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    meState.appUserId = "user-2";
    rerender();

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock).toHaveBeenLastCalledWith("/push/subscriptions", {
      method: "POST",
      body: POSTED,
      withOrg: false,
    });
  });

  it("retries on the next mount when the post fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("offline"));
    const first = renderHook(() => usePushRegistration());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    first.unmount();

    renderHook(() => usePushRegistration());

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });
});
