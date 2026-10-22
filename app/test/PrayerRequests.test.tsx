import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRAYER_REQUEST_REASON_MAX, type MeDto, type PrayerRequestDto } from "@shared";
import { ApiError } from "../src/lib/api";
import { PrayerRequests } from "../src/pages/PrayerRequests";
import { renderWithProviders } from "./utils";

/*
 * The API and the contexts are stubbed: this file is about what the page shows
 * to whom, which is the half of the visibility rule that lives in the browser.
 * The other half -- what the server is willing to send at all -- is
 * api/test/api.prayer-requests.test.ts.
 */
const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const meState = {
  personId: "person-me" as string | null,
  canApprove: false,
};

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: {
      appUser: { id: "user-me", personId: meState.personId },
      person: meState.personId
        ? { id: meState.personId, firstName: "Me", lastName: "Myself" }
        : null,
    } as unknown as MeDto,
    canApprovePrayerRequests: meState.canApprove,
    organizationId: "org-1",
  }),
}));

function request(overrides: Partial<PrayerRequestDto> = {}): PrayerRequestDto {
  return {
    id: "pr-1",
    title: "For Fr. John",
    body: "He is unwell.",
    status: "APPROVED",
    authorPersonId: "person-other",
    authorFirstName: "Boris",
    authorLastName: "Ivanov",
    authorThumbUrl: null,
    submittedAt: "2026-09-01T10:00:00.000Z",
    postedAt: "2026-09-02T10:00:00.000Z",
    decidedAt: "2026-09-02T10:00:00.000Z",
    decidedByName: null,
    rejectionReason: null,
    images: [],
    canDecide: false,
    canDelete: false,
    canReact: true,
    isMine: false,
    reactions: [],
    ...overrides,
  };
}

/** Answers `/prayer-requests` and `/prayer-requests/pending` from two lists. */
function stubFeed(feed: PrayerRequestDto[], queue: PrayerRequestDto[] = []) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/prayer-requests") return Promise.resolve({ prayerRequests: feed });
    if (path === "/prayer-requests/pending") return Promise.resolve({ prayerRequests: queue });
    if (path === "/prayer-requests/live") return Promise.resolve({ activityAt: "stamp-1" });
    // A reaction write answers with the request; tests that care override this.
    const reacted = feed.find((r) => path.startsWith(`/prayer-requests/${r.id}/reactions/`));
    if (reacted) return Promise.resolve(reacted);
    return Promise.resolve({});
  });
}

