import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import {
  notificationMatchesTarget,
  type InboxDto,
  type NotificationDto,
  type SeenTarget,
} from "@shared";
import {
  DWELL_MS,
  FLUSH_MS,
  resetMarkReadWhenSeen,
  useMarkReadWhenSeen,
} from "../src/components/useMarkReadWhenSeen";
import { qk } from "../src/lib/queryKeys";
import { renderWithProviders, testQueryClient } from "./utils";

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

/* An IntersectionObserver the test drives by hand. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly elements = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  takeRecords() {
    return [];
  }
}

function isWatched(el: Element): boolean {
  return FakeObserver.instances.some((o) => o.elements.has(el));
}

/** Reports `el` as `ratio` visible, in an 800px viewport. */
function show(el: Element, ratio: number, height = 100) {
  const observer = FakeObserver.instances.find((o) => o.elements.has(el));
  if (!observer) throw new Error("not observed");
  const entry = {
    target: el,
    isIntersecting: ratio > 0,
    intersectionRatio: ratio,
    intersectionRect: { height: height * ratio },
    rootBounds: { height: 800 },
  } as unknown as IntersectionObserverEntry;
  act(() => observer.callback([entry], observer as unknown as IntersectionObserver));
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const row = (id: string, overrides: Partial<NotificationDto> = {}): NotificationDto => ({
  id,
  type: "GROUP_POST",
  prayerRequestId: null,
  groupId: "g1",
  groupPostId: null,
  groupPostParentId: null,
  groupPostParentKind: null,
  directoryRequestId: null,
  title: "Choir",
  createdAt: new Date().toISOString(),
  read: false,
  ...overrides,
});

function Item({ target, testId }: { target: SeenTarget; testId: string }) {
  const ref = useMarkReadWhenSeen(target);
  return <div ref={ref} data-testid={testId} />;
}

function setup(inbox: InboxDto, items: { target: SeenTarget; testId: string }[]) {
  const queryClient = testQueryClient();
  queryClient.setQueryData(qk.notifications(), inbox);
  const utils = renderWithProviders(
    <div>
      {items.map((item) => (
        <Item key={item.testId} {...item} />
      ))}
    </div>,
    { queryClient }
  );
  const inboxNow = () => queryClient.getQueryData<InboxDto>(qk.notifications());
  return { ...utils, queryClient, inboxNow };
}

let visibility: DocumentVisibilityState = "visible";

describe("useMarkReadWhenSeen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    apiMock.mockReset();
    // The settle refetch never answers, so the optimistic cache is what is asserted.
    apiMock.mockImplementation((path: string) =>
      path === "/notifications" ? new Promise(() => {}) : Promise.resolve({ cleared: 1 })
    );
  });

  afterEach(() => {
    resetMarkReadWhenSeen();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads a message once it has been half in view for a moment", async () => {
    const { getByTestId, inboxNow } = setup(
      {
        unreadCount: 2,
        notifications: [row("n1", { groupPostId: "p1" }), row("n2", { groupPostId: "p2" })],
      },
      [{ target: { groupPostId: "p1" }, testId: "p1" }]
    );

    show(getByTestId("p1"), 0.6);
    advance(DWELL_MS - 1);
    expect(inboxNow()?.unreadCount).toBe(2);

    advance(1);
    expect(inboxNow()?.unreadCount).toBe(1);
    expect(inboxNow()?.notifications.map((n) => n.read)).toEqual([true, false]);

    advance(FLUSH_MS);
    expect(apiMock).toHaveBeenCalledWith("/notifications/seen", {
      method: "POST",
      withOrg: false,
      body: {
        groupPostIds: ["p1"],
        prayerRequestIds: [],
        directoryRequestIds: [],
        joinRequestGroupIds: [],
      },
    });
  });

  it("reads nothing for a glimpse, under half in view, or scrolled past", () => {
    const { getByTestId, inboxNow } = setup(
      { unreadCount: 1, notifications: [row("n1", { groupPostId: "p1" })] },
      [{ target: { groupPostId: "p1" }, testId: "p1" }]
    );
    const el = getByTestId("p1");

    show(el, 0.4);
    advance(DWELL_MS * 2);
    show(el, 0.9);
    advance(DWELL_MS / 2);
    show(el, 0);
    advance(DWELL_MS * 2);

    expect(inboxNow()?.unreadCount).toBe(1);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("counts an item taller than the screen once it fills half of it", () => {
    const { getByTestId, inboxNow } = setup(
      { unreadCount: 1, notifications: [row("n1", { groupPostId: "p1" })] },
      [{ target: { groupPostId: "p1" }, testId: "p1" }]
    );
    // 2000px tall, a quarter visible: 500px of an 800px viewport.
    show(getByTestId("p1"), 0.25, 2000);
    advance(DWELL_MS);
    expect(inboxNow()?.unreadCount).toBe(0);
  });

  it("waits while the tab is in the background, then reads on return", () => {
    visibility = "hidden";
    const { getByTestId, inboxNow } = setup(
      { unreadCount: 1, notifications: [row("n1", { groupPostId: "p1" })] },
      [{ target: { groupPostId: "p1" }, testId: "p1" }]
    );
    show(getByTestId("p1"), 1);
    advance(DWELL_MS * 3);
    expect(inboxNow()?.unreadCount).toBe(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    advance(DWELL_MS);
    expect(inboxNow()?.unreadCount).toBe(0);
  });

  it("does not watch an item with nothing unread about it", () => {
    const { getByTestId } = setup(
      {
        unreadCount: 1,
        notifications: [
          row("n1", { groupPostId: "p1", read: true }),
          row("n2", { groupPostId: "p9" }),
        ],
      },
      [
        { target: { groupPostId: "p1" }, testId: "read" },
        { target: { groupPostId: "p2" }, testId: "none" },
      ]
    );
    expect(isWatched(getByTestId("read"))).toBe(false);
    expect(isWatched(getByTestId("none"))).toBe(false);
  });

  it("watches every item once when unread notifications run past the bell's page", () => {
    const { getByTestId } = setup({ unreadCount: 40, notifications: [] }, [
      { target: { prayerRequestId: "r1" }, testId: "r1" },
    ]);
    const el = getByTestId("r1");
    expect(isWatched(el)).toBe(true);
    show(el, 1);
    advance(DWELL_MS + FLUSH_MS);
    expect(apiMock).toHaveBeenCalledWith(
      "/notifications/seen",
      expect.objectContaining({ body: expect.objectContaining({ prayerRequestIds: ["r1"] }) })
    );
    // Reported once: it is not watched again while the overflow lasts.
    expect(isWatched(el)).toBe(false);
  });

  it("sends everything seen together as one request", () => {
    const { getByTestId } = setup(
      {
        unreadCount: 4,
        notifications: [
          row("n1", { groupPostId: "p1" }),
          row("n2", { type: "PRAYER_REQUEST", groupId: null, prayerRequestId: "r1" }),
          row("n3", { type: "DIRECTORY_REQUEST", groupId: null, directoryRequestId: "d1" }),
          row("n4", { type: "GROUP_JOIN_REQUEST", groupId: "g1" }),
        ],
      },
      [
        { target: { groupPostId: "p1" }, testId: "a" },
        { target: { prayerRequestId: "r1" }, testId: "b" },
        { target: { directoryRequestId: "d1" }, testId: "c" },
        { target: { joinRequestGroupId: "g1" }, testId: "d" },
      ]
    );
    for (const id of ["a", "b", "c", "d"]) show(getByTestId(id), 1);
    advance(DWELL_MS + FLUSH_MS);

    const seenCalls = apiMock.mock.calls.filter(([path]) => path === "/notifications/seen");
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]?.[1].body).toEqual({
      groupPostIds: ["p1"],
      prayerRequestIds: ["r1"],
      directoryRequestIds: ["d1"],
      joinRequestGroupIds: ["g1"],
    });
  });

  it("reads a notification that arrives for an item already on screen", () => {
    const { getByTestId, queryClient, inboxNow } = setup({ unreadCount: 0, notifications: [] }, [
      { target: { groupPostId: "p1" }, testId: "p1" },
    ]);
    const el = getByTestId("p1");
    expect(isWatched(el)).toBe(false);

    act(() => {
      queryClient.setQueryData<InboxDto>(qk.notifications(), {
        unreadCount: 1,
        notifications: [row("n1", { groupPostId: "p1" })],
      });
    });
    // React Query tells its observers on a zero-delay timer.
    advance(0);
    expect(isWatched(el)).toBe(true);
    show(el, 1);
    advance(DWELL_MS);
    expect(inboxNow()?.unreadCount).toBe(0);
  });

  it("does not report again once the refetch agrees", () => {
    const { getByTestId, queryClient } = setup(
      { unreadCount: 1, notifications: [row("n1", { groupPostId: "p1" })] },
      [{ target: { groupPostId: "p1" }, testId: "p1" }]
    );
    show(getByTestId("p1"), 1);
    advance(DWELL_MS + FLUSH_MS);
    act(() => {
      queryClient.setQueryData<InboxDto>(qk.notifications(), {
        unreadCount: 0,
        notifications: [row("n1", { groupPostId: "p1", read: true })],
      });
    });
    advance(0);
    expect(isWatched(getByTestId("p1"))).toBe(false);
    advance(DWELL_MS * 3);
    expect(apiMock.mock.calls.filter(([path]) => path === "/notifications/seen")).toHaveLength(1);
  });

  it("does nothing without an IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    setup({ unreadCount: 1, notifications: [row("n1", { groupPostId: "p1" })] }, [
      { target: { groupPostId: "p1" }, testId: "p1" },
    ]);
    advance(DWELL_MS * 3);
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("notificationMatchesTarget", () => {
  it("matches every post type by post, and nothing else", () => {
    for (const type of [
      "GROUP_POST",
      "GROUP_MENTION",
      "GROUP_EVENT",
      "GROUP_POST_REPORT",
    ] as const) {
      expect(
        notificationMatchesTarget(row("n", { type, groupPostId: "p1" }), { groupPostId: "p1" })
      ).toBe(true);
    }
    expect(notificationMatchesTarget(row("n", { groupPostId: "p2" }), { groupPostId: "p1" })).toBe(
      false
    );
    expect(
      notificationMatchesTarget(row("n", { type: "GROUP_JOIN_REQUEST" }), { groupPostId: "p1" })
    ).toBe(false);
  });

  it("matches a prayer request and its review notice", () => {
    for (const type of ["PRAYER_REQUEST", "PRAYER_REQUEST_REVIEW"] as const) {
      expect(
        notificationMatchesTarget(row("n", { type, groupId: null, prayerRequestId: "r1" }), {
          prayerRequestId: "r1",
        })
      ).toBe(true);
    }
  });

  it("matches a group's join requests by group, not its posts", () => {
    expect(
      notificationMatchesTarget(row("n", { type: "GROUP_JOIN_REQUEST" }), {
        joinRequestGroupId: "g1",
      })
    ).toBe(true);
    expect(
      notificationMatchesTarget(row("n", { groupPostId: "p1" }), { joinRequestGroupId: "g1" })
    ).toBe(false);
  });

  it("matches a directory request by id", () => {
    const n = row("n", { type: "DIRECTORY_REQUEST", groupId: null, directoryRequestId: "d1" });
    expect(notificationMatchesTarget(n, { directoryRequestId: "d1" })).toBe(true);
    expect(notificationMatchesTarget(n, { directoryRequestId: "d2" })).toBe(false);
  });
});
