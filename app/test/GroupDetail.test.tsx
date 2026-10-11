import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupDto, GroupMemberDto, GroupPostDto, MeDto } from "@shared";
import { ApiError } from "../src/lib/api";
import { NavStackProvider } from "../src/components/NavStack";
import { GroupDetail } from "../src/pages/GroupDetail";
import { renderWithProviders } from "./utils";
import { Route, Routes, useLocation, useNavigationType } from "react-router";

/*
 * The API and the contexts are stubbed: this file is about what the page shows
 * and what it sends. What the server is willing to do is api.groups.test.ts.
 */
const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const adminState = { isAdmin: false };

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { id: "user-me", personId: "person-me" } } as unknown as MeDto,
    isAdmin: adminState.isAdmin,
    organizationId: "org-1",
    maps: null,
  }),
}));

const MEMBERS: GroupMemberDto[] = [
  member("user-me", "person-me", "Me Myself"),
  member("user-ann", "person-ann", "Ann Lee"),
  member("user-bo", "person-bo", "Bo Park"),
];

function member(appUserId: string, personId: string, name: string): GroupMemberDto {
  return {
    appUserId,
    personId,
    name,
    thumbUrl: null,
    role: "MEMBER",
    joinedAt: "2026-01-01T00:00:00Z",
  };
}

function group(overrides: Partial<GroupDto> = {}): GroupDto {
  return {
    id: "g1",
    title: "Youth Group",
    description: null,
    thumbUrl: "/photo-thumb.webp",
    fullUrl: "/photo-full.webp",
    cardUrl: null,
    visibility: "PUBLIC",
    memberCount: 3,
    archivedAt: null,
    myRole: "MEMBER",
    unreadCount: 0,
    pendingJoinRequestId: null,
    pinned: false,
    organizationId: "org-1",
    photoWidth: 400,
    photoHeight: 300,
    postingRestricted: false,
    invitesRestricted: false,
    repliesRestricted: false,
    createdByPersonId: null,
    createdByName: null,
    createdAt: "2026-01-01T00:00:00Z",
    members: MEMBERS,
    pendingJoinRequests: [],
    notificationPref: null,
    notificationPrefDefault: "ALL",
    canPost: true,
    canInvite: true,
    canReply: true,
    canModerate: false,
    canConvertVisibility: [],
    canArchive: false,
    canRequestToJoin: false,
    viewingAsAdmin: false,
    ...overrides,
  };
}

let seq = 0;
function post(overrides: Partial<GroupPostDto> = {}): GroupPostDto {
  seq += 1;
  return {
    id: `p${seq}`,
    groupId: "g1",
    authorPersonId: "person-ann",
    authorName: "Ann Lee",
    authorThumbUrl: null,
    parentPostId: null,
    kind: "MESSAGE",
    body: `Message ${seq}`,
    editedAt: null,
    deletedAt: null,
    deletedBySelf: null,
    createdAt: "2026-10-09T10:00:00.000Z",
    attachments: [],
    mentions: [],
    event: null,
    replyCount: 0,
    lastReplyAt: null,
    canEdit: false,
    canDelete: false,
    canReport: false,
    ...overrides,
  };
}

interface Stub {
  group?: GroupDto;
  /** A thread's root and its replies (oldest first), for the thread page. */
  thread?: { root: GroupPostDto; replies: GroupPostDto[] };
  typing?: string[];
  /** Newest-first pages, as the API returns them. */
  pages?: { posts: GroupPostDto[]; nextCursor: { createdAt: string; id: string } | null }[];
}

function stub({
  group: g = group(),
  pages = [{ posts: [], nextCursor: null }],
  typing = [],
  thread,
}: Stub = {}) {
  apiMock.mockImplementation((path: string, options?: { query?: Record<string, string> }) => {
    if (path === "/groups/g1") return Promise.resolve(g);
    if (path === "/groups/g1/live")
      return Promise.resolve({ activityAt: "2026-10-10T10:00:00.000Z", typing });
    if (thread) {
      if (path === `/groups/g1/posts/${thread.root.id}`) return Promise.resolve(thread.root);
      if (path === `/groups/g1/posts/${thread.root.id}/replies`)
        return Promise.resolve({ replies: thread.replies });
      const reply = thread.replies.find((r) => path === `/groups/g1/posts/${r.id}`);
      if (reply) return Promise.resolve(reply);
    }
    if (path === "/groups/g1/posts") {
      const cursor = options?.query?.cursorId;
      const index = cursor ? pages.findIndex((_, i) => pages[i - 1]?.nextCursor?.id === cursor) : 0;
      return Promise.resolve(pages[Math.max(index, 0)]);
    }
    return Promise.resolve({});
  });
}

