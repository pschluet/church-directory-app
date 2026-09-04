import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeDto, PrayerRequestDto } from "@shared";
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
    me: { appUser: { personId: meState.personId } } as unknown as MeDto,
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
    authorName: "Boris Ivanov",
    submittedAt: "2026-09-01T10:00:00.000Z",
    postedAt: "2026-09-02T10:00:00.000Z",
    decidedAt: "2026-09-02T10:00:00.000Z",
    rejectionReason: null,
    images: [],
    canDecide: false,
    canDelete: false,
    isMine: false,
    ...overrides,
  };
}

/** Answers `/prayer-requests` and `/prayer-requests/pending` from two lists. */
function stubFeed(feed: PrayerRequestDto[], queue: PrayerRequestDto[] = []) {
  apiMock.mockImplementation((path: string) => {
    if (path === "/prayer-requests") return Promise.resolve({ prayerRequests: feed });
    if (path === "/prayer-requests/pending") return Promise.resolve({ prayerRequests: queue });
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
    expect(screen.getByText(/Boris Ivanov/)).toBeInTheDocument();
    expect(screen.getByText(/1 request from the last month/)).toBeInTheDocument();
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
        rejectionReason: "The family asked us to wait.",
      }),
    ]);
    renderWithProviders(<PrayerRequests />);

    expect(await screen.findByText("Not posted")).toBeInTheDocument();
    expect(screen.getByText(/The family asked us to wait/)).toBeInTheDocument();
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
