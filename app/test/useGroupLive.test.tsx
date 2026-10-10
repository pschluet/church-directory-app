import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { GROUP_LIVE_INTERVAL_MS, typingLabel, useGroupLive } from "../src/components/useGroupLive";
import { testQueryClient } from "./utils";

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

describe("typingLabel", () => {
  it("names one or two people and summarises more", () => {
    expect(typingLabel([])).toBe("");
    expect(typingLabel(["Ann Lee"])).toBe("Ann Lee is typing…");
    expect(typingLabel(["Ann Lee", "Bo Park"])).toBe("Ann Lee and Bo Park are typing…");
    expect(typingLabel(["A", "B", "C"])).toBe("Several people are typing…");
  });
});

describe("useGroupLive", () => {
  let live: { activityAt: string; typing: string[] };

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
    live = { activityAt: "2026-10-10T10:00:00.000Z", typing: [] };
    apiMock.mockImplementation((path: string) =>
      path === "/groups/g1/live" ? Promise.resolve({ ...live }) : Promise.resolve({})
    );
  });
  afterEach(() => vi.useRealTimers());

  function setup(options: { enabled?: boolean; markRead?: () => void } = {}) {
    const queryClient = testQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => useGroupLive("g1", { enabled: options.enabled ?? true, markRead: options.markRead }),
      { wrapper }
    );
    return { ...hook, invalidate };
  }

  const tick = () => act(() => vi.advanceTimersByTimeAsync(GROUP_LIVE_INTERVAL_MS + 50));
  const invalidatedKeys = (invalidate: { mock: { calls: unknown[][] } }) =>
    invalidate.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown }).queryKey)
    );

  it("treats the first answer as a baseline and refreshes nothing", async () => {
    const { invalidate } = setup();
    await act(() => vi.advanceTimersByTimeAsync(10));
    await tick();
    await tick();
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/live", expect.anything());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refreshes the posts, files, events and bell when the stamp changes, and marks it read", async () => {
    const markRead = vi.fn();
    const { invalidate } = setup({ markRead });
    await act(() => vi.advanceTimersByTimeAsync(10));

    live.activityAt = "2026-10-10T10:00:05.000Z";
    await tick();

    const keys = invalidatedKeys(invalidate);
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(["org", "org-1", "groups", "g1", "posts"]),
        JSON.stringify(["org", "org-1", "groups", "g1", "files"]),
        JSON.stringify(["org", "org-1", "groups", "g1", "events"]),
        JSON.stringify(["notifications"]),
      ])
    );
    expect(markRead).toHaveBeenCalledTimes(1);

    // The same stamp again changes nothing.
    invalidate.mockClear();
    await tick();
    expect(invalidate).not.toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("reports who is typing", async () => {
    live.typing = ["Ann Lee"];
    const { result } = setup();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.typing).toEqual(["Ann Lee"]);
  });

  it("does not ask at all when the viewer cannot read the group's content", async () => {
    setup({ enabled: false });
    await tick();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("stops asking when the page goes away", async () => {
    const { unmount } = setup();
    await act(() => vi.advanceTimersByTimeAsync(10));
    unmount();
    apiMock.mockClear();
    await tick();
    await tick();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