describe("PrayerRequests", () => {
  beforeEach(() => {
    apiMock.mockReset();
    meState.personId = "person-me";
    meState.canApprove = false;
  });

  it("lists the posted requests with author and relative time", async () => {
    stubFeed([request()]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText("For Fr. John")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Boris Ivanov" })).toHaveAttribute(
      "href",
      "/people/person-other"
    );
    expect(screen.getByText(/1 request from the last month/)).toBeInTheDocument();
  });

  /*
   * The author's photo and name both open their record. The photo is
   * `aria-hidden` and out of the tab order on purpose: it is the same link to
   * the same place as the name beside it, so announcing it twice would give
   * anyone driving the page by name two identical targets to choose between.
   */
  it("links the author's photo and name to their record", async () => {
    stubFeed([request({ authorThumbUrl: "/photos/org-1/person/boris/thumb" })]);
    renderWithProviders(<PrayerRequests />);

    await screen.findByText("For Fr. John");
    const photo = screen.getByRole("presentation", { hidden: true });
    expect(photo).toHaveAttribute("src", "/photos/org-1/person/boris/thumb");

    const photoLink = photo.closest("a");
    expect(photoLink).toHaveAttribute("href", "/people/person-other");
    expect(photoLink).toHaveAttribute("aria-hidden", "true");
    expect(photoLink).toHaveAttribute("tabindex", "-1");

    // The one link the page offers by name, so it is the only tab stop.
    expect(screen.getAllByRole("link", { name: "Boris Ivanov" })).toHaveLength(1);
  });

  it("shows the author's initials when they have no photo", async () => {
    stubFeed([request()]);
    renderWithProviders(<PrayerRequests />);

    await screen.findByText("For Fr. John");
    expect(screen.getByText("BI")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Boris Ivanov" })).toHaveAttribute(
      "href",
      "/people/person-other"
    );
  });

  it("puts the caller's own request under Yours with its status", async () => {
    stubFeed([
      request({
        id: "pr-mine",
        title: "For my mother",
        status: "PENDING",
        postedAt: null,
        decidedAt: null,
        authorPersonId: "person-me",
        isMine: true,
        canDelete: true,
      }),
    ]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText("Yours, not yet posted")).toBeInTheDocument();
    expect(screen.getByText("Waiting for review")).toBeInTheDocument();
    // Pending, so it is not one of the parish's posted requests.
    expect(screen.getByText(/0 requests from the last month/)).toBeInTheDocument();
  });

  it("shows a declined request's reason to its author", async () => {
    stubFeed([
      request({
        status: "REJECTED",
        postedAt: null,
        isMine: true,
        canDelete: true,
        decidedByName: "Dimitar Petrov",
        rejectionReason: "The family asked us to wait.",
      }),
    ]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText("Declined")).toBeInTheDocument();
    expect(screen.getByText(/Declined by:/)).toBeInTheDocument();
    expect(screen.getByText(/Dimitar Petrov/)).toBeInTheDocument();
    expect(screen.getByText(/Decline Reason:/)).toBeInTheDocument();
    expect(screen.getByText(/The family asked us to wait/)).toBeInTheDocument();
  });

  /*
   * The two halves are independent: a reviewer need not give a reason, and the
   * decider's record can be deleted out from under a standing decision, which
   * nulls decided_by_person_id rather than cascading (see V8).
   */
  it("shows who declined a request even with no reason given", async () => {
    stubFeed([
      request({
        status: "REJECTED",
        postedAt: null,
        isMine: true,
        canDelete: true,
        decidedByName: "Dimitar Petrov",
        rejectionReason: null,
      }),
    ]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText(/Declined by:/)).toBeInTheDocument();
    expect(screen.getByText(/Dimitar Petrov/)).toBeInTheDocument();
    expect(screen.queryByText(/Decline Reason:/)).not.toBeInTheDocument();
  });

  it("shows the reason with no name when the reviewer's record is gone", async () => {
    stubFeed([
      request({
        status: "REJECTED",
        postedAt: null,
        isMine: true,
        canDelete: true,
        decidedByName: null,
        rejectionReason: "The family asked us to wait.",
      }),
    ]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText(/The family asked us to wait/)).toBeInTheDocument();
    expect(screen.queryByText(/Declined by:/)).not.toBeInTheDocument();
  });

  it("says so when there is nothing posted", async () => {
    stubFeed([]);
    renderWithProviders(<PrayerRequests />);
    expect(await screen.findByText("No prayer requests this month")).toBeInTheDocument();
  });

  it("hides the compose button from someone with no directory record", async () => {
    meState.personId = null;
    stubFeed([]);
    renderWithProviders(<PrayerRequests />);

    await screen.findByText(/directory record is missing/i);
    expect(screen.queryByRole("button", { name: "Ask for prayers" })).not.toBeInTheDocument();
  });

  describe("the review queue", () => {
    it("is absent for a plain member, and not even fetched", async () => {
      stubFeed([request()], [request({ id: "pr-queue", canDecide: true })]);
      renderWithProviders(<PrayerRequests />);

      await screen.findByText("For Fr. John");
      expect(screen.queryByRole("button", { name: "Post it" })).not.toBeInTheDocument();
      expect(apiMock).not.toHaveBeenCalledWith("/prayer-requests/pending", expect.anything());
    });

    it("shows a reviewer what is waiting, with both decisions", async () => {
      meState.canApprove = true;
      stubFeed(
        [],
        [
          request({
            id: "pr-queue",
            title: "For safe travels",
            status: "PENDING",
            postedAt: null,
            canDecide: true,
          }),
        ]
      );
      renderWithProviders(<PrayerRequests />);

      expect(await screen.findByText(/One request is waiting for review/)).toBeInTheDocument();
      expect(screen.getByText("For safe travels")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Post it" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    });

    it("credits the author here too, so a reviewer can look them up", async () => {
      meState.canApprove = true;
      stubFeed(
        [],
        [
          request({
            id: "pr-queue",
            status: "PENDING",
            postedAt: null,
            canDecide: true,
            authorThumbUrl: "/photos/org-1/person/boris/thumb",
          }),
        ]
      );
      renderWithProviders(<PrayerRequests />);

      await screen.findByText("For Fr. John");
      expect(screen.getByRole("link", { name: "Boris Ivanov" })).toHaveAttribute(
        "href",
        "/people/person-other"
      );
      expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
        "src",
        "/photos/org-1/person/boris/thumb"
      );
      // The avatar column must not have swallowed the decisions.
      expect(screen.getByRole("button", { name: "Post it" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    });

    it("approves through the API and refreshes", async () => {
      meState.canApprove = true;
      stubFeed(
        [],
        [request({ id: "pr-queue", status: "PENDING", postedAt: null, canDecide: true })]
      );
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(await screen.findByRole("button", { name: "Post it" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/prayer-requests/pr-queue/approve", {
          method: "POST",
        })
      );
    });

    it("shows only rows it can actually act on", async () => {
      // The banner filters on canDecide rather than trusting the endpoint, so a
      // row the server would refuse never appears with buttons that 403.
      meState.canApprove = true;
      stubFeed(
        [],
        [
          request({ id: "pr-a", status: "PENDING", postedAt: null, canDecide: true }),
          request({ id: "pr-b", status: "PENDING", postedAt: null, canDecide: false }),
        ]
      );
      renderWithProviders(<PrayerRequests />);

      expect(await screen.findByText(/One request is waiting for review/)).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Post it" })).toHaveLength(1);
    });

    /*
     * Declining goes through a dialog, because it is the one decision here that
     * takes something away from a member: the author is told "Declined"
     * either way, so the message is the only chance to say why. These pin that
     * the click no longer decides anything on its own, and what ends up in the
     * body when it does.
     */
    describe("declining", () => {
      /** A reviewer looking at one pending request, ready to decline it. */
      function renderQueue() {
        meState.canApprove = true;
        stubFeed(
          [],
          [request({ id: "pr-queue", status: "PENDING", postedAt: null, canDecide: true })]
        );
        renderWithProviders(<PrayerRequests />);
      }

      const declineButton = () => screen.findByRole("button", { name: "Decline" });
      const reasonBox = () => screen.getByLabelText(/Anything you want them to know/);

      it("asks for a reason before declining, instead of declining outright", async () => {
        renderQueue();
        await userEvent.click(await declineButton());

        expect(screen.getByRole("dialog", { name: /Decline this request/ })).toBeInTheDocument();
        expect(reasonBox()).toBeInTheDocument();
        // The whole point: the click decided nothing by itself.
        expect(apiMock).not.toHaveBeenCalledWith(
          "/prayer-requests/pr-queue/reject",
          expect.anything()
        );
      });

      it("declines with the reason the reviewer typed", async () => {
        renderQueue();
        await userEvent.click(await declineButton());
        await userEvent.type(reasonBox(), "The family asked us to wait.");
        await userEvent.click(screen.getByRole("button", { name: "Decline it" }));

        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith("/prayer-requests/pr-queue/reject", {
            method: "POST",
            body: { reason: "The family asked us to wait." },
          })
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      });

      it("declines with no reason when there is nothing to say", async () => {
        // A reviewer does not have to justify declining something, so an empty
        // box is a null rather than an empty string or a blocked submit.
        renderQueue();
        await userEvent.click(await declineButton());
        await userEvent.click(screen.getByRole("button", { name: "Decline it" }));

        await waitFor(() =>
          expect(apiMock).toHaveBeenCalledWith("/prayer-requests/pr-queue/reject", {
            method: "POST",
            body: { reason: null },
          })
        );
      });

      it("leaves the request in the queue when the reviewer backs out", async () => {
        renderQueue();
        await userEvent.click(await declineButton());
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(apiMock).not.toHaveBeenCalledWith(
          "/prayer-requests/pr-queue/reject",
          expect.anything()
        );
        expect(await declineButton()).toBeInTheDocument();
      });

      it("caps the reason at the shared maximum", async () => {
        // Fails if the number is ever re-inlined here or in the schema.
        renderQueue();
        await userEvent.click(await declineButton());
        expect(reasonBox()).toHaveAttribute("maxLength", String(PRAYER_REQUEST_REASON_MAX));
      });
    });
  });

  describe("composing", () => {
    it("posts the title and body, and will not submit an empty form", async () => {
      stubFeed([]);
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(await screen.findByRole("button", { name: "Ask for prayers" }));
      expect(screen.getByRole("button", { name: "Send for review" })).toBeDisabled();

      await userEvent.type(screen.getByLabelText("Title"), "For my mother");
      await userEvent.type(
        screen.getByLabelText(/What would you like prayed for/),
        "Surgery Thursday."
      );
      await userEvent.click(screen.getByRole("button", { name: "Send for review" }));

      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/prayer-requests", {
          method: "POST",
          body: { title: "For my mother", body: "Surgery Thursday.", images: [] },
        })
      );
    });

    it("tells a member that a reviewer sees it first", async () => {
      stubFeed([]);
      renderWithProviders(<PrayerRequests />);
      await userEvent.click(await screen.findByRole("button", { name: "Ask for prayers" }));
      expect(screen.getByText(/A reviewer reads this before it is posted/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send for review" })).toBeInTheDocument();
    });

    it("tells a reviewer theirs goes up straight away", async () => {
      // Promising review to somebody who is the reviewer would be a lie, and
      // "Send for review" would be a button that reviews nothing.
      meState.canApprove = true;
      stubFeed([]);
      renderWithProviders(<PrayerRequests />);
      await userEvent.click(await screen.findByRole("button", { name: "Ask for prayers" }));
      expect(screen.getByText(/goes up straight away/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Post it" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send for review" })).not.toBeInTheDocument();
    });
  });

  describe("attachments", () => {
    it("renders a thumbnail per image, opening the full size", async () => {
      stubFeed([
        request({
          images: [
            {
              id: "img-1",
              thumbUrl: "/photos/a/thumb",
              fullUrl: "/photos/a/full",
              width: 800,
              height: 600,
            },
            {
              id: "img-2",
              thumbUrl: "/photos/b/thumb",
              fullUrl: "/photos/b/full",
              width: 640,
              height: 640,
            },
          ],
        }),
      ]);
      renderWithProviders(<PrayerRequests />);

      const first = await screen.findByRole("button", {
        name: /View photo 1 of 2 for For Fr. John/,
      });
      expect(screen.getByRole("button", { name: /View photo 2 of 2/ })).toBeInTheDocument();

      await userEvent.click(first);
      expect(screen.getByRole("dialog", { name: "For Fr. John" })).toBeInTheDocument();
    });
  });

  describe("staying live", () => {
    /*
     * The page polls a stamp while it is open, as an open group does, so the
     * refresh button and its "Updated" label are gone.
     */
    it("has no manual refresh button or 'Updated' text any more", async () => {
      stubFeed([request()]);
      renderWithProviders(<PrayerRequests />);
      await screen.findByText("For Fr. John");
      expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
    });

    it("refetches the page when the stamp moves, and not before", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let stamp = "stamp-1";
        let title = "For Fr. John";
        apiMock.mockImplementation((path: string) => {
          if (path === "/prayer-requests/live") return Promise.resolve({ activityAt: stamp });
          if (path === "/prayer-requests") {
            return Promise.resolve({ prayerRequests: [request({ title })] });
          }
          return Promise.resolve({ prayerRequests: [] });
        });
        renderWithProviders(<PrayerRequests />);
        await screen.findByText("For Fr. John");
        const feedCalls = () =>
          apiMock.mock.calls.filter(([path]) => path === "/prayer-requests").length;
        const before = feedCalls();

        // The same stamp again: nothing changed, so nothing is refetched.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(feedCalls()).toBe(before);

        stamp = "stamp-2";
        title = "For the Smith family";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(await screen.findByText("For the Smith family")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ages the posted times on the cards too", async () => {
      // Both clocks on the page come from one `useNow`, so the cards and the
      // label can never disagree with each other.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        stubFeed([request({ postedAt: new Date().toISOString() })]);
        renderWithProviders(<PrayerRequests />);
        await screen.findByText("For Fr. John");
        // The byline is two nodes now -- the author's name is a link into their
        // record -- so this matches the time on its own. Matching the pair would
        // find nothing: getByText reads an element's own text, not its children's.
        expect(screen.getByRole("link", { name: "Boris Ivanov" })).toBeInTheDocument();
        expect(screen.getByText(/^· Just now$/)).toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        });

        expect(screen.getByText(/^· 2 hours ago$/)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reactions", () => {
    const reactor = (personId: string, name: string) => ({
      appUserId: `user-${personId}`,
      personId,
      name,
      thumbUrl: null,
    });
    const pray = (
      overrides: Partial<PrayerRequestDto["reactions"][number]> = {}
    ): PrayerRequestDto["reactions"][number] => ({
      emoji: "🙏",
      reactedByMe: false,
      reactors: [reactor("person-ann", "Ann Lee")],
      ...overrides,
    });

    it("offers to add one on a posted request, with none there yet", async () => {
      stubFeed([request()]);
      renderWithProviders(<PrayerRequests />);
      await screen.findByText("For Fr. John");
      expect(screen.getByRole("button", { name: "Add reaction" })).toBeInTheDocument();
    });

    it("offers nothing on a request that is not posted", async () => {
      stubFeed([
        request({
          id: "pr-mine",
          status: "PENDING",
          postedAt: null,
          isMine: true,
          canReact: false,
        }),
      ]);
      renderWithProviders(<PrayerRequests />);
      await screen.findByText("Waiting for review");
      expect(screen.queryByRole("button", { name: "Add reaction" })).not.toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Reactions" })).not.toBeInTheDocument();
    });

    it("shows the pills, and adds mine to someone else's at a tap", async () => {
      stubFeed([request({ reactions: [pray()] })]);
      const feedAnswer = apiMock.getMockImplementation()!;
      // The server answers with the request as it now stands.
      apiMock.mockImplementation((path: string, init?: unknown) =>
        path.includes("/reactions/")
          ? Promise.resolve(
              request({
                reactions: [
                  pray({
                    reactedByMe: true,
                    reactors: [reactor("person-ann", "Ann Lee"), reactor("person-me", "Me Myself")],
                  }),
                ],
              })
            )
          : feedAnswer(path, init)
      );
      renderWithProviders(<PrayerRequests />);

      const pill = await screen.findByRole("button", { name: "1 person reacted with 🙏" });
      expect(pill).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(pill);

      expect(apiMock).toHaveBeenCalledWith(
        `/prayer-requests/pr-1/reactions/${encodeURIComponent("🙏")}`,
        { method: "PUT" }
      );
      // Optimistically, before the server answers.
      expect(
        await screen.findByRole("button", { name: "2 people reacted with 🙏" })
      ).toHaveAttribute("aria-pressed", "true");
    });

    it("takes mine back when I tap a pill I am on", async () => {
      stubFeed([
        request({
          reactions: [pray({ reactedByMe: true, reactors: [reactor("person-me", "Me Myself")] })],
        }),
      ]);
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(
        await screen.findByRole("button", { name: "1 person reacted with 🙏" })
      );
      expect(apiMock).toHaveBeenCalledWith(
        `/prayer-requests/pr-1/reactions/${encodeURIComponent("🙏")}`,
        { method: "DELETE" }
      );
    });

    it("names who reacted when you hover a pill", async () => {
      stubFeed([
        request({
          reactions: [
            pray({
              reactedByMe: true,
              reactors: [reactor("person-ann", "Ann Lee"), reactor("person-me", "Me Myself")],
            }),
          ],
        }),
      ]);
      renderWithProviders(<PrayerRequests />);
      await userEvent.hover(
        await screen.findByRole("button", { name: "2 people reacted with 🙏" })
      );
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "You (click to remove) and Ann Lee"
      );
    });
  });

  describe("acting on a stale list", () => {
    /*
     * With nothing polling, a reviewer can sit on a decided queue indefinitely.
     * Tapping Post it on a row somebody else already handled is not their
     * mistake, so it reconciles rather than reporting a 409 at them.
     */
    function stubDecideConflict(status: number, message: string) {
      apiMock.mockImplementation((path: string) => {
        if (path === "/prayer-requests") return Promise.resolve({ prayerRequests: [] });
        if (path === "/prayer-requests/pending") {
          return Promise.resolve({
            prayerRequests: [
              request({ id: "pr-gone", status: "PENDING", postedAt: null, canDecide: true }),
            ],
          });
        }
        return Promise.reject(new ApiError(status, message));
      });
    }

    it("refreshes instead of showing the server's 409", async () => {
      meState.canApprove = true;
      stubDecideConflict(409, "That request has already been reviewed");
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(await screen.findByRole("button", { name: "Post it" }));

      await waitFor(() =>
        expect(screen.getByText(/Somebody else got there first/)).toBeInTheDocument()
      );
      // The server's wording would read as the reviewer having done something
      // wrong, so it must not be what they see.
      expect(screen.queryByText(/That request has already been reviewed/)).not.toBeInTheDocument();
    });

    it("reconciles a decline of a request somebody else already reviewed", async () => {
      meState.canApprove = true;
      stubDecideConflict(409, "That request has already been reviewed");
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
      await userEvent.click(screen.getByRole("button", { name: "Decline it" }));

      await waitFor(() =>
        expect(screen.getByText(/Somebody else got there first/)).toBeInTheDocument()
      );
      // The notice renders at the top of the page, behind the scrim, so the
      // dialog has to be gone for it to be readable at all.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("still reports a real failure", async () => {
      meState.canApprove = true;
      stubDecideConflict(500, "Something went wrong");
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(await screen.findByRole("button", { name: "Post it" }));

      await waitFor(() => expect(screen.getByText(/Something went wrong/)).toBeInTheDocument());
      expect(screen.queryByText(/Somebody else got there first/)).not.toBeInTheDocument();
    });
  });

  describe("removing", () => {
    it("confirms first, naming what goes with it", async () => {
      stubFeed([request({ isMine: true, canDelete: true })]);
      renderWithProviders(<PrayerRequests />);

      await userEvent.click(
        await screen.findByRole("button", { name: "Actions for For Fr. John" })
      );
      await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));

      expect(
        screen.getByRole("dialog", { name: /Remove this prayer request/ })
      ).toBeInTheDocument();
      expect(screen.getByText(/any photos attached to it will be deleted/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Remove it" }));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith("/prayer-requests/pr-1", { method: "DELETE" })
      );
    });

    it("shows the author's posted request once, in the parish list only", async () => {
      stubFeed([request({ isMine: true, canDelete: true })]);
      renderWithProviders(<PrayerRequests />);

      await screen.findByText("For Fr. John");
      expect(screen.getAllByText("For Fr. John")).toHaveLength(1);
      expect(screen.queryByText("Yours, not yet posted")).not.toBeInTheDocument();
    });

    it("offers no menu on a request that is not the caller's to remove", async () => {
      stubFeed([request()]);
      renderWithProviders(<PrayerRequests />);

      await screen.findByText("For Fr. John");
      expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
    });
  });
});
