import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { testQueryClient } from "./utils";

/**
 * Signing out, and the one thing it has to do besides forgetting the tokens.
 *
 * A device holds a single push subscription for the origin, so the row in
 * `push_subscriptions` belongs to whoever registered it. Leaving it behind on
 * sign-out is how a shared phone or parish tablet ends up showing the previous
 * member's notifications -- including an approver's, to somebody who cannot
 * approve. Hence the DELETE, and hence the ordering: it is an authenticated
 * call, so it cannot happen after Amplify has cleared the session.
 */

const amplifySignOut = vi.fn(() => Promise.resolve());
const order: string[] = [];

vi.mock("aws-amplify/auth", () => ({
  signOut: () => {
    order.push("amplifySignOut");
    return amplifySignOut();
  },
  getCurrentUser: () => Promise.reject(new Error("signed out")),
  fetchAuthSession: () => Promise.resolve({ tokens: undefined }),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
}));

vi.mock("aws-amplify/utils", () => ({
  Hub: { listen: () => () => undefined },
}));

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: (...args: unknown[]) => {
      order.push("delete");
      return apiMock(...args);
    },
  };
});

const registeredSubscription = vi.fn<() => Promise<{ endpoint: string } | null>>();

vi.mock("../src/lib/push", () => ({
  registeredSubscription: () => registeredSubscription(),
}));

const ENDPOINT = "https://fcm.googleapis.test/abc";

function mount() {
  const queryClient = testQueryClient();
  const clear = vi.spyOn(queryClient, "clear");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
  return { ...renderHook(() => useAuth(), { wrapper }), clear };
}

describe("signOut", () => {
  beforeEach(() => {
    order.length = 0;
    apiMock.mockReset();
    apiMock.mockResolvedValue(undefined);
    amplifySignOut.mockClear();
    registeredSubscription.mockReset();
    registeredSubscription.mockResolvedValue({ endpoint: ENDPOINT });
  });

  it("unregisters this device before clearing the session", async () => {
    const { result } = mount();

    await result.current.signOut();

    expect(apiMock).toHaveBeenCalledWith("/push/subscriptions", {
      method: "DELETE",
      body: { endpoint: ENDPOINT },
      withOrg: false,
    });
    // The DELETE needs a token, so this ordering is the point of the change.
    expect(order).toEqual(["delete", "amplifySignOut"]);
  });

  it("still signs out when the device could not be unregistered", async () => {
    apiMock.mockRejectedValue(new Error("offline"));
    const { result, clear } = mount();

    await result.current.signOut();

    expect(amplifySignOut).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
  });

  it("still signs out when the browser has no subscription to remove", async () => {
    registeredSubscription.mockResolvedValue(null);
    const { result } = mount();

    await result.current.signOut();

    expect(apiMock).not.toHaveBeenCalled();
    expect(amplifySignOut).toHaveBeenCalled();
  });

  it("still signs out when reading the subscription throws", async () => {
    registeredSubscription.mockRejectedValue(new Error("no service worker"));
    const { result } = mount();

    await result.current.signOut();

    expect(apiMock).not.toHaveBeenCalled();
    expect(amplifySignOut).toHaveBeenCalled();
  });
});
