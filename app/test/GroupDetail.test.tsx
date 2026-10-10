import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupDto, GroupMemberDto, GroupPostDto, MeDto } from "@shared";
import { GroupDetail } from "../src/pages/GroupDetail";
import { renderWithProviders } from "./utils";
import { Route, Routes } from "react-router";

/*
 * The API and the contexts are stubbed: this file is about what the page shows
 * and what it sends. What the server is willing to do is api.groups.test.ts.
 */
const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { appUser: { id: "user-me", personId: "person-me" } } as unknown as MeDto,
    isAdmin: false,
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
    canEdit: false,
    canDelete: false,
    canReport: false,
    ...overrides,
  };
}

interface Stub {
  group?: GroupDto;
  /** Newest-first pages, as the API returns them. */
  pages?: { posts: GroupPostDto[]; nextCursor: { createdAt: string; id: string } | null }[];
}

function stub({ group: g = group(), pages = [{ posts: [], nextCursor: null }] }: Stub = {}) {
  apiMock.mockImplementation((path: string, options?: { query?: Record<string, string> }) => {
    if (path === "/groups/g1") return Promise.resolve(g);
    if (path === "/groups/g1/posts") {
      const cursor = options?.query?.cursorId;
      const index = cursor ? pages.findIndex((_, i) => pages[i - 1]?.nextCursor?.id === cursor) : 0;
      return Promise.resolve(pages[Math.max(index, 0)]);
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/groups/:id" element={<GroupDetail />} />
    </Routes>,
    { initialEntries: ["/groups/g1"] }
  );
}

describe("GroupDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
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

  describe("replying", () => {
    it("is in the actions menu, not inline on the message", async () => {
      stub({ pages: [{ posts: [post({ body: "Hello" })], nextCursor: null }] });
      renderPage();
      await screen.findByText("Hello");
      expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Reply" }));

      const bar = await screen.findByRole("textbox", { name: "Reply" });
      await userEvent.type(bar, "Thanks{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ body: "Thanks", parentPostId: "p1" }),
          })
        )
      );
    });

    it("is not offered to someone who cannot reply", async () => {
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

  describe("editing", () => {
    it("re-reads the mentions from the edited text", async () => {
      stub({
        pages: [
          {
            posts: [post({ body: "Hello", authorPersonId: "person-me", canEdit: true })],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByText("Hello");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

      const box = screen.getByDisplayValue("Hello");
      await userEvent.clear(box);
      await userEvent.type(box, "Hello @Bo");
      await userEvent.keyboard("{Enter}");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts/p1",
          expect.objectContaining({
            method: "PATCH",
            body: { body: "Hello @Bo Park ", mentionedAppUserIds: ["user-bo"] },
          })
        )
      );
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
