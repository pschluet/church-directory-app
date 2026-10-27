import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import userEvent from "@testing-library/user-event";
import type {
  GroupDto,
  GroupEventRsvpDto,
  GroupFileDto,
  GroupMemberDto,
  GroupPostAttachmentDto,
  GroupPostDto,
  MeDto,
  PublicEventRsvpDto,
} from "@shared";
import { GROUP_POST_MAX_ATTACHMENTS } from "@shared";
import { ApiError } from "../src/lib/api";
import { NavStackProvider } from "../src/components/NavStack";
import { localDayIso } from "../src/lib/format";
import { resetRecentReactions } from "../src/lib/emoji";
import { GroupDetail, groupTabPath, tabFromPathname } from "../src/pages/GroupDetail";
import { EventDetail } from "../src/pages/EventDetail";
import type { GroupAttachmentPicker } from "../src/components/useGroupAttachmentPicker";
import { renderWithProviders, chooseOption } from "./utils";
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

/*
 * The real picker reads files through canvas, which jsdom does not have, so a
 * test that wants to say "a picture has been added" swaps in a fixed state.
 */
const pickerOverride: { value: Partial<GroupAttachmentPicker> | null } = { value: null };

vi.mock("../src/components/useGroupAttachmentPicker", async () => {
  const actual = await vi.importActual<typeof import("../src/components/useGroupAttachmentPicker")>(
    "../src/components/useGroupAttachmentPicker"
  );
  return {
    ...actual,
    useGroupAttachmentPicker: () => {
      const real = actual.useGroupAttachmentPicker();
      return pickerOverride.value ? { ...real, ...pickerOverride.value } : real;
    },
  };
});

/*
 * The real picker loads emoji data over the network and virtualises its list,
 * neither of which jsdom can do. This one offers a single emoji, which is all
 * these cases need to say "somebody picked one".
 */
vi.mock("../src/components/EmojiPickerPanel", () => ({
  default: ({ onPick }: { onPick: (emoji: string) => void }) => (
    <div data-testid="emoji-picker">
      <button type="button" onClick={() => onPick("🎉")}>
        pick party
      </button>
    </div>
  ),
}));

const adminState = { isAdmin: false };

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: {
      appUser: { id: "user-me", personId: "person-me" },
      person: { id: "person-me", firstName: "Me", lastName: "Myself" },
    } as unknown as MeDto,
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
    canReact: true,
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
    reactions: [],
    mentions: [],
    mentionsEveryone: false,
    event: null,
    poll: null,
    replyCount: 0,
    lastReplyAt: null,
    canEdit: false,
    canDelete: false,
    canReport: false,
    canRestore: false,
    ...overrides,
  };
}

function attachment(overrides: Partial<GroupPostAttachmentDto> = {}): GroupPostAttachmentDto {
  return {
    id: "a1",
    kind: "IMAGE",
    filename: "picnic.jpg",
    contentType: "image/jpeg",
    byteSize: 1000,
    thumbUrl: "/picnic-thumb.webp",
    fullUrl: "/picnic-full.webp",
    width: 400,
    height: 300,
    downloadUrl: null,
    ...overrides,
  };
}

interface Stub {
  group?: GroupDto;
  /** What the Files tab lists. */
  files?: GroupFileDto[];
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
  files = [],
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
    if (path === "/groups/g1/files") return Promise.resolve({ files });
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
        <Route path="/groups/:id/messages" element={<GroupDetail />} />
        <Route path="/groups/:id/files" element={<GroupDetail />} />
        <Route path="/groups/:id/events" element={<GroupDetail />} />
        <Route path="/groups/:id/threads/:postId" element={<GroupDetail />} />
        <Route path="/groups/:id/events/:postId" element={<EventDetail />} />
      </Routes>
      <Where />
    </NavStackProvider>,
    { initialEntries: [path] }
  );
}

/**
 * Types into the message bar. Its editor (ProseMirror) reads typing back out of
 * the DOM, which jsdom does not keep in step a letter at a time, so each run of
 * text goes in as the editor's own text insertion -- what a keystroke becomes --
 * and only the {Key} presses are really pressed.
 */
async function typeInBar(bar: HTMLElement, text: string): Promise<void> {
  const editor = (bar as HTMLElement & { editor: Editor }).editor;
  if (!bar.contains(document.activeElement)) await userEvent.click(bar);
  for (const part of text.split(/((?:\{[^}]*\})+)/)) {
    if (!part) continue;
    if (part.startsWith("{")) await userEvent.keyboard(part);
    else act(() => void editor.view.dispatch(editor.view.state.tr.insertText(part)));
  }
}

/** What is in the message bar, as text. */
const barText = (bar: HTMLElement) => bar.textContent;

const where = () => screen.getByTestId("where").textContent;
const navType = () => screen.getByTestId("where").getAttribute("data-nav-type");