function Where() {
  const type = useNavigationType();
  return (
    <p data-testid="where" data-nav-type={type}>
      {useLocation().pathname}
    </p>
  );
}

function renderPage(path = "/groups/g1") {
  return renderWithProviders(
    <NavStackProvider>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/groups/:id/threads/:postId" element={<GroupDetail />} />
      </Routes>
      <Where />
    </NavStackProvider>,
    { initialEntries: [path] }
  );
}

const where = () => screen.getByTestId("where").textContent;
const navType = () => screen.getByTestId("where").getAttribute("data-nav-type");

describe("GroupDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
    adminState.isAdmin = false;
    seq = 0;
  });

  it("does not show the group photo on the group's own page", async () => {
    stub();
    renderPage();
    await screen.findByRole("heading", { name: "Youth Group" });
    expect(document.querySelector('img[src="/photo-thumb.webp"]')).toBeNull();
  });

  it("links the author's name to their page", async () => {
    stub({ pages: [{ posts: [post()], nextCursor: null }] });
    renderPage();
    const links = await screen.findAllByRole("link", { name: "Ann Lee" });
    expect(links[0]).toHaveAttribute("href", "/people/person-ann");
  });

  it("links an @ mention to the mentioned person's page", async () => {
    stub({
      pages: [
        {
          posts: [
            post({
              body: "Thanks @Bo Park for helping",
              mentions: [{ appUserId: "user-bo", personId: "person-bo", name: "Bo Park" }],
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderPage();
    expect(await screen.findByRole("link", { name: "@Bo Park" })).toHaveAttribute(
      "href",
      "/people/person-bo"
    );
  });

  describe("reading the conversation", () => {
    it("shows the oldest first and the newest last", async () => {
      stub({
        pages: [
          {
            posts: [
              post({ body: "newest", createdAt: "2026-10-09T10:05:00.000Z" }),
              post({ body: "oldest", createdAt: "2026-10-09T10:00:00.000Z" }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByText("newest");
      const text = screen.getByRole("log").textContent ?? "";
      expect(text.indexOf("oldest")).toBeLessThan(text.indexOf("newest"));
    });

    it("gives a run of messages from one person a single byline", async () => {
      stub({
        pages: [
          {
            posts: [
              post({ body: "two", createdAt: "2026-10-09T10:01:00.000Z" }),
              post({ body: "one", createdAt: "2026-10-09T10:00:00.000Z" }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByText("two");
      expect(
        within(screen.getByRole("log")).getAllByRole("link", { name: "Ann Lee" })
      ).toHaveLength(1);
    });

    it("repeats the byline after a long gap, and for a different author", async () => {
      stub({
        pages: [
          {
            posts: [
              post({
                body: "later",
                authorPersonId: "person-bo",
                authorName: "Bo Park",
                createdAt: "2026-10-09T10:30:00.000Z",
              }),
              post({ body: "mid", createdAt: "2026-10-09T10:20:00.000Z" }),
              post({ body: "first", createdAt: "2026-10-09T10:00:00.000Z" }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByText("later");
      const log = within(screen.getByRole("log"));
      // first, then mid ten+ minutes on from it, then Bo.
      expect(log.getAllByRole("link", { name: "Ann Lee" })).toHaveLength(2);
      expect(log.getAllByRole("link", { name: "Bo Park" })).toHaveLength(1);
    });

    it("puts a divider where the day changes", async () => {
      stub({
        pages: [
          {
            posts: [
              post({ body: "today", createdAt: "2026-10-09T12:00:00.000Z" }),
              post({ body: "before", createdAt: "2026-10-01T12:00:00.000Z" }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByText("today");
      expect(document.querySelectorAll("[data-day-divider]")).toHaveLength(2);
    });

    it("loads older messages from the cursor and keeps them above the rest", async () => {
      const cursor = { createdAt: "2026-10-09T09:00:00.000Z", id: "cursor-1" };
      stub({
        pages: [
          { posts: [post({ body: "recent" })], nextCursor: cursor },
          {
            posts: [post({ body: "older", createdAt: "2026-10-09T08:00:00.000Z" })],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
      await screen.findByText("older");

      expect(apiMock).toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({
          query: { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
        })
      );
      const text = screen.getByRole("log").textContent ?? "";
      expect(text.indexOf("older")).toBeLessThan(text.indexOf("recent"));
      expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
    });
  });

  describe("the message bar", () => {
    it("sends on Enter, and keeps Shift+Enter for a new line", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await userEvent.type(bar, "Hello{Shift>}{Enter}{/Shift}there");
      expect(apiMock).not.toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({ method: "POST" })
      );

      await userEvent.type(bar, "{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ kind: "MESSAGE", body: "Hello\nthere" }),
          })
        )
      );
    });

    it("lets Enter choose a mentioned name instead of sending", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await userEvent.type(bar, "hi @An");
      await userEvent.keyboard("{Enter}");

      expect(apiMock).not.toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({ method: "POST" })
      );
      expect(bar).toHaveValue("hi @Ann Lee ");

      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ mentionedAppUserIds: ["user-ann"] }),
          })
        )
      );
    });

    it("offers a photo or file and an event from the + menu", async () => {
      stub();
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Add to this message" }));
      expect(screen.getByRole("menuitem", { name: "Photo or file" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("menuitem", { name: "Event…" }));
      expect(await screen.findByRole("dialog", { name: "New event" })).toBeInTheDocument();
    });

    it("posts an event with no message body", async () => {
      stub();
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Add to this message" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Event…" }));

      await userEvent.type(await screen.findByLabelText("Event title"), "Potluck");
      await userEvent.type(screen.getByLabelText("Date"), "2030-01-01");
      await userEvent.click(screen.getByRole("button", { name: "Post event" }));

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              kind: "EVENT",
              event: expect.objectContaining({ eventTitle: "Potluck", eventDate: "2030-01-01" }),
            }),
          })
        )
      );
      const sent = apiMock.mock.calls.find((c) => c[1]?.method === "POST")![1].body;
      expect(sent.body).toBeUndefined();
    });

    it("does not offer to start a conversation to a member who may only reply", async () => {
      stub({ group: group({ canPost: false, canReply: true }) });
      renderPage();
      await screen.findByRole("log", { name: "Messages" });
      expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
      expect(screen.getByText(/Only admins can start a conversation/)).toBeInTheDocument();
    });
  });

  describe("live updates", () => {
    it("has no manual refresh button or 'Updated' text any more", async () => {
      stub();
      renderPage();
      await screen.findByRole("heading", { name: "Youth Group" });
      expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
    });

    it("says who is typing", async () => {
      stub({ typing: ["Ann Lee"] });
      renderPage();
      expect(await screen.findByText("Ann Lee is typing…")).toBeInTheDocument();
    });

    it("tells the server I am typing, at most once per interval, and not for a blank bar", async () => {
      let nowMs = 1_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      const typingCalls = () =>
        apiMock.mock.calls.filter((call) => call[0] === "/groups/g1/typing");

      await userEvent.type(bar, "   ");
      expect(typingCalls()).toHaveLength(0);

      await userEvent.type(bar, "abc");
      expect(typingCalls()).toHaveLength(1);
      expect(typingCalls()[0]![1]).toEqual({ method: "POST" });

      nowMs += 3500;
      await userEvent.type(bar, "d");
      expect(typingCalls()).toHaveLength(2);
      clock.mockRestore();
    });

    it("does not signal typing from the thread's reply bar", async () => {
      const root = post({ id: "root-1", body: "Hello", replyCount: 0 });
      stub({ thread: { root, replies: [] } });
      renderPage("/groups/g1/threads/root-1");
      await userEvent.type(await screen.findByRole("textbox", { name: "Reply" }), "thinking");
      expect(apiMock.mock.calls.some((call) => call[0] === "/groups/g1/typing")).toBe(false);
    });
  });

  describe("deleting the group", () => {
    it("drops it from the cached groups list so the groups page does not show it", async () => {
      adminState.isAdmin = true;
      stub({ group: group({ canModerate: true, myRole: "ADMIN" }) });
      const { queryClient } = renderWithProviders(
        <NavStackProvider>
          <Routes>
            <Route path="/groups/:id" element={<GroupDetail />} />
            <Route path="/groups" element={<p>The groups page</p>} />
          </Routes>
        </NavStackProvider>,
        { initialEntries: ["/groups/g1"] }
      );
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const remove = vi.spyOn(queryClient, "removeQueries");

      await userEvent.click(await screen.findByRole("button", { name: /3 members/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete group" }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete it" }));

      expect(await screen.findByText("The groups page")).toBeInTheDocument();
      expect(apiMock).toHaveBeenCalledWith("/groups/g1", { method: "DELETE" });
      expect(remove).toHaveBeenCalledWith({ queryKey: ["org", "org-1", "groups", "g1"] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["org", "org-1", "groups"],
        exact: true,
      });
    });
  });

  describe("long press on a touch screen", () => {
    const messages = () => ({
      pages: [
        {
          posts: [
            post({
              body: "Hello there",
              authorPersonId: "person-me",
              canEdit: true,
              canDelete: true,
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    const press = (el: Element, init: PointerEventInit = {}) =>
      fireEvent.pointerDown(el, { pointerType: "touch", clientX: 5, clientY: 5, ...init });

    it("opens a drawer with the message's actions after a held touch", async () => {
      stub(messages());
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;

      press(row);
      expect(await screen.findByRole("dialog", { name: "Message" })).toBeInTheDocument();
      const drawer = within(screen.getByRole("dialog", { name: "Message" }));
      for (const name of ["Copy text", "Reply", "Edit", "Delete"]) {
        expect(drawer.getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("marks the pressed message while the finger is down, and while its drawer is open", async () => {
      stub(messages());
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;
      expect(row.className).not.toContain("ring-accent");

      press(row);
      expect(row.className).toContain("ring-accent");
      fireEvent.pointerUp(row, { pointerType: "touch" });
      expect(row.className).not.toContain("ring-accent");

      press(row);
      const drawer = await screen.findByRole("dialog", { name: "Message" });
      expect(row.className).toContain("ring-accent");
      // The drawer says which message it is about.
      expect(within(drawer).getByText(/Hello there/)).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(row.className).not.toContain("ring-accent"));
    });

    it("switches selection off in the drawer itself, so nothing in it highlights", async () => {
      stub(messages());
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;
      press(row);
      const drawer = await screen.findByRole("dialog", { name: "Message" });
      expect(drawer.className).toContain("select-none");
    });

    it("does nothing for a quick tap, a drag, or a mouse", async () => {
      stub(messages());
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;

      press(row);
      fireEvent.pointerUp(row, { pointerType: "touch" });
      press(row);
      fireEvent.pointerMove(row, { pointerType: "touch", clientX: 5, clientY: 60 });
      press(row, { pointerType: "mouse" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(screen.queryByRole("dialog", { name: "Message" })).not.toBeInTheDocument();
    });

    it("runs the chosen action and closes", async () => {
      stub(messages());
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;
      press(row);
      await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
      expect(screen.queryByRole("dialog", { name: "Message" })).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Hello there")).toBeInTheDocument();
    });

    it("hides the always-on three-dot button on a touch screen", async () => {
      stub(messages());
      renderPage();
      await screen.findByText("Hello there");
      const wrapper = screen
        .getByRole("button", { name: "Actions for this post" })
        .closest(".absolute");
      expect(wrapper?.className).toContain("[@media(hover:none)]:hidden");
    });
  });

  describe("page scrolling", () => {
    beforeEach(() => {
      window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    });

    it("does not scroll the page on the Messages tab, so the message bar stays put", async () => {
      stub();
      renderPage();
      await screen.findByRole("textbox", { name: "Message" });
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("lets the page scroll on Files and Events as before", async () => {
      stub();
      renderPage();
      await screen.findByRole("textbox", { name: "Message" });

      await userEvent.click(screen.getByRole("button", { name: "Files" }));
      await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
      await userEvent.click(screen.getByRole("button", { name: "Events" }));
      expect(document.body.style.overflow).not.toBe("hidden");

      await userEvent.click(screen.getByRole("button", { name: "Messages" }));
      await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    });

    it("does not scroll the page on a thread either, and releases it on leaving", async () => {
      const rootPost = post({ id: "root-1", body: "Hello", replyCount: 0 });
      stub({ thread: { root: rootPost, replies: [] } });
      const { unmount } = renderPage("/groups/g1/threads/root-1");
      await screen.findByRole("textbox", { name: "Reply" });
      expect(document.body.style.overflow).toBe("hidden");
      unmount();
      expect(document.body.style.overflow).not.toBe("hidden");
    });

    it("starts from the top, so locking cannot freeze the header off screen", async () => {
      stub();
      renderPage();
      await screen.findByRole("textbox", { name: "Message" });
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    });
  });

  describe("threads", () => {
    const root = (overrides: Partial<GroupPostDto> = {}) =>
      post({
        id: "root-1",
        body: "Hello",
        replyCount: 2,
        lastReplyAt: "2026-10-09T11:00:00.000Z",
        ...overrides,
      });

    it("shows a reply summary that opens the thread, and no inline replies", async () => {
      stub({ pages: [{ posts: [root()], nextCursor: null }] });
      renderPage();
      await screen.findByText("Hello");
      const link = screen.getByRole("link", { name: /2 replies/ });
      expect(link).toHaveAttribute("href", "/groups/g1/threads/root-1");
      expect(link).toHaveTextContent(/last reply/);
      expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    });

    it("says nothing for a message without replies", async () => {
      stub({ pages: [{ posts: [root({ replyCount: 0, lastReplyAt: null })], nextCursor: null }] });
      renderPage();
      await screen.findByText("Hello");
      expect(screen.queryByRole("link", { name: /repl/ })).not.toBeInTheDocument();
    });

    it("opens the thread from the Reply item in a message's menu", async () => {
      stub({ pages: [{ posts: [root()], nextCursor: null }] });
      renderPage();
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
      expect(where()).toBe("/groups/g1/threads/root-1");
    });

    it("shows the message on top, the count, the replies in order, and the same bar below", async () => {
      const reply1 = post({ id: "r1", body: "first reply", parentPostId: "root-1" });
      const reply2 = post({
        id: "r2",
        body: "second reply",
        parentPostId: "root-1",
        authorPersonId: "person-bo",
        authorName: "Bo Park",
      });
      stub({ thread: { root: root(), replies: [reply1, reply2] } });
      renderPage("/groups/g1/threads/root-1");

      expect(await screen.findByRole("heading", { name: "Thread" })).toBeInTheDocument();
      await screen.findByText("second reply");
      const log = screen.getByRole("log", { name: "Thread" });
      const text = log.textContent ?? "";
      expect(text.indexOf("Hello")).toBeLessThan(text.indexOf("2 replies"));
      expect(text.indexOf("2 replies")).toBeLessThan(text.indexOf("first reply"));
      expect(text.indexOf("first reply")).toBeLessThan(text.indexOf("second reply"));
      expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
      // No tab icons on a thread; the group links back to the feed.
      expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Youth Group" })).toHaveAttribute(
        "href",
        "/groups/g1"
      );
    });

    it("sends a reply to the thread's message", async () => {
      stub({ thread: { root: root({ replyCount: 0 }), replies: [] } });
      renderPage("/groups/g1/threads/root-1");
      expect(await screen.findByText("No replies yet")).toBeInTheDocument();
      await userEvent.type(await screen.findByRole("textbox", { name: "Reply" }), "Thanks{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              kind: "MESSAGE",
              body: "Thanks",
              parentPostId: "root-1",
            }),
          })
        )
      );
    });

    it("leaves by popping history when reached from the feed, not by pushing another entry", async () => {
      stub({
        pages: [{ posts: [root()], nextCursor: null }],
        thread: { root: root(), replies: [] },
      });
      renderPage();
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("link", { name: /2 replies/ }));
      await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
      await waitFor(() => expect(where()).toBe("/groups/g1"));
      // A pop, not a push: the thread's entry is gone from history.
      expect(navType()).toBe("POP");
    });

    it("leaves by replacing when the thread was opened directly", async () => {
      stub({ thread: { root: root(), replies: [] } });
      renderPage("/groups/g1/threads/root-1");
      await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
      await waitFor(() => expect(where()).toBe("/groups/g1"));
      expect(navType()).toBe("REPLACE");
    });

    it("focuses the bar when arriving from Reply, but not from the count", async () => {
      stub({
        pages: [{ posts: [root()], nextCursor: null }],
        thread: { root: root(), replies: [] },
      });
      renderPage();
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("link", { name: /2 replies/ }));
      const bar = await screen.findByRole("textbox", { name: "Reply" });
      expect(bar).not.toHaveFocus();
    });

    it("focuses the bar when arriving from the menu's Reply", async () => {
      stub({
        pages: [{ posts: [root()], nextCursor: null }],
        thread: { root: root(), replies: [] },
      });
      renderPage();
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
      expect(await screen.findByRole("textbox", { name: "Reply" })).toHaveFocus();
    });

    it("keeps a deleted message's replies", async () => {
      const reply = post({ id: "r1", body: "still here", parentPostId: "root-1" });
      stub({
        thread: {
          root: root({ body: null, deletedAt: "2026-10-09T12:00:00.000Z", deletedBySelf: true }),
          replies: [reply],
        },
      });
      renderPage("/groups/g1/threads/root-1");
      expect(await screen.findByText("Message deleted")).toBeInTheDocument();
      expect(await screen.findByText("still here")).toBeInTheDocument();
    });

    it("sends a link to a reply on to the thread it belongs to", async () => {
      const reply = post({ id: "r1", body: "a reply", parentPostId: "root-1" });
      stub({ thread: { root: root(), replies: [reply] } });
      renderPage("/groups/g1/threads/r1");
      await waitFor(() => expect(where()).toBe("/groups/g1/threads/root-1"));
    });

    it("says so when the message is not there", async () => {
      apiMock.mockImplementation((path: string) => {
        if (path === "/groups/g1") return Promise.resolve(group());
        if (path === "/groups/g1/live") return Promise.resolve({ activityAt: "x", typing: [] });
        return Promise.reject(new ApiError(404, "Post not found"));
      });
      renderPage("/groups/g1/threads/nope");
      expect(await screen.findByText("That message was not found.")).toBeInTheDocument();
    });

    it("offers no reply bar to someone who cannot reply", async () => {
      stub({
        group: group({ canReply: false }),
        thread: { root: root(), replies: [] },
      });
      renderPage("/groups/g1/threads/root-1");
      expect(await screen.findByText("You cannot reply in this group.")).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    });

    it("does not offer Reply in the menu to someone who cannot reply", async () => {
      stub({
        group: group({ canReply: false }),
        pages: [{ posts: [post({ body: "Hello" })], nextCursor: null }],
      });
      renderPage();
      await screen.findByText("Hello");
      expect(
        screen.queryByRole("button", { name: "Actions for this post" })
      ).not.toBeInTheDocument();
    });
  });

  describe("the header", () => {
    it("has three icon buttons beside the title and no text tab row", async () => {
      stub();
      renderPage();
      await screen.findByRole("heading", { name: "Youth Group" });
      const nav = screen.getByRole("navigation", { name: "Group sections" });
      for (const name of ["Messages", "Files", "Events"]) {
        expect(within(nav).getByRole("button", { name })).toBeInTheDocument();
        expect(within(nav).getByRole("button", { name })).not.toHaveTextContent(name);
      }
      expect(within(nav).getByRole("button", { name: "Messages" })).toHaveAttribute(
        "aria-current",
        "page"
      );
    });

    it("switches section from the icons", async () => {
      stub();
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Files" }));
      expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Messages" })).not.toHaveAttribute("aria-current");
      expect(await screen.findByText("Nothing shared yet")).toBeInTheDocument();
    });

    it("has no Leave button in the header; Leave is in group settings and asks first", async () => {
      stub();
      renderPage();
      await screen.findByRole("heading", { name: "Youth Group" });
      expect(screen.queryByRole("button", { name: "Leave" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /3 members/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Leave group" }));
      expect(await screen.findByRole("dialog", { name: "Leave this group?" })).toBeInTheDocument();
    });

    it("keeps Join in the header for someone who is not a member", async () => {
      stub({ group: group({ myRole: null }) });
      renderPage();
      expect(await screen.findByRole("button", { name: "Join" })).toBeInTheDocument();
    });
  });

  describe("editing a message", () => {
    const mine = () => ({
      pages: [
        {
          posts: [post({ body: "Hello", authorPersonId: "person-me", canEdit: true })],
          nextCursor: null,
        },
      ],
    });

    async function startEdit() {
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      return screen.findByRole("textbox", { name: "Edit message" });
    }

    it("uses the message bar at the bottom, not a new input inside the conversation", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();

      expect(bar).toHaveValue("Hello");
      expect(bar).toHaveFocus();
      expect(screen.getByText("Editing message")).toBeInTheDocument();
      // The only text box is the bar itself, and it is not inside the message log.
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(within(screen.getByRole("log")).queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("swaps send for accept and cancel, and drops the + menu", async () => {
      stub(mine());
      renderPage();
      await startEdit();
      expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add to this message" })).not.toBeInTheDocument();
      const accept = screen.getByRole("button", { name: "Save changes" });
      const cancel = screen.getByRole("button", { name: "Cancel editing" });
      expect(accept.className).toContain("green");
      expect(cancel.className).toContain("red");
      // Nothing has changed yet, so there is nothing to accept.
      expect(accept).toBeDisabled();
    });

    it("marks the message being edited", async () => {
      stub(mine());
      renderPage();
      await startEdit();
      expect(within(screen.getByRole("log")).getByText("Hello").closest("li")!.className).toContain(
        "ring-accent"
      );
    });

    it("saves with the mentions re-read from the edited text", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await userEvent.type(bar, " @Bo");
      await userEvent.keyboard("{Enter}");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts/p1",
          expect.objectContaining({
            method: "PATCH",
            body: { body: "Hello @Bo Park ", mentionedAppUserIds: ["user-bo"] },
          })
        )
      );
      // Back to the ordinary bar.
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    });

    it("saves with Enter too", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await userEvent.type(bar, "!{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts/p1",
          expect.objectContaining({ method: "PATCH" })
        )
      );
    });

    it("cancels with the red button or Escape, sending nothing, and gives back the draft", async () => {
      stub(mine());
      renderPage();
      const draftBar = await screen.findByRole("textbox", { name: "Message" });
      await userEvent.type(draftBar, "half a thought");

      let bar = await startEdit();
      expect(bar).toHaveValue("Hello");
      await userEvent.type(bar, " changed");
      await userEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("half a thought");

      bar = await startEdit();
      await userEvent.type(bar, "{Escape}");
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("half a thought");

      expect(apiMock.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
    });

    it("keeps editing open when Escape only closes the mention list", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await userEvent.type(bar, " @An");
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("textbox", { name: "Edit message" })).toBeInTheDocument();
    });

    it("does not signal typing while editing", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await userEvent.type(bar, " more");
      expect(apiMock.mock.calls.some((call) => call[0] === "/groups/g1/typing")).toBe(false);
    });

    it("edits a reply in the thread's bar too", async () => {
      const rootPost = post({ id: "root-1", body: "Root", replyCount: 1 });
      const reply = post({
        id: "r1",
        body: "my reply",
        parentPostId: "root-1",
        authorPersonId: "person-me",
        canEdit: true,
      });
      stub({ thread: { root: rootPost, replies: [reply] } });
      renderPage("/groups/g1/threads/root-1");
      await screen.findByText("my reply");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      const bar = await screen.findByRole("textbox", { name: "Edit message" });
      expect(bar).toHaveValue("my reply");
      await userEvent.type(bar, "!");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts/r1",
          expect.objectContaining({ method: "PATCH" })
        )
      );
    });

    it("lets someone edit their own message even when posting is restricted to admins", async () => {
      stub({ ...mine(), group: group({ canPost: false, canReply: true }) });
      renderPage();
      const bar = await startEdit();
      expect(bar).toBeInTheDocument();
    });
  });

  describe("notification setting", () => {
    it("offers to follow the default, and sends null for it", async () => {
      stub({ group: group({ notificationPref: "NONE", notificationPrefDefault: "MENTIONS" }) });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: /3 members/ }));
      const select = await screen.findByRole("combobox", {
        name: "Your notifications for this group",
      });
      expect(select).toHaveValue("NONE");
      expect(
        screen.getByRole("option", { name: "Use my default (Only when I'm mentioned)" })
      ).toBeInTheDocument();

      await userEvent.selectOptions(select, "");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/notification-preference", {
          method: "PUT",
          body: { notificationPref: null },
        })
      );
    });
  });
});