describe("GroupDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
    adminState.isAdmin = false;
    pickerOverride.value = null;
    seq = 0;
    resetRecentReactions();
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

  it("picks out @everyone in a post that mentions the whole group", async () => {
    stub({
      pages: [
        {
          posts: [post({ body: "Reminder @everyone: bring snacks", mentionsEveryone: true })],
          nextCursor: null,
        },
      ],
    });
    renderPage();
    const everyone = await screen.findByText("@everyone");
    expect(everyone).toHaveClass("text-accent");
    expect(everyone.closest("a")).toBeNull();
  });

  describe("the message bar", () => {
    it("sends on Enter, and keeps Shift+Enter for a new line", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await typeInBar(bar, "Hello{Shift>}{Enter}{/Shift}there");
      expect(apiMock).not.toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({ method: "POST" })
      );

      await typeInBar(bar, "{Enter}");
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

      await typeInBar(bar, "hi @An");
      await userEvent.keyboard("{Enter}");

      expect(apiMock).not.toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({ method: "POST" })
      );
      expect(barText(bar)).toBe("hi @Ann Lee ");

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

    it("offers @everyone in the mention list and sends it as a flag", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await typeInBar(bar, "hi @ev");
      expect(screen.getByRole("button", { name: /Notify everyone in this group/ })).toBeVisible();
      await userEvent.keyboard("{Enter}");
      expect(barText(bar)).toBe("hi @everyone ");

      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ mentionsEveryone: true, mentionedAppUserIds: [] }),
          })
        )
      );
    });

    it("does not send @everyone when the text no longer says it", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await typeInBar(bar, "email me at me@everyone.org{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ mentionsEveryone: false }),
          })
        )
      );
    });

    it("makes a new line with Enter on a phone, and sends from the button", async () => {
      // Only the phone query: the rest of the page keeps its desktop behaviour.
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query === "(hover: none) and (pointer: coarse)",
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList
      );
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });

      await typeInBar(bar, "Hello{Enter}there");
      expect(apiMock).not.toHaveBeenCalledWith(
        "/groups/g1/posts",
        expect.objectContaining({ method: "POST" })
      );

      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ body: "Hello\nthere" }),
          })
        )
      );
    });

    it("formats from the Aa row and sends the formatting as text", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      await typeInBar(bar, "hi ");

      await userEvent.click(screen.getByRole("button", { name: "Show formatting" }));
      const bold = await screen.findByRole("button", { name: "Bold" });
      expect(bold).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(bold);
      await typeInBar(bar, "there");
      expect(bar.querySelector("strong")).toHaveTextContent("there");
      expect(bold).toHaveAttribute("aria-pressed", "true");

      await userEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
      expect(bar.querySelector("ul")).toBeInTheDocument();

      // The row closes back to +, Aa and emoji.
      await userEvent.click(screen.getByRole("button", { name: "Hide formatting" }));
      expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({ body: "- hi **there**" }),
          })
        )
      );
    });

    it("formats typed markers in place, Slack's shortcuts included", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      const editor = (bar as HTMLElement & { editor: Editor }).editor;
      // Each closing character goes in as a keystroke would, so the editor's
      // typing shortcuts see it.
      const typeClosing = (text: string, last: string) => {
        act(() => void editor.view.dispatch(editor.view.state.tr.insertText(text)));
        act(() => {
          const { view } = editor;
          const { from, to } = view.state.selection;
          const handled = view.someProp("handleTextInput", (f) =>
            f(view, from, to, last, () => view.state.tr)
          );
          if (!handled) view.dispatch(view.state.tr.insertText(last));
        });
      };
      await userEvent.click(bar);
      typeClosing("*bold", "*");
      typeClosing(" _soft", "_");
      typeClosing(" ~gone", "~");
      typeClosing(" ++under+", "+");
      typeClosing(" [site](example.org", ")");

      expect(bar.querySelector("strong")).toHaveTextContent("bold");
      expect(bar.querySelector("em")).toHaveTextContent("soft");
      expect(bar.querySelector("s")).toHaveTextContent("gone");
      expect(bar.querySelector("u")).toHaveTextContent("under");
      expect(bar.querySelector("a")).toHaveAttribute("href", "https://example.org");
      // None of the markers is left showing.
      expect(barText(bar)).toBe("bold soft gone under site");

      await userEvent.keyboard("{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              body: "**bold** _soft_ ~~gone~~ ++under++ [site](https://example.org)",
            }),
          })
        )
      );
    });

    it("formats pasted plain text, lists and links included", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      await userEvent.click(bar);
      // Text only, as a paste from Notes or a text message carries.
      const text = "Bring **snacks** and [the form](https://example.org)\n- one\n- two";
      fireEvent.paste(bar, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? text : ""),
          types: ["text/plain"],
        },
      });

      expect(bar.querySelector("strong")).toHaveTextContent("snacks");
      expect(bar.querySelector("a")).toHaveAttribute("href", "https://example.org");
      expect(bar.querySelectorAll("li")).toHaveLength(2);
      expect(barText(bar)).not.toContain("**");
    });

    it("reads mentions out of formatted text", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      await userEvent.click(bar);
      await userEvent.click(screen.getByRole("button", { name: "Show formatting" }));
      await userEvent.click(await screen.findByRole("button", { name: "Bold" }));
      await typeInBar(bar, "@An");
      await typeInBar(bar, "{Enter}");
      await typeInBar(bar, "{Enter}");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              body: "**@Ann Lee** ",
              mentionedAppUserIds: ["user-ann"],
            }),
          })
        )
      );
    });

    describe("sending only pictures or files", () => {
      const added = {
        photoKey: "photos/org-1/group-post/person-me/01TESTULID0000000000000001/",
        kind: "IMAGE" as const,
        filename: "picnic.jpg",
        contentType: "image/jpeg",
        byteSize: 1000,
      };

      const sendButton = () => screen.getByRole("button", { name: "Send" });

      it("rests as a pill with no Send, and keeps Send off with no text once it has focus", async () => {
        stub();
        renderPage();
        const bar = await screen.findByRole("textbox", { name: "Message" });
        expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Show formatting" })).not.toBeInTheDocument();

        await userEvent.click(bar);
        expect(sendButton()).toBeDisabled();
        expect(screen.getByRole("button", { name: "Show formatting" })).toBeInTheDocument();

        // Pressing somewhere else, with nothing typed, puts it back to rest.
        await userEvent.click(document.body);
        expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
      });

      it("sends an attachment with no text", async () => {
        pickerOverride.value = { attachments: [added], busy: false };
        stub();
        renderPage();
        await screen.findByRole("textbox", { name: "Message" });
        expect(sendButton()).toBeEnabled();

        await userEvent.click(sendButton());
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            "/groups/g1/posts",
            expect.objectContaining({
              method: "POST",
              body: expect.objectContaining({ kind: "MESSAGE", body: "", attachments: [added] }),
            })
          )
        );
      });

      it("sends an attachment with no text on Enter", async () => {
        pickerOverride.value = { attachments: [added], busy: false };
        stub();
        renderPage();
        const bar = await screen.findByRole("textbox", { name: "Message" });
        await userEvent.click(bar);
        await userEvent.keyboard("{Enter}");
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            "/groups/g1/posts",
            expect.objectContaining({
              method: "POST",
              body: expect.objectContaining({ attachments: [added] }),
            })
          )
        );
      });

      it("waits for a picture that is still being prepared", async () => {
        // One is ready, another is still being prepared: sending now would leave it behind.
        pickerOverride.value = { attachments: [added], busy: true };
        stub();
        renderPage();
        await screen.findByRole("textbox", { name: "Message" });
        expect(sendButton()).toBeDisabled();
      });

      it("sends an attachment with no text as a reply on a thread", async () => {
        pickerOverride.value = { attachments: [added], busy: false };
        stub({
          thread: {
            root: post({ id: "root-1", body: "Hello", replyCount: 0 }),
            replies: [],
          },
        });
        renderPage("/groups/g1/threads/root-1");
        await screen.findByRole("textbox", { name: "Reply" });
        expect(sendButton()).toBeEnabled();

        await userEvent.click(sendButton());
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            "/groups/g1/posts",
            expect.objectContaining({
              method: "POST",
              body: expect.objectContaining({
                kind: "MESSAGE",
                body: "",
                parentPostId: "root-1",
                attachments: [added],
              }),
            })
          )
        );
      });

      it("keeps Send off on a thread with nothing to send", async () => {
        stub({
          thread: {
            root: post({ id: "root-1", body: "Hello", replyCount: 0 }),
            replies: [],
          },
        });
        renderPage("/groups/g1/threads/root-1");
        await userEvent.click(await screen.findByRole("textbox", { name: "Reply" }));
        expect(sendButton()).toBeDisabled();
      });

      it("opens a picture-only message of mine for editing with an empty box, and needs text to save", async () => {
        stub({
          pages: [
            {
              posts: [
                post({
                  body: null,
                  attachments: [attachment()],
                  authorPersonId: "person-me",
                  canEdit: true,
                }),
              ],
              nextCursor: null,
            },
          ],
        });
        renderPage();
        await userEvent.click(await screen.findByRole("button", { name: "Actions for this post" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

        const bar = await screen.findByRole("textbox", { name: "Edit message" });
        expect(barText(bar)).toBe("");
        const save = screen.getByRole("button", { name: "Save changes" });
        expect(save).toBeDisabled();

        await typeInBar(bar, "From the picnic");
        expect(save).toBeEnabled();
        await userEvent.click(save);
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            expect.stringMatching(/^\/groups\/g1\/posts\/p\d+$/),
            expect.objectContaining({
              method: "PATCH",
              body: expect.objectContaining({ body: "From the picnic" }),
            })
          )
        );
      });

      it("still sends text with no attachment", async () => {
        stub();
        renderPage();
        await typeInBar(await screen.findByRole("textbox", { name: "Message" }), "Hello");
        expect(sendButton()).toBeEnabled();
      });

      it("treats spaces alone as no text", async () => {
        stub();
        renderPage();
        await typeInBar(await screen.findByRole("textbox", { name: "Message" }), "   ");
        expect(sendButton()).toBeDisabled();
      });

      it("shows a message that is only a picture", async () => {
        stub({
          pages: [
            {
              posts: [post({ body: null, attachments: [attachment()] })],
              nextCursor: null,
            },
          ],
        });
        renderPage();
        expect(
          await screen.findByRole("button", { name: "Show picnic.jpg full screen" })
        ).toBeInTheDocument();
      });
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

      await typeInBar(bar, "   ");
      expect(typingCalls()).toHaveLength(0);

      await typeInBar(bar, "abc");
      expect(typingCalls()).toHaveLength(1);
      expect(typingCalls()[0]![1]).toEqual({ method: "POST" });

      nowMs += 3500;
      await typeInBar(bar, "d");
      expect(typingCalls()).toHaveLength(2);
      clock.mockRestore();
    });

    it("does not signal typing from the thread's reply bar", async () => {
      const root = post({ id: "root-1", body: "Hello", replyCount: 0 });
      stub({ thread: { root, replies: [] } });
      renderPage("/groups/g1/threads/root-1");
      await typeInBar(await screen.findByRole("textbox", { name: "Reply" }), "thinking");
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
      expect(barText(screen.getByRole("textbox", { name: "Edit message" }))).toBe("Hello there");
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

    describe("when the message field loses focus", () => {
      afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      });

      async function openMessageField() {
        stub();
        renderPage();
        const field = await screen.findByRole("textbox", { name: "Message" });
        field.focus();
        vi.mocked(window.scrollTo).mockClear();
        return field;
      }

      it("glides back to the top when the keyboard's pan left the page scrolled", async () => {
        const field = await openMessageField();
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(field);
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      });

      it("does not animate for someone who asked for reduced motion", async () => {
        const field = await openMessageField();
        vi.stubGlobal(
          "matchMedia",
          vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
        );
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(field);
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
      });

      it("leaves the page alone when it is already at the top", async () => {
        const field = await openMessageField();
        fireEvent.focusOut(field);
        expect(window.scrollTo).not.toHaveBeenCalled();
      });

      it("leaves the page alone when focus moves to another field, so the keyboard stays up", async () => {
        const field = await openMessageField();
        const other = document.createElement("input");
        document.body.appendChild(other);
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(field, { relatedTarget: other });
        expect(window.scrollTo).not.toHaveBeenCalled();
        other.remove();
      });

      it("snaps to the top once the keyboard has gone if the glide was not enough", async () => {
        const field = await openMessageField();
        vi.useFakeTimers();
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(field);
        vi.mocked(window.scrollTo).mockClear();
        vi.advanceTimersByTime(700);
        expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      });

      it("does not snap once the glide has arrived", async () => {
        const field = await openMessageField();
        vi.useFakeTimers();
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(field);
        vi.mocked(window.scrollTo).mockClear();
        vi.stubGlobal("scrollY", 0);
        vi.advanceTimersByTime(700);
        expect(window.scrollTo).not.toHaveBeenCalled();
      });

      it("stops listening once the conversation is left", async () => {
        stub();
        const { unmount } = renderPage();
        await screen.findByRole("textbox", { name: "Message" });
        unmount();
        vi.mocked(window.scrollTo).mockClear();
        vi.stubGlobal("scrollY", 120);
        fireEvent.focusOut(document.body);
        expect(window.scrollTo).not.toHaveBeenCalled();
      });
    });
  });

  describe("pictures in a conversation", () => {
    beforeEach(() => {
      window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    });

    function feedWithPicture(extra: GroupPostAttachmentDto[] = []) {
      stub({
        pages: [{ posts: [post({ attachments: [attachment(), ...extra] })], nextCursor: null }],
      });
    }

    it("opens a picture in the lightbox instead of navigating to the bare image", async () => {
      feedWithPicture();
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Show picnic.jpg full screen" })
      );

      const dialog = await screen.findByRole("dialog", { name: "picnic.jpg" });
      expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/picnic-full.webp");
      // No link to the raw file is left to navigate to.
      expect(document.querySelector('a[href="/picnic-full.webp"]')).toBeNull();
    });

    it("closes with the X", async () => {
      feedWithPicture();
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Show picnic.jpg full screen" })
      );
      await userEvent.click(await screen.findByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes with Escape", async () => {
      feedWithPicture();
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Show picnic.jpg full screen" })
      );
      await screen.findByRole("dialog");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens the one that was tapped when a message has several", async () => {
      feedWithPicture([attachment({ id: "a2", filename: "cake.jpg", fullUrl: "/cake-full.webp" })]);
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Show cake.jpg full screen" })
      );
      const dialog = await screen.findByRole("dialog", { name: "cake.jpg" });
      expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/cake-full.webp");
    });

    it("does not offer a lightbox for a picture with no full-size rendition", async () => {
      feedWithPicture([attachment({ id: "a3", filename: "pending.jpg", fullUrl: null })]);
      renderPage();
      expect(
        await screen.findByRole("button", { name: "Show pending.jpg full screen" })
      ).toBeDisabled();
    });

    it("still downloads a document", async () => {
      feedWithPicture([
        attachment({
          id: "a4",
          kind: "FILE",
          filename: "bulletin.pdf",
          thumbUrl: null,
          fullUrl: null,
          downloadUrl: "/bulletin.pdf",
        }),
      ]);
      renderPage();
      expect(await screen.findByRole("link", { name: "bulletin.pdf" })).toHaveAttribute(
        "href",
        "/bulletin.pdf"
      );
    });

    describe("on the Files tab", () => {
      const imageFile: GroupFileDto = {
        postId: "p1",
        postCreatedAt: "2026-10-09T10:00:00.000Z",
        authorPersonId: "person-ann",
        authorName: "Ann Lee",
        attachment: attachment(),
      };
      const documentFile: GroupFileDto = {
        ...imageFile,
        attachment: attachment({
          id: "a5",
          kind: "FILE",
          filename: "bulletin.pdf",
          thumbUrl: null,
          fullUrl: null,
          downloadUrl: "/bulletin.pdf",
        }),
      };

      async function openFiles() {
        renderPage();
        await userEvent.click(await screen.findByRole("button", { name: "Files" }));
      }

      it("opens an image from Open in the lightbox", async () => {
        stub({ files: [imageFile] });
        await openFiles();
        await userEvent.click(await screen.findByRole("button", { name: "Open" }));

        const dialog = await screen.findByRole("dialog", { name: "picnic.jpg" });
        expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/picnic-full.webp");
        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      it("keeps Open as a download link for a document", async () => {
        stub({ files: [documentFile] });
        await openFiles();
        expect(await screen.findByRole("link", { name: "Open" })).toHaveAttribute(
          "href",
          "/bulletin.pdf"
        );
        expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      });
    });
  });

  describe("events", () => {
    const nextWeek = () => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return localDayIso(d);
    };
    const event = (overrides: Partial<NonNullable<GroupPostDto["event"]>> = {}, id = "e1") =>
      post({
        id,
        kind: "EVENT",
        body: null,
        event: {
          title: "Parish Potluck",
          description: "Bring a dish",
          eventDate: nextWeek(),
          startTime: "18:30",
          endTime: "20:00",
          location: "Parish Hall",
          rsvpCounts: { yes: 3, no: 1, maybe: 2, publicAttending: 0 },
          myRsvp: null,
          shareToken: "01JSHARETOKEN0000000000000",
          publicRsvpEnabled: false,
          ...overrides,
        },
      });

    it("shows an event as a card: date tile, when, a map link for where, and who is coming", async () => {
      stub({ pages: [{ posts: [event()], nextCursor: null }] });
      renderPage();
      expect(await screen.findByRole("heading", { name: "Parish Potluck" })).toBeInTheDocument();
      expect(screen.getByText("6:30 – 8:00 PM", { exact: false })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Parish Hall" })).toHaveAttribute(
        "href",
        expect.stringContaining("google.com/maps/search/?api=1&query=Parish%20Hall")
      );
      expect(screen.getByText("Bring a dish")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /3 going · 2 maybe · 1 not going/ })
      ).toBeInTheDocument();
    });

    it("keeps a cancelled event's details but drops the RSVP controls and info", async () => {
      const cancelled = {
        ...event({ myRsvp: { response: "YES", guestCount: 2 } }),
        deletedAt: "2026-10-09T12:00:00.000Z",
        deletedBySelf: true,
      };
      stub({ pages: [{ posts: [cancelled], nextCursor: null }] });
      renderPage();
      expect(await screen.findByRole("heading", { name: "Parish Potluck" })).toBeInTheDocument();
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
      expect(screen.getByText("6:30 – 8:00 PM", { exact: false })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Parish Hall" })).toBeInTheDocument();
      // No RSVP side at all.
      expect(screen.queryByRole("group", { name: "Your RSVP" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "More guests" })).not.toBeInTheDocument();
      expect(screen.queryByText(/going · /)).not.toBeInTheDocument();
      // And no actions menu on a cancelled event.
      expect(
        screen.queryByRole("button", { name: "Actions for this post" })
      ).not.toBeInTheDocument();
    });

    it("lets the person who cancelled an event re-activate it from its menu", async () => {
      const cancelled = {
        ...event({}, "e-cancelled"),
        deletedAt: "2026-10-09T12:00:00.000Z",
        deletedBySelf: true,
        canRestore: true,
      };
      stub({ pages: [{ posts: [cancelled], nextCursor: null }] });
      renderPage();
      await screen.findByText("Cancelled");
      await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Re-activate event" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e-cancelled/restore", {
          method: "POST",
        })
      );
    });

    it("lets them re-activate it with a long press on a phone", async () => {
      const cancelled = {
        ...event({}, "e-cancelled"),
        deletedAt: "2026-10-09T12:00:00.000Z",
        deletedBySelf: true,
        canRestore: true,
      };
      stub({ pages: [{ posts: [cancelled], nextCursor: null }] });
      renderPage();
      const row = (await screen.findByText("Cancelled")).closest("li")!;
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
      const drawer = await screen.findByRole("dialog", { name: "Message" });
      await userEvent.click(within(drawer).getByRole("button", { name: "Re-activate event" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e-cancelled/restore", {
          method: "POST",
        })
      );
    });

    it("offers nothing to anyone who cannot re-activate a cancelled event", async () => {
      const cancelled = {
        ...event({}, "e-cancelled"),
        deletedAt: "2026-10-09T12:00:00.000Z",
        deletedBySelf: false,
      };
      stub({ pages: [{ posts: [cancelled], nextCursor: null }] });
      renderPage();
      const row = (await screen.findByText("Cancelled")).closest("li")!;
      expect(
        screen.queryByRole("button", { name: "Actions for this post" })
      ).not.toBeInTheDocument();
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 5, clientY: 5 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(screen.queryByRole("dialog", { name: "Message" })).not.toBeInTheDocument();
    });

    it("marks an event that has gone as Past", async () => {
      stub({ pages: [{ posts: [event({ eventDate: "2020-01-01" })], nextCursor: null }] });
      renderPage();
      await screen.findByRole("heading", { name: "Parish Potluck" });
      expect(screen.getByText("Past")).toBeInTheDocument();
    });

    it("says today for an event today", async () => {
      stub({
        pages: [{ posts: [event({ eventDate: localDayIso(new Date()) })], nextCursor: null }],
      });
      renderPage();
      await screen.findByRole("heading", { name: "Parish Potluck" });
      expect(screen.getByText("Today")).toBeInTheDocument();
    });

    it("RSVPs from a segmented control, and steps the guest count", async () => {
      stub({
        pages: [
          {
            posts: [event({ myRsvp: { response: "YES", guestCount: 1 } })],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      await screen.findByRole("heading", { name: "Parish Potluck" });
      const group = screen.getByRole("group", { name: "Your RSVP" });
      expect(within(group).getByRole("button", { name: "Going" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      // Your own guests, not the event's total.
      expect(screen.getByText("My guests")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "More guests" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e1/rsvp", {
          method: "PUT",
          body: { response: "YES", guestCount: 2 },
        })
      );
      await userEvent.click(within(group).getByRole("button", { name: "Maybe" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e1/rsvp", {
          method: "PUT",
          body: { response: "MAYBE", guestCount: 1 },
        })
      );
    });

    it("offers no guest stepper unless you are going, and none below zero", async () => {
      stub({
        pages: [
          { posts: [event({ myRsvp: { response: "MAYBE", guestCount: 0 } })], nextCursor: null },
        ],
      });
      renderPage();
      await screen.findByRole("heading", { name: "Parish Potluck" });
      expect(screen.queryByRole("button", { name: "More guests" })).not.toBeInTheDocument();
    });

    it("lists a cancelled event on the Events tab, marked cancelled and without RSVP", async () => {
      const cancelled = {
        ...event({ title: "Called Off" }, "e-cancelled"),
        deletedAt: "2026-10-09T12:00:00.000Z",
        deletedBySelf: true,
      };
      const live = event({ title: "Still On" }, "e-live");
      apiMock.mockImplementation((path: string) => {
        if (path === "/groups/g1") return Promise.resolve(group());
        if (path === "/groups/g1/live") return Promise.resolve({ activityAt: "x", typing: [] });
        if (path === "/groups/g1/events") return Promise.resolve({ events: [cancelled, live] });
        return Promise.resolve({ posts: [], nextCursor: null });
      });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Events" }));
      await screen.findByRole("heading", { name: "Still On" });

      expect(screen.getByRole("heading", { name: "Called Off" })).toBeInTheDocument();
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
      // RSVP controls only on the event that is still on.
      expect(screen.getAllByRole("group", { name: "Your RSVP" })).toHaveLength(1);
    });

    it("lists upcoming events soonest first and past ones most recent first, as cards", async () => {
      const soon = event({ title: "Soon", eventDate: nextWeek() }, "e-soon");
      const later = event(
        { title: "Later", eventDate: localDayIso(new Date(Date.now() + 30 * 86_400_000)) },
        "e-later"
      );
      const old = event({ title: "Old", eventDate: "2020-02-01" }, "e-old");
      const older = event({ title: "Older", eventDate: "2019-02-01" }, "e-older");
      apiMock.mockImplementation((path: string) => {
        if (path === "/groups/g1") return Promise.resolve(group());
        if (path === "/groups/g1/live") return Promise.resolve({ activityAt: "x", typing: [] });
        if (path === "/groups/g1/events")
          // The API's order: newest first.
          return Promise.resolve({ events: [later, soon, old, older] });
        return Promise.resolve({ pages: [], posts: [], nextCursor: null });
      });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Events" }));
      await screen.findByRole("heading", { name: "Soon" });

      const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
      expect(titles).toEqual(["Soon", "Later", "Old", "Older"]);
      expect(screen.getByRole("heading", { name: /Upcoming/ })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Past/ })).toBeInTheDocument();
      expect(screen.getAllByText(/Posted by/)).toHaveLength(4);
    });
  });

  describe("polls", () => {
    const poll = (
      overrides: Partial<NonNullable<GroupPostDto["poll"]>> = {},
      postOverrides: Partial<GroupPostDto> = {}
    ) =>
      post({
        id: "poll1",
        kind: "POLL",
        body: null,
        canEdit: false,
        poll: {
          question: "Where shall we eat?",
          allowsMultiple: false,
          voterCount: 4,
          options: [
            {
              id: "o1",
              label: "Pizza",
              voteCount: 3,
              votedByMe: false,
              voters: [{ personId: "person-bo", name: "Bo Park" }],
            },
            { id: "o2", label: "Tacos", voteCount: 1, votedByMe: true, voters: [] },
            { id: "o3", label: "Sushi", voteCount: 0, votedByMe: false, voters: [] },
          ],
          ...overrides,
        },
        ...postOverrides,
      });
    const votes = () =>
      apiMock.mock.calls.filter((c) => String(c[0]).endsWith("/vote")).map((c) => c[1].body);

    it("starts a poll from the + menu, with options added, removed and several allowed", async () => {
      stub();
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Add to this message" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Poll…" }));
      const dialog = await screen.findByRole("dialog", { name: "New poll" });
      const post = within(dialog).getByRole("button", { name: "Post poll" });

      await userEvent.type(within(dialog).getByLabelText("Question"), "Where shall we eat?");
      await userEvent.type(within(dialog).getByLabelText("Option 1"), "Pizza");
      expect(post).toBeDisabled();
      // Enter in the last option adds the next one and moves there.
      await userEvent.type(within(dialog).getByLabelText("Option 2"), "Tacos{Enter}");
      expect(within(dialog).getByLabelText("Option 3")).toHaveFocus();
      await userEvent.keyboard("Sushi{Enter}Thai");
      await userEvent.click(within(dialog).getByRole("button", { name: "Remove option 3" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Several options" }));
      expect(post).toBeEnabled();
      await userEvent.click(post);

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts",
          expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              kind: "POLL",
              poll: {
                question: "Where shall we eat?",
                options: ["Pizza", "Tacos", "Thai"],
                allowsMultiple: true,
              },
            }),
          })
        )
      );
    });

    it("will not post a poll whose options repeat", async () => {
      stub();
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Add to this message" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Poll…" }));
      const dialog = await screen.findByRole("dialog", { name: "New poll" });
      await userEvent.type(within(dialog).getByLabelText("Question"), "Yes?");
      await userEvent.type(within(dialog).getByLabelText("Option 1"), "Yes");
      await userEvent.type(within(dialog).getByLabelText("Option 2"), "yes ");
      expect(within(dialog).getByText("Each option must be different.")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Post poll" })).toBeDisabled();
    });

    it("shows the results as a share of the people who voted", async () => {
      stub({ pages: [{ posts: [poll()], nextCursor: null }] });
      renderPage();
      expect(
        await screen.findByRole("heading", { name: "Where shall we eat?" })
      ).toBeInTheDocument();
      expect(screen.getByText(/Choose one/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pizza, 3 votes, 75%" })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
      expect(screen.getByRole("button", { name: "Tacos, 1 vote, 25%" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      expect(screen.getByRole("button", { name: "4 people voted" })).toBeInTheDocument();
    });

    it("moves a single-choice vote, and takes it back on a second tap", async () => {
      stub({ pages: [{ posts: [poll()], nextCursor: null }] });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: /^Pizza,/ }));
      await waitFor(() => expect(votes()).toEqual([{ optionIds: ["o1"] }]));

      await userEvent.click(screen.getByRole("button", { name: /^Tacos,/ }));
      await waitFor(() => expect(votes()).toEqual([{ optionIds: ["o1"] }, { optionIds: [] }]));
    });

    it("toggles each option on its own on a multiple-choice poll", async () => {
      stub({ pages: [{ posts: [poll({ allowsMultiple: true })], nextCursor: null }] });
      renderPage();
      expect(await screen.findByText(/Choose any/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /^Sushi,/ }));
      await waitFor(() => expect(votes()).toEqual([{ optionIds: ["o2", "o3"] }]));
    });

    it("lists who voted for what", async () => {
      stub({ pages: [{ posts: [poll()], nextCursor: null }] });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "4 people voted" }));
      const dialog = await screen.findByRole("dialog", { name: "Votes" });
      expect(within(dialog).getByRole("link", { name: "Bo Park" })).toHaveAttribute(
        "href",
        "/people/person-bo"
      );
    });

    it("shows the results but no voting to someone who cannot take part", async () => {
      stub({ group: group({ canReact: false }), pages: [{ posts: [poll()], nextCursor: null }] });
      renderPage();
      expect(await screen.findByRole("button", { name: /^Pizza,/ })).toBeDisabled();
      expect(screen.queryByText("Tap an option to vote")).not.toBeInTheDocument();
    });

    it("leaves a placeholder for a deleted poll", async () => {
      stub({
        pages: [
          {
            posts: [
              poll({}, { poll: null, deletedAt: "2026-10-09T12:00:00.000Z", deletedBySelf: true }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      expect(await screen.findByText("Poll deleted")).toBeInTheDocument();
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
      await typeInBar(await screen.findByRole("textbox", { name: "Reply" }), "Thanks{Enter}");
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
      const bar = await screen.findByRole("textbox", { name: "Reply" });
      await waitFor(() => expect(bar).toHaveFocus());
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

    it("has no join controls in the header, even for someone who is not a member", async () => {
      stub({ group: group({ myRole: null, canPost: false, canReply: false }) });
      renderPage();
      const heading = await screen.findByRole("heading", { name: "Youth Group" });
      expect(
        within(heading.closest("header")!).queryByRole("button", { name: /join/i })
      ).not.toBeInTheDocument();
    });
  });

  describe("joining", () => {
    const outsider = { myRole: null, canPost: false, canReply: false, canReact: false };

    it("puts Join where the message bar would be for a public group", async () => {
      stub({ group: group(outsider) });
      renderPage();
      const bar = (await screen.findByText("You're previewing this group.")).closest("div")!;
      await userEvent.click(within(bar).getByRole("button", { name: "Join" }));
      expect(apiMock).toHaveBeenCalledWith(
        "/groups/g1/members",
        expect.objectContaining({ method: "POST", body: { personId: "person-me" } })
      );
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("offers Join in place of the reply bar on a thread", async () => {
      const root = post({ id: "root" });
      stub({ group: group(outsider), thread: { root, replies: [] } });
      renderPage("/groups/g1/threads/root");
      const bar = (await screen.findByText("You're previewing this group.")).closest("div")!;
      expect(within(bar).getByRole("button", { name: "Join" })).toBeInTheDocument();
      expect(screen.queryByText("You cannot reply in this group.")).not.toBeInTheDocument();
    });

    it("asks to join from the members-only card of a private group", async () => {
      stub({ group: group({ ...outsider, visibility: "PRIVATE", canRequestToJoin: true }) });
      renderPage();
      await screen.findByText("Members only");
      await userEvent.click(screen.getByRole("button", { name: "Ask to join" }));
      expect(apiMock).toHaveBeenCalledWith(
        "/groups/g1/join-requests",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("says a request is waiting, with nothing to press", async () => {
      stub({ group: group({ ...outsider, visibility: "PRIVATE", pendingJoinRequestId: "jr1" }) });
      renderPage();
      expect(
        await screen.findByText("Your request to join is waiting for an admin to approve it.")
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /join/i })).not.toBeInTheDocument();
    });

    it("keeps the bar for a parish admin who can post, with Join on a line above it", async () => {
      stub({ group: group({ myRole: null }) });
      renderPage();
      const line = (await screen.findByText("You're not a member.")).parentElement!;
      expect(within(line).getByRole("button", { name: "Join" })).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("shows Join under the Events tab too", async () => {
      stub({ group: group(outsider) });
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Events" }));
      expect(await screen.findByText("You're previewing this group.")).toBeInTheDocument();
    });

    it("shows nothing to join for a member", async () => {
      stub();
      renderPage();
      await screen.findByRole("heading", { name: "Youth Group" });
      expect(screen.queryByRole("button", { name: /join/i })).not.toBeInTheDocument();
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
      const bar = await screen.findByRole("textbox", { name: "Edit message" });
      // The bar is relabelled a render before the message's text arrives in it;
      // typing in between would be overwritten by it, as on a slow CI runner.
      await waitFor(() => expect(barText(bar)).toBe("Hello"));
      await waitFor(() => expect(bar).toHaveFocus());
      return bar;
    }

    it("uses the message bar at the bottom, not a new input inside the conversation", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();

      expect(barText(bar)).toBe("Hello");
      await waitFor(() => expect(bar).toHaveFocus());
      expect(screen.getByText("Editing message")).toBeInTheDocument();
      // The only text box is the bar itself, and it is not inside the message log.
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(within(screen.getByRole("log")).queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("swaps send for accept and cancel, and keeps the + menu for pictures but not an event", async () => {
      stub(mine());
      renderPage();
      await startEdit();
      expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
      const accept = screen.getByRole("button", { name: "Save changes" });
      const cancel = screen.getByRole("button", { name: "Cancel editing" });
      expect(accept.className).toContain("green");
      expect(cancel.className).toContain("red");
      // Nothing has changed yet, so there is nothing to accept.
      expect(accept).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Add to this message" }));
      expect(screen.getByRole("menuitem", { name: "Photo or file" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Event…" })).not.toBeInTheDocument();
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
      await typeInBar(bar, " @Bo");
      await userEvent.keyboard("{Enter}");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/groups/g1/posts/p1",
          expect.objectContaining({
            method: "PATCH",
            body: {
              body: "Hello @Bo Park ",
              mentionedAppUserIds: ["user-bo"],
              mentionsEveryone: false,
              removeAttachmentIds: [],
              addAttachments: [],
            },
          })
        )
      );
      // Back to the ordinary bar.
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
      expect(barText(screen.getByRole("textbox", { name: "Message" }))).toBe("");
    });

    describe("pictures and files", () => {
      const picnic = attachment({ id: "a1", filename: "picnic.jpg" });
      const cake = attachment({
        id: "a2",
        filename: "cake.jpg",
        thumbUrl: "/cake-thumb.webp",
        fullUrl: "/cake-full.webp",
      });
      const added = {
        photoKey: "photos/org-1/group-post/person-me/01TESTULID0000000000000009/",
        kind: "IMAGE" as const,
        filename: "new.jpg",
        contentType: "image/jpeg",
        byteSize: 1000,
      };

      const withPictures = (overrides: Partial<GroupPostDto> = {}) => ({
        pages: [
          {
            posts: [
              post({
                body: "Hello",
                attachments: [picnic, cake],
                authorPersonId: "person-me",
                canEdit: true,
                ...overrides,
              }),
            ],
            nextCursor: null,
          },
        ],
      });

      const patchBody = () =>
        apiMock.mock.calls.find((c) => c[1]?.method === "PATCH")![1].body as Record<
          string,
          unknown
        >;

      it("shows the message's pictures in the bar, each with a remove button", async () => {
        stub(withPictures());
        renderPage();
        await startEdit();
        expect(screen.getByRole("button", { name: "Remove picnic.jpg" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Remove cake.jpg" })).toBeInTheDocument();
      });

      it("takes a picture off and sends its id", async () => {
        stub(withPictures());
        renderPage();
        await startEdit();
        const save = screen.getByRole("button", { name: "Save changes" });
        expect(save).toBeDisabled();

        await userEvent.click(screen.getByRole("button", { name: "Remove picnic.jpg" }));
        expect(screen.queryByRole("button", { name: "Remove picnic.jpg" })).not.toBeInTheDocument();
        expect(save).toBeEnabled();

        await userEvent.click(save);
        await waitFor(() => expect(patchBody()).toBeDefined());
        expect(patchBody()).toMatchObject({
          body: "Hello",
          removeAttachmentIds: ["a1"],
          addAttachments: [],
        });
      });

      it("sends a newly added picture", async () => {
        pickerOverride.value = { attachments: [added], busy: false };
        stub(withPictures());
        renderPage();
        await startEdit();
        expect(screen.getByRole("button", { name: "Remove new.jpg" })).toBeInTheDocument();
        const save = screen.getByRole("button", { name: "Save changes" });
        expect(save).toBeEnabled();

        await userEvent.click(save);
        await waitFor(() => expect(patchBody()).toBeDefined());
        expect(patchBody()).toMatchObject({ removeAttachmentIds: [], addAttachments: [added] });
      });

      it("can only be saved with words or at least one picture left", async () => {
        stub(withPictures());
        renderPage();
        const bar = await startEdit();
        await userEvent.click(screen.getByRole("button", { name: "Remove picnic.jpg" }));
        await userEvent.click(screen.getByRole("button", { name: "Remove cake.jpg" }));
        // Words are still there.
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

        await userEvent.clear(bar);
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      });

      it("allows clearing the words while a picture stays", async () => {
        stub(withPictures());
        renderPage();
        const bar = await startEdit();
        await userEvent.clear(bar);
        const save = screen.getByRole("button", { name: "Save changes" });
        expect(save).toBeEnabled();

        await userEvent.click(save);
        await waitFor(() => expect(patchBody()).toBeDefined());
        expect(patchBody()).toMatchObject({ body: "", removeAttachmentIds: [] });
      });

      it("waits for a picture still being prepared before saving", async () => {
        pickerOverride.value = { attachments: [added], busy: true };
        stub(withPictures());
        renderPage();
        await startEdit();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      });

      it("puts the pictures back, and the draft, when the edit is cancelled", async () => {
        stub(withPictures());
        renderPage();
        await startEdit();
        await userEvent.click(screen.getByRole("button", { name: "Remove picnic.jpg" }));
        await userEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
        expect(apiMock).not.toHaveBeenCalledWith(
          expect.stringContaining("/posts/p"),
          expect.objectContaining({ method: "PATCH" })
        );

        // Editing it again starts from what was saved, not from the abandoned removal.
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
        await screen.findByRole("textbox", { name: "Edit message" });
        expect(screen.getByRole("button", { name: "Remove picnic.jpg" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      });

      it("stops offering more once the message is at its limit", async () => {
        const many = Array.from({ length: GROUP_POST_MAX_ATTACHMENTS }, (_, i) =>
          attachment({ id: `m${i}`, filename: `pic${i}.jpg` })
        );
        const open = vi.fn();
        pickerOverride.value = { open };
        stub(withPictures({ attachments: many }));
        renderPage();
        await startEdit();
        await userEvent.click(screen.getByRole("button", { name: "Add to this message" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Photo or file" }));
        expect(open).not.toHaveBeenCalled();

        // Taking one off makes room again.
        await userEvent.click(screen.getByRole("button", { name: "Remove pic0.jpg" }));
        await userEvent.click(screen.getByRole("button", { name: "Add to this message" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Photo or file" }));
        expect(open).toHaveBeenCalledTimes(1);
      });
    });

    it("saves with Enter too", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await typeInBar(bar, "!{Enter}");
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
      await typeInBar(draftBar, "half a thought");

      let bar = await startEdit();
      expect(barText(bar)).toBe("Hello");
      await typeInBar(bar, " changed");
      await userEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
      expect(barText(screen.getByRole("textbox", { name: "Message" }))).toBe("half a thought");

      bar = await startEdit();
      await typeInBar(bar, "{Escape}");
      expect(barText(screen.getByRole("textbox", { name: "Message" }))).toBe("half a thought");

      expect(apiMock.mock.calls.some((c) => c[1]?.method === "PATCH")).toBe(false);
    });

    it("keeps editing open when Escape only closes the mention list", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await typeInBar(bar, " @An");
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("textbox", { name: "Edit message" })).toBeInTheDocument();
    });

    it("does not signal typing while editing", async () => {
      stub(mine());
      renderPage();
      const bar = await startEdit();
      await typeInBar(bar, " more");
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
      // As in startEdit: the reply's text arrives a render after the label.
      await waitFor(() => expect(barText(bar)).toBe("my reply"));
      await waitFor(() => expect(bar).toHaveFocus());
      await typeInBar(bar, "!");
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
      expect(select).toHaveTextContent("Nothing");
      await userEvent.click(select);
      expect(
        screen.getByRole("option", { name: "Use my default (Only when I'm mentioned)" })
      ).toBeInTheDocument();
      await userEvent.click(select);

      await chooseOption(select, "");
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/groups/g1/notification-preference", {
          method: "PUT",
          body: { notificationPref: null },
        })
      );
    });
  });

  describe("reactions", () => {
    const reactor = (personId: string, name: string) => ({
      appUserId: `user-${personId.slice(7)}`,
      personId,
      name,
    });
    const FIRE = "🔥";
    const fire = (overrides = {}) => ({
      emoji: FIRE,
      reactedByMe: false,
      reactors: [reactor("person-ann", "Ann Lee"), reactor("person-bo", "Bo Park")],
      ...overrides,
    });
    const reactionPath = (postId: string, emoji: string) =>
      `/groups/g1/posts/${postId}/reactions/${encodeURIComponent(emoji)}`;

    /** Answers a reaction write the way the server does, with the post as it then stands. */
    function answerReactions(target: GroupPostDto, after: GroupPostDto["reactions"]) {
      const base = apiMock.getMockImplementation()!;
      apiMock.mockImplementation((path: string, options?: unknown) =>
        path.includes("/reactions/")
          ? Promise.resolve({ ...target, reactions: after })
          : base(path, options)
      );
    }
    const feed = (p: GroupPostDto) => ({ pages: [{ posts: [p], nextCursor: null }] });
    const sent = (path: string, method: string) =>
      apiMock.mock.calls.some(([p, o]) => p === path && o?.method === method);

    it("shows each emoji with its count, yours marked", async () => {
      const p = post({
        body: "Hello there",
        reactions: [
          fire(),
          { emoji: "👍", reactedByMe: true, reactors: [reactor("person-me", "Me Myself")] },
        ],
      });
      stub(feed(p));
      renderPage();
      const pills = await screen.findByRole("group", { name: "Reactions" });
      const ours = within(pills).getByRole("button", { name: "1 person reacted with 👍" });
      const theirs = within(pills).getByRole("button", { name: "2 people reacted with 🔥" });
      expect(ours).toHaveAttribute("aria-pressed", "true");
      expect(theirs).toHaveAttribute("aria-pressed", "false");
      expect(ours).toHaveTextContent("1");
      expect(theirs).toHaveTextContent("2");
    });

    it("shows nothing under a message nobody has reacted to", async () => {
      stub(feed(post({ body: "Quiet" })));
      renderPage();
      await screen.findByText("Quiet");
      expect(screen.queryByRole("group", { name: "Reactions" })).toBeNull();
    });

    it("adds your reaction when you click a pill, before the server answers", async () => {
      const p = post({ body: "Hello there", reactions: [fire()] });
      stub(feed(p));
      renderPage();
      const pill = await screen.findByRole("button", { name: "2 people reacted with 🔥" });
      // Never answers: what shows now is the optimistic state.
      const base = apiMock.getMockImplementation()!;
      apiMock.mockImplementation((path: string, options?: unknown) =>
        path.includes("/reactions/") ? new Promise(() => {}) : base(path, options)
      );

      await userEvent.click(pill);
      expect(apiMock).toHaveBeenCalledWith(reactionPath(p.id, FIRE), { method: "PUT" });
      const updated = await screen.findByRole("button", { name: "3 people reacted with 🔥" });
      expect(updated).toHaveAttribute("aria-pressed", "true");
    });

    it("takes your reaction back when you click your own pill", async () => {
      const p = post({
        body: "Hello there",
        reactions: [fire({ reactedByMe: true, reactors: [reactor("person-me", "Me Myself")] })],
      });
      stub(feed(p));
      renderPage();
      answerReactions(p, []);
      await userEvent.click(
        await screen.findByRole("button", { name: "1 person reacted with 🔥" })
      );
      await waitFor(() => expect(sent(reactionPath(p.id, FIRE), "DELETE")).toBe(true));
      await waitFor(() => expect(screen.queryByRole("group", { name: "Reactions" })).toBeNull());
    });

    it("puts the pill back, and says why, when the server refuses", async () => {
      const p = post({ body: "Hello there", reactions: [fire()] });
      stub(feed(p));
      renderPage();
      const pill = await screen.findByRole("button", { name: "2 people reacted with 🔥" });
      const base = apiMock.getMockImplementation()!;
      apiMock.mockImplementation((path: string, options?: unknown) =>
        path.includes("/reactions/")
          ? Promise.reject(new ApiError(409, "A post can have at most 20 different reactions"))
          : base(path, options)
      );
      await userEvent.click(pill);
      expect(await screen.findByRole("alert")).toHaveTextContent("at most 20");
      expect(
        await screen.findByRole("button", { name: "2 people reacted with 🔥" })
      ).toHaveAttribute("aria-pressed", "false");
    });

    it("names who reacted when you hover a pill, you first", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ "1F525": "fire" }) })
      );
      const p = post({
        body: "Hello there",
        reactions: [
          fire({
            reactedByMe: true,
            reactors: [reactor("person-ann", "Ann Lee"), reactor("person-me", "Me Myself")],
          }),
        ],
      });
      stub(feed(p));
      renderPage();
      await userEvent.hover(
        await screen.findByRole("button", { name: "2 people reacted with 🔥" })
      );
      const tip = await screen.findByRole("tooltip");
      expect(tip).toHaveTextContent("You (click to remove) and Ann Lee");
      await waitFor(() => expect(tip).toHaveTextContent("reacted with :fire:"));
      vi.unstubAllGlobals();
    });

    it("lists everyone, and 'N others' past ten names", async () => {
      const many = Array.from({ length: 13 }, (_, i) =>
        reactor(`person-x${i}`, `Person ${String.fromCharCode(65 + i)}`)
      );
      stub(feed(post({ body: "Hello there", reactions: [fire({ reactors: many })] })));
      renderPage();
      await userEvent.hover(
        await screen.findByRole("button", { name: "13 people reacted with 🔥" })
      );
      const tip = await screen.findByRole("tooltip");
      expect(tip).toHaveTextContent("Person J, and 3 others");
      expect(tip).not.toHaveTextContent("Person K");
    });

    it("adds a reaction from the picker beside the pills, and remembers it", async () => {
      const p = post({ body: "Hello there", reactions: [fire()] });
      stub(feed(p));
      renderPage();
      answerReactions(p, [
        fire(),
        { emoji: "🎉", reactedByMe: true, reactors: [reactor("person-me", "Me Myself")] },
      ]);
      const pills = await screen.findByRole("group", { name: "Reactions" });
      await userEvent.click(within(pills).getByRole("button", { name: "Add reaction" }));
      await userEvent.click(await screen.findByRole("button", { name: "pick party" }));
      await waitFor(() => expect(sent(reactionPath(p.id, "🎉"), "PUT")).toBe(true));
      expect(screen.queryByTestId("emoji-picker")).toBeNull();
      expect(
        await screen.findByRole("button", { name: "1 person reacted with 🎉" })
      ).toBeInTheDocument();

      // The hover toolbar now leads with it.
      const row = screen.getByText("Hello there").closest("li")!;
      expect(
        within(row).getAllByRole("button", { name: /^(React with|Remove) / })[0]
      ).toHaveAccessibleName("Remove 🎉");
    });

    it("offers quick reactions in the row's hover toolbar", async () => {
      const p = post({ body: "Hello there" });
      stub(feed(p));
      renderPage();
      answerReactions(p, [
        { emoji: "👍", reactedByMe: true, reactors: [reactor("person-me", "Me Myself")] },
      ]);
      const row = (await screen.findByText("Hello there")).closest("li")!;
      await userEvent.click(within(row).getByRole("button", { name: "React with 👍" }));
      await waitFor(() => expect(sent(reactionPath(p.id, "👍"), "PUT")).toBe(true));
      expect(
        await screen.findByRole("button", { name: "1 person reacted with 👍" })
      ).toBeInTheDocument();
    });

    it("opens the picker from the hover toolbar", async () => {
      const p = post({ body: "Hello there" });
      stub(feed(p));
      renderPage();
      answerReactions(p, []);
      const row = (await screen.findByText("Hello there")).closest("li")!;
      await userEvent.click(within(row).getByRole("button", { name: "Add reaction" }));
      await userEvent.click(await screen.findByRole("button", { name: "pick party" }));
      await waitFor(() => expect(sent(reactionPath(p.id, "🎉"), "PUT")).toBe(true));
    });

    it("closes the picker on Escape without reacting", async () => {
      stub(feed(post({ body: "Hello there" })));
      renderPage();
      const row = (await screen.findByText("Hello there")).closest("li")!;
      await userEvent.click(within(row).getByRole("button", { name: "Add reaction" }));
      expect(await screen.findByTestId("emoji-picker")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("emoji-picker")).toBeNull();
      expect(apiMock.mock.calls.some(([p]) => String(p).includes("/reactions/"))).toBe(false);
    });

    it("works on a reply in a thread, and on the thread's own message", async () => {
      const root = post({ body: "Root", reactions: [fire()] });
      const reply = post({ body: "A reply", parentPostId: root.id, reactions: [fire()] });
      stub({ thread: { root, replies: [reply] } });
      renderPage(`/groups/g1/threads/${root.id}`);
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "2 people reacted with 🔥" })).toHaveLength(2)
      );
      answerReactions(reply, [fire({ reactedByMe: true })]);
      const replyRow = screen.getByText("A reply").closest("li")!;
      await userEvent.click(
        within(replyRow).getByRole("button", { name: "2 people reacted with 🔥" })
      );
      await waitFor(() => expect(sent(reactionPath(reply.id, FIRE), "PUT")).toBe(true));
    });

    it("lets you only look when you cannot react", async () => {
      const p = post({ body: "Hello there", reactions: [fire()] });
      stub({ ...feed(p), group: group({ canReact: false }) });
      renderPage();
      const pill = await screen.findByRole("button", { name: "2 people reacted with 🔥" });
      expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
      expect(screen.queryByRole("button", { name: "React with 👍" })).toBeNull();
      await userEvent.click(pill);
      expect(apiMock.mock.calls.some(([path]) => String(path).includes("/reactions/"))).toBe(false);
    });

    it("shows a message's formatting, and no link for an unsafe address", async () => {
      stub({
        pages: [
          {
            posts: [
              post({
                body: "**Bold** _soft_ ++under++ ~~gone~~ [site](https://example.org) [bad](javascript:alert)\n- one\n- two\n1. first",
              }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      expect((await screen.findByText("Bold")).tagName).toBe("STRONG");
      expect(screen.getByText("soft").tagName).toBe("EM");
      expect(screen.getByText("under").tagName).toBe("U");
      expect(screen.getByText("gone").tagName).toBe("S");
      expect(screen.getByRole("link", { name: "site" })).toHaveAttribute(
        "href",
        "https://example.org"
      );
      expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
      expect(screen.getByText("bad")).toBeInTheDocument();
      expect(screen.getByText("one").closest("ul")).toBeInTheDocument();
      expect(screen.getByText("first").closest("ol")).toBeInTheDocument();
    });

    it("shows a message of only emoji large, and a mixed one normally", async () => {
      stub({
        pages: [
          {
            posts: [
              post({ body: "hello 🎉", createdAt: "2026-10-09T10:01:00.000Z" }),
              post({ body: "🎉 🙏", createdAt: "2026-10-09T10:00:00.000Z" }),
            ],
            nextCursor: null,
          },
        ],
      });
      renderPage();
      expect((await screen.findByText("🎉 🙏")).closest("div")!.className).toContain("text-3xl");
      expect(screen.getByText("hello 🎉").closest("div")!.className).not.toContain("text-3xl");
    });

    it("puts an emoji from the message bar's picker at the caret", async () => {
      stub();
      renderPage();
      const bar = await screen.findByRole("textbox", { name: "Message" });
      await typeInBar(bar, "hi  there");
      // The caret between the two spaces: the paragraph starts at 1, so after "hi ".
      act(() => void (bar as HTMLElement & { editor: Editor }).editor.commands.setTextSelection(4));
      await userEvent.click(screen.getByRole("button", { name: "Add emoji" }));
      await userEvent.click(await screen.findByRole("button", { name: "pick party" }));
      expect(barText(bar)).toBe("hi 🎉 there");
    });

    describe("on a touch screen", () => {
      const press = (el: Element) =>
        fireEvent.pointerDown(el, { pointerType: "touch", clientX: 5, clientY: 5 });

      it("offers a row of quick reactions in the long-press drawer", async () => {
        const p = post({ body: "Hello there" });
        stub(feed(p));
        renderPage();
        answerReactions(p, []);
        press((await screen.findByText("Hello there")).closest("li")!);
        const drawer = within(await screen.findByRole("dialog", { name: "Message" }));
        expect(drawer.getAllByRole("button", { name: /^React with / })).toHaveLength(6);

        await userEvent.click(drawer.getByRole("button", { name: "React with ❤️" }));
        await waitFor(() => expect(sent(reactionPath(p.id, "❤️"), "PUT")).toBe(true));
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
      });

      it("opens the picker from the drawer's more button", async () => {
        const p = post({ body: "Hello there" });
        stub(feed(p));
        renderPage();
        answerReactions(p, []);
        press((await screen.findByText("Hello there")).closest("li")!);
        const drawer = within(await screen.findByRole("dialog", { name: "Message" }));
        await userEvent.click(drawer.getByRole("button", { name: "More reactions" }));
        await userEvent.click(await screen.findByRole("button", { name: "pick party" }));
        await waitFor(() => expect(sent(reactionPath(p.id, "🎉"), "PUT")).toBe(true));
      });

      it("lists who reacted, a tab per emoji, from the drawer", async () => {
        stub(
          feed(
            post({
              body: "Hello there",
              reactions: [
                fire(),
                { emoji: "👍", reactedByMe: false, reactors: [reactor("person-ann", "Ann Lee")] },
              ],
            })
          )
        );
        renderPage();
        press((await screen.findByText("Hello there")).closest("li")!);
        const drawer = within(await screen.findByRole("dialog", { name: "Message" }));
        await userEvent.click(drawer.getByRole("button", { name: "View reactions" }));

        const sheet = within(await screen.findByRole("dialog", { name: "Reactions" }));
        expect(sheet.getByRole("tab", { name: "All 3" })).toHaveAttribute("aria-selected", "true");
        // Ann reacted twice, so she is one line with both emoji.
        expect(sheet.getAllByText("Ann Lee")).toHaveLength(1);
        expect(sheet.getByText("Bo Park")).toBeInTheDocument();

        await userEvent.click(sheet.getByRole("tab", { name: "👍 1" }));
        expect(sheet.getByText("Ann Lee")).toBeInTheDocument();
        expect(sheet.queryByText("Bo Park")).toBeNull();
      });

      it("opens that list on a long press of a pill, without toggling it or opening the drawer", async () => {
        const p = post({ body: "Hello there", reactions: [fire()] });
        stub(feed(p));
        renderPage();
        const pill = await screen.findByRole("button", { name: "2 people reacted with 🔥" });
        press(pill);
        expect(await screen.findByRole("dialog", { name: "Reactions" })).toBeInTheDocument();
        fireEvent.pointerUp(pill, { pointerType: "touch" });
        fireEvent.click(pill);
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
        expect(apiMock.mock.calls.some(([path]) => String(path).includes("/reactions/"))).toBe(
          false
        );
      });

      it("still toggles on a quick tap of a pill", async () => {
        const p = post({ body: "Hello there", reactions: [fire()] });
        stub(feed(p));
        renderPage();
        answerReactions(p, [fire({ reactedByMe: true })]);
        const pill = await screen.findByRole("button", { name: "2 people reacted with 🔥" });
        press(pill);
        fireEvent.pointerUp(pill, { pointerType: "touch" });
        await userEvent.click(pill);
        await waitFor(() => expect(sent(reactionPath(p.id, FIRE), "PUT")).toBe(true));
        expect(screen.queryByRole("dialog", { name: "Reactions" })).toBeNull();
      });
    });
  });

  describe("event sharing, the event page, and tab URLs", () => {
    const TOKEN = "01JSHARETOKEN0000000000000";
    const soon = () => localDayIso(new Date(Date.now() + 7 * 86_400_000));
    const ev = (
      eventOverrides: Partial<NonNullable<GroupPostDto["event"]>> = {},
      postOverrides: Partial<GroupPostDto> = {}
    ) =>
      post({
        id: "e1",
        kind: "EVENT",
        body: null,
        ...postOverrides,
        event: {
          title: "Parish Picnic",
          description: "Bring a dish",
          eventDate: soon(),
          startTime: "12:00",
          endTime: "15:00",
          location: "The Hall",
          rsvpCounts: { yes: 2, no: 0, maybe: 1, publicAttending: 0 },
          myRsvp: null,
          shareToken: TOKEN,
          publicRsvpEnabled: false,
          ...eventOverrides,
        },
      });

    const publicRow = (overrides: Partial<PublicEventRsvpDto> = {}): PublicEventRsvpDto => ({
      id: "pr1",
      firstName: "Sam",
      lastName: "Stranger",
      guestCount: 2,
      createdAt: "2026-10-09T10:00:00.000Z",
      email: null,
      ...overrides,
    });

    function stubEvent({
      event = ev(),
      g = group(),
      replies = [] as GroupPostDto[],
      roster = {
        rsvps: [] as GroupEventRsvpDto[],
        publicRsvps: [] as PublicEventRsvpDto[],
        canManagePublicRsvps: false,
      },
      groupStatus = 200,
      postStatus = 200,
    } = {}) {
      apiMock.mockImplementation((path: string) => {
        if (path === "/groups/g1")
          return groupStatus === 200
            ? Promise.resolve(g)
            : Promise.reject(new ApiError(groupStatus, "Group not found"));
        if (path === "/groups/g1/live") return Promise.resolve({ activityAt: "x", typing: [] });
        if (path === `/groups/g1/posts/${event.id}`)
          return postStatus === 200
            ? Promise.resolve(event)
            : Promise.reject(new ApiError(postStatus, "Nope"));
        if (path === `/groups/g1/posts/${event.id}/replies`) return Promise.resolve({ replies });
        if (path === `/groups/g1/posts/${event.id}/rsvps`) return Promise.resolve(roster);
        if (path === "/groups/g1/events") return Promise.resolve({ events: [event] });
        if (path === "/groups/g1/posts")
          return Promise.resolve({ posts: [event], nextCursor: null });
        return Promise.resolve(undefined);
      });
    }

    describe("tab URLs", () => {
      it("maps a path to its tab, and anything unknown to Messages", () => {
        expect(tabFromPathname("/groups/g1")).toBe("messages");
        expect(tabFromPathname("/groups/g1/files")).toBe("files");
        expect(tabFromPathname("/groups/g1/events")).toBe("events");
        expect(tabFromPathname("/groups/g1/bogus")).toBe("messages");
        expect(groupTabPath("g1", "events")).toBe("/groups/g1/events");
      });

      it("opens the tab the URL names", async () => {
        stubEvent();
        renderPage("/groups/g1/events");
        expect(await screen.findByRole("button", { name: "Events" })).toHaveAttribute(
          "aria-current",
          "page"
        );
        expect(await screen.findByRole("heading", { name: /Upcoming/ })).toBeInTheDocument();
      });

      it("replaces rather than pushes when switching tabs", async () => {
        stub();
        renderPage();
        await userEvent.click(await screen.findByRole("button", { name: "Files" }));
        expect(where()).toBe("/groups/g1/files");
        expect(screen.getByTestId("where")).toHaveAttribute("data-nav-type", "REPLACE");
      });
    });

    describe("Allow Public RSVP", () => {
      const WARNING = /Anyone on the internet/;

      it("is off in the composer, warns while ticked, and posts the flag", async () => {
        stub();
        renderPage();
        await userEvent.click(await screen.findByRole("button", { name: "Add to this message" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Event…" }));
        const dialog = await screen.findByRole("dialog", { name: "New event" });
        const box = within(dialog).getByRole("checkbox", { name: "Allow Public RSVP" });
        expect(box).not.toBeChecked();
        expect(within(dialog).queryByText(WARNING)).toBeNull();

        await userEvent.click(box);
        expect(within(dialog).getByText(WARNING)).toBeInTheDocument();
        await userEvent.click(box);
        expect(within(dialog).queryByText(WARNING)).toBeNull();
        await userEvent.click(box);

        await userEvent.type(within(dialog).getByLabelText("Event title"), "Picnic");
        fireEvent.change(within(dialog).getByLabelText("Date"), {
          target: { value: "2030-06-01" },
        });
        await userEvent.click(within(dialog).getByRole("button", { name: "Post event" }));
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            "/groups/g1/posts",
            expect.objectContaining({
              method: "POST",
              body: expect.objectContaining({
                event: expect.objectContaining({ publicRsvpEnabled: true }),
              }),
            })
          )
        );
      });

      it("shows the event's own setting when editing, with the warning, and saves a change", async () => {
        stubEvent({
          event: ev({ publicRsvpEnabled: true }, { authorPersonId: "person-me", canEdit: true }),
        });
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
        const box = await screen.findByRole("checkbox", { name: "Allow Public RSVP" });
        expect(box).toBeChecked();
        expect(screen.getByText(WARNING)).toBeInTheDocument();

        await userEvent.click(box);
        expect(screen.queryByText(WARNING)).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith(
            "/groups/g1/posts/e1",
            expect.objectContaining({
              method: "PATCH",
              body: expect.objectContaining({
                event: expect.objectContaining({ publicRsvpEnabled: false }),
              }),
            })
          )
        );
      });
    });

    describe("public RSVPs in the roster", () => {
      it("lists them after Going, badged, with guests, counted in the total, address hidden", async () => {
        stubEvent({
          event: ev({ rsvpCounts: { yes: 1, no: 0, maybe: 0, publicAttending: 3 } }),
          roster: {
            rsvps: [
              {
                appUserId: "user-bo",
                personId: "person-bo",
                name: "Bo Park",
                thumbUrl: null,
                response: "YES",
                guestCount: 1,
              },
            ],
            publicRsvps: [publicRow({ email: null })],
            canManagePublicRsvps: false,
          },
        });
        renderPage();
        const summary = await screen.findByRole("button", {
          name: "1 going · 0 maybe · 0 not going · 3 via link",
        });
        await userEvent.click(summary);
        const dialog = await screen.findByRole("dialog", { name: "Who's RSVP'd" });
        expect(
          await within(dialog).findByText(
            "5 total attending (1 member + 1 guest + 3 via the public link)"
          )
        ).toBeInTheDocument();
        expect(within(dialog).getByText("From the public link (1)")).toBeInTheDocument();
        expect(within(dialog).getByText("Public RSVP")).toBeInTheDocument();
        expect(within(dialog).getByText("+2 guests")).toBeInTheDocument();
        expect(within(dialog).queryByRole("link", { name: /@/ })).toBeNull();
        expect(within(dialog).queryByRole("button", { name: /Remove/ })).toBeNull();
      });

      it("shows the organizer the address and lets them remove one", async () => {
        stubEvent({
          roster: {
            rsvps: [],
            publicRsvps: [publicRow({ email: "sam@example.com" })],
            canManagePublicRsvps: true,
          },
        });
        renderPage();
        await userEvent.click(await screen.findByRole("button", { name: /2 going/ }));
        const dialog = await screen.findByRole("dialog", { name: "Who's RSVP'd" });
        expect(
          await within(dialog).findByRole("link", { name: "sam@example.com" })
        ).toBeInTheDocument();
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Remove Sam Stranger's RSVP" })
        );
        await userEvent.click(await screen.findByRole("button", { name: "Remove it" }));
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e1/public-rsvps/pr1", {
            method: "DELETE",
          })
        );
      });
    });

    describe("share actions", () => {
      it("offers Copy link, QR code and PDF flyer in the menu, and copies the share URL", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText },
        });
        stubEvent();
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        expect(screen.getByRole("menuitem", { name: "QR code" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "PDF flyer" })).toBeInTheDocument();
        await userEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/e/${TOKEN}`);
      });

      it("offers none of them on a cancelled event", async () => {
        stubEvent({
          event: ev(
            {},
            { deletedAt: "2026-10-09T12:00:00.000Z", deletedBySelf: true, canRestore: true }
          ),
        });
        renderPage();
        await screen.findByText("Cancelled");
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "QR code" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "PDF flyer" })).toBeNull();
      });

      it("puts them in plain sight on the Events tab", async () => {
        stubEvent();
        renderPage("/groups/g1/events");
        await screen.findByRole("heading", { name: "Parish Picnic" });
        expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "QR code" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "PDF flyer" })).toBeInTheDocument();
      });
    });

    describe("ways into the event page", () => {
      it("opens it from the card's header in the feed, but not from its RSVP buttons", async () => {
        stubEvent();
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("button", { name: "Going" }));
        expect(where()).toBe("/groups/g1");
        await userEvent.click(screen.getByRole("link", { name: /Parish Picnic/ }));
        expect(where()).toBe("/groups/g1/events/e1");
        expect(
          await screen.findByRole("heading", { level: 1, name: "Parish Picnic" })
        ).toBeInTheDocument();
      });

      it("opens it from the card's header on the Events tab", async () => {
        stubEvent();
        renderPage("/groups/g1/events");
        await userEvent.click(await screen.findByRole("link", { name: /Parish Picnic/ }));
        expect(where()).toBe("/groups/g1/events/e1");
      });

      it("opens it from Reply on an event, with the composer focused", async () => {
        stubEvent();
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
        expect(where()).toBe("/groups/g1/events/e1");
        const bar = await screen.findByRole("textbox", { name: "Reply" });
        await waitFor(() => expect(bar).toHaveFocus());
      });

      it("leaves for the Messages tab by popping history when opened from the feed", async () => {
        stubEvent();
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("link", { name: /Parish Picnic/ }));
        await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
        await waitFor(() => expect(where()).toBe("/groups/g1"));
        expect(navType()).toBe("POP");
      });

      it("leaves for the Events tab by popping history when opened from it", async () => {
        stubEvent();
        renderPage("/groups/g1/events");
        await userEvent.click(await screen.findByRole("link", { name: /Parish Picnic/ }));
        await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
        await waitFor(() => expect(where()).toBe("/groups/g1/events"));
        expect(navType()).toBe("POP");
      });

      it("leaves for the Messages tab after Reply from the feed", async () => {
        stubEvent();
        renderPage();
        await screen.findByRole("heading", { name: "Parish Picnic" });
        await userEvent.click(screen.getByRole("button", { name: "Actions for this post" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
        await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
        await waitFor(() => expect(where()).toBe("/groups/g1"));
        expect(navType()).toBe("POP");
      });

      it("leaves for the Events tab by replacing when opened directly", async () => {
        stubEvent();
        renderPage("/groups/g1/events/e1");
        await userEvent.click(await screen.findByRole("link", { name: "Youth Group" }));
        await waitFor(() => expect(where()).toBe("/groups/g1/events"));
        expect(navType()).toBe("REPLACE");
      });

      it("sends an old thread link for an event on to the event page", async () => {
        stubEvent();
        renderPage("/groups/g1/threads/e1");
        await waitFor(() => expect(where()).toBe("/groups/g1/events/e1"));
        expect(
          await screen.findByRole("heading", { level: 1, name: "Parish Picnic" })
        ).toBeInTheDocument();
      });
    });

    describe("the event page", () => {
      it("shows the hero, RSVP as the main action, the roster, the share row and the discussion", async () => {
        stubEvent({
          replies: [post({ id: "r1", parentPostId: "e1", body: "Count me in" })],
          roster: {
            rsvps: [
              {
                appUserId: "user-bo",
                personId: "person-bo",
                name: "Bo Park",
                thumbUrl: null,
                response: "YES",
                guestCount: 0,
              },
            ],
            publicRsvps: [],
            canManagePublicRsvps: false,
          },
        });
        renderPage("/groups/g1/events/e1");
        expect(
          await screen.findByRole("heading", { level: 1, name: "Parish Picnic" })
        ).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "The Hall" })).toHaveAttribute(
          "href",
          expect.stringContaining("google.com/maps/search")
        );
        expect(screen.getByText("Bring a dish")).toBeInTheDocument();

        const rsvp = screen.getByRole("group", { name: "Your RSVP" });
        await userEvent.click(within(rsvp).getByRole("button", { name: "Going" }));
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e1/rsvp", {
            method: "PUT",
            body: { response: "YES", guestCount: 0 },
          })
        );

        for (const name of ["Copy link", "QR code", "PDF flyer"]) {
          expect(screen.getByRole("button", { name })).toBeInTheDocument();
        }
        expect(await screen.findByText("Count me in")).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /2 going · 1 maybe/ }));
        expect(await screen.findByRole("dialog", { name: "Who's RSVP'd" })).toBeInTheDocument();
      });

      it("shows organizer controls only to whoever may use them", async () => {
        stubEvent({ event: ev({}, { canEdit: true, canDelete: true }) });
        const { unmount } = renderPage("/groups/g1/events/e1");
        expect(await screen.findByRole("button", { name: "Edit event" })).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Cancel event" }));
        await userEvent.click(await screen.findByRole("button", { name: "Cancel it" }));
        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/e1", { method: "DELETE" })
        );
        unmount();

        stubEvent();
        renderPage("/groups/g1/events/e1");
        await screen.findByRole("heading", { level: 1, name: "Parish Picnic" });
        expect(screen.queryByRole("button", { name: "Edit event" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Cancel event" })).toBeNull();
      });

      it("hides the RSVP panel and the share row for a cancelled event", async () => {
        stubEvent({
          event: ev({}, { deletedAt: "2026-10-09T12:00:00.000Z", deletedBySelf: true }),
        });
        renderPage("/groups/g1/events/e1");
        expect(await screen.findByText("This event has been cancelled.")).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Your RSVP" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
      });

      it("shows a private group's non-member the group page's members-only card", async () => {
        stubEvent({
          g: group({ visibility: "PRIVATE", myRole: null, canReply: false, canPost: false }),
        });
        renderPage("/groups/g1/events/e1");
        expect(await screen.findByText("Members only")).toBeInTheDocument();
        expect(screen.queryByText("Parish Picnic")).toBeNull();
      });

      it("says the group was not found when a secret group's non-member follows the link", async () => {
        stubEvent({ groupStatus: 404 });
        renderPage("/groups/g1/events/e1");
        expect(await screen.findByText("That group was not found.")).toBeInTheDocument();
      });

      it("does not focus the composer when opened directly", async () => {
        stubEvent();
        renderPage("/groups/g1/events/e1");
        const bar = await screen.findByRole("textbox", { name: "Reply" });
        expect(bar).not.toHaveFocus();
      });
    });
  });
});
