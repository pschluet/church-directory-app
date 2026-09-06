import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import { renderWithProviders } from "./utils";
import type { PersonSummaryDto } from "@shared";
import { Directory } from "../src/pages/Directory";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

function person(
  id: string,
  firstName: string,
  lastName: string,
  appUserId: string | null = null
): PersonSummaryDto {
  return {
    id,
    organizationId: "org-1",
    familyId: null,
    familyName: null,
    appUserId,
    firstName,
    lastName,
    email: null,
    phone: null,
    altPhone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    patronSaint: null,
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    canEdit: false,
  };
}

// Anna and John have no account, Boris does, which is what the filter sorts on.
const ANNA = person("anna-id", "Anna", "Ivanova");
const BORIS = person("boris-id", "Boris", "Petrov", "au-boris");
const SMITH = person("smith-id", "John", "Smith");

interface Query {
  q?: string;
  cursorId?: string;
  accountHoldersOnly?: string;
}

/** Lets a test read the query string the page has written. */
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

/** MemoryRouter keeps its own stack, so window.history cannot drive it. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back
    </button>
  );
}

function renderDirectory(path = "/") {
  return renderWithProviders(
    <>
      <Directory />
      <LocationProbe />
      <BackButton />
    </>,
    { initialEntries: [path] }
  );
}

/*
 * Cards are found by their heading, not by their text.
 *
 * A search marks the fragment it matched, which splits the name into text and
 * <mark> nodes -- and `getByText` compares against an element's *direct* text
 * children only, so "John Smith" stops matching the moment "smith" is what was
 * typed. The accessible name is computed across the descendants and is still
 * exactly the name, so it is the locator that survives the card being
 * decorated. The negatives go through the same door on purpose: a
 * `queryByText` that can no longer match would not fail, it would quietly
 * start passing for the wrong reason.
 */
const card = (name: string) => screen.findByRole("heading", { name });
const noCard = (name: string) => screen.queryByRole("heading", { name });

const box = () => screen.getByRole("searchbox", { name: /search the directory/i });
const filterBox = () => screen.getByRole("checkbox", { name: /show account holders only/i });
const calls = (path: string) => api.mock.calls.filter(([called]) => called === path);
/** The query the page sent on the nth request to `path`. */
const queryOf = (path: string, index: number): Query =>
  (calls(path)[index]?.[1] as { query?: Query } | undefined)?.query ?? {};

describe("Directory", () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation((path: string, options?: { query?: Query }) => {
      const holdersOnly = options?.query?.accountHoldersOnly === "true";
      if (path === "/directory") {
        return Promise.resolve({
          people: holdersOnly ? [BORIS] : [ANNA, BORIS],
          nextCursor: null,
        });
      }
      if (path === "/directory/search") {
        const q = options?.query?.q ?? "";
        if (q !== "smith") return Promise.resolve({ people: [] });
        return Promise.resolve({ people: holdersOnly ? [] : [SMITH] });
      }
      throw new Error(`unexpected path ${path}`);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** userEvent needs its own timer wiring once the debounce is faked. */
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it("browses the directory on arrival", async () => {
    renderDirectory();

    expect(await card("Anna Ivanova")).toBeInTheDocument();
    expect(await card("Boris Petrov")).toBeInTheDocument();
    expect(screen.getByText("2 people, by last name")).toBeInTheDocument();
    expect(calls("/directory/search")).toHaveLength(0);
  });

  it("searches once the typing pauses, not on every keystroke", async () => {
    renderDirectory();
    await card("Anna Ivanova");

    await user().type(box(), "smith");

    // Still inside the debounce window.
    expect(calls("/directory/search")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => expect(calls("/directory/search")).toHaveLength(1));
    expect(api).toHaveBeenCalledWith("/directory/search", {
      // React Query hands the query function an abort signal, which api()
      // forwards to fetch.
      signal: expect.any(AbortSignal),
      query: { q: "smith", accountHoldersOnly: undefined },
    });
  });

  it("replaces the browse list with the results and puts the query in the URL", async () => {
    renderDirectory();
    await card("Anna Ivanova");

    await user().type(box(), "smith");
    await vi.advanceTimersByTimeAsync(250);

    expect(await card("John Smith")).toBeInTheDocument();
    expect(noCard("Anna Ivanova")).not.toBeInTheDocument();
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?q=smith");
  });

  it("marks the typed fragment on each result, and nothing while browsing", async () => {
    const { container } = renderDirectory();
    await card("Anna Ivanova");

    // Browsing is not searching: there is no fragment to point at, so the cards
    // render exactly as they did before search learned to mark anything.
    expect(container.querySelectorAll("mark")).toHaveLength(0);

    await user().type(box(), "smith");
    await vi.advanceTimersByTimeAsync(250);
    await card("John Smith");

    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "Smith",
    ]);
  });

  it("says so when nothing matches", async () => {
    renderDirectory();
    await card("Anna Ivanova");

    await user().type(box(), "zzz");
    await vi.advanceTimersByTimeAsync(250);

    expect(await screen.findByText("Nothing matches \u201czzz\u201d")).toBeInTheDocument();
    expect(screen.getByText("0 matches")).toBeInTheDocument();
    // The live region has to carry it too, since the count above is a plain <p>.
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches zzz");
  });

  it("restores the browse list when the box is cleared, without refetching it", async () => {
    renderDirectory();
    await card("Anna Ivanova");

    await user().type(box(), "smith");
    await vi.advanceTimersByTimeAsync(250);
    await card("John Smith");

    expect(calls("/directory")).toHaveLength(1);

    await user().click(screen.getByRole("button", { name: /clear search/i }));
    await vi.advanceTimersByTimeAsync(250);

    expect(await card("Anna Ivanova")).toBeInTheDocument();
    expect(noCard("John Smith")).not.toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("");
    // The already-loaded page is reused rather than requested again.
    expect(calls("/directory")).toHaveLength(1);
  });

  it("searches straight away when the page is opened on a query", async () => {
    renderDirectory("/?q=smith");

    expect(await card("John Smith")).toBeInTheDocument();
    expect(box()).toHaveValue("smith");
    expect(calls("/directory/search")).toHaveLength(1);
  });

  it("ignores a slow earlier response that lands after a faster later one", async () => {
    let settleStale: ((value: { people: PersonSummaryDto[] }) => void) | undefined;
    api.mockImplementation((path: string, options?: { query?: Query }) => {
      if (path === "/directory") {
        return Promise.resolve({ people: [ANNA, BORIS], nextCursor: null });
      }
      // The "smit" request is held open until after "smith" has answered.
      if (options?.query?.q === "smit") {
        return new Promise((resolve) => {
          settleStale = resolve as (value: { people: PersonSummaryDto[] }) => void;
        });
      }
      return Promise.resolve({ people: [SMITH] });
    });

    // Opening straight on ?q=smit leaves that request in flight without having
    // to land four keystrokes inside one debounce window.
    renderDirectory("/?q=smit");
    expect(await screen.findByText("Searching…")).toBeInTheDocument();

    await user().type(box(), "h");
    await vi.advanceTimersByTimeAsync(250);
    expect(await card("John Smith")).toBeInTheDocument();

    // The stale request answers last, and must not be allowed to win. act() so
    // its resolution is really flushed into a render; without that this passes
    // whether or not the guard exists.
    await act(async () => {
      settleStale?.({ people: [ANNA] });
    });

    expect(await card("John Smith")).toBeInTheDocument();
    expect(noCard("Anna Ivanova")).not.toBeInTheDocument();
  });

  describe("the account holders filter", () => {
    it("is off to begin with, and asks for everyone", async () => {
      renderDirectory();

      expect(await card("Anna Ivanova")).toBeInTheDocument();
      expect(filterBox()).not.toBeChecked();
      expect(queryOf("/directory", 0).accountHoldersOnly).toBeUndefined();
    });

    it("drops the people without an account when it is ticked", async () => {
      renderDirectory();
      await card("Anna Ivanova");

      await user().click(filterBox());

      expect(await screen.findByText("1 account holder, by last name")).toBeInTheDocument();
      expect(await card("Boris Petrov")).toBeInTheDocument();
      expect(noCard("Anna Ivanova")).not.toBeInTheDocument();

      // One extra request, carrying the flag -- the filtering is the server's.
      expect(calls("/directory")).toHaveLength(2);
      expect(queryOf("/directory", 1).accountHoldersOnly).toBe("true");
    });

    it("brings them back when it is unticked", async () => {
      renderDirectory();
      await card("Anna Ivanova");

      await user().click(filterBox());
      await screen.findByText("1 account holder, by last name");

      await user().click(filterBox());

      expect(await card("Anna Ivanova")).toBeInTheDocument();
      expect(screen.getByText("2 people, by last name")).toBeInTheDocument();
      expect(queryOf("/directory", 2).accountHoldersOnly).toBeUndefined();
    });

    it("starts filtered when the URL says so, without an unfiltered first pass", async () => {
      renderDirectory("/?accountHoldersOnly=true");

      expect(await card("Boris Petrov")).toBeInTheDocument();
      expect(filterBox()).toBeChecked();
      expect(noCard("Anna Ivanova")).not.toBeInTheDocument();
      // One request, already filtered: no unfiltered flash to correct.
      expect(calls("/directory")).toHaveLength(1);
      expect(queryOf("/directory", 0).accountHoldersOnly).toBe("true");
    });

    it("writes itself into the URL, and takes itself back out", async () => {
      renderDirectory();
      await card("Anna Ivanova");

      await user().click(filterBox());
      await screen.findByText("1 account holder, by last name");
      expect(screen.getByTestId("search")).toHaveTextContent("?accountHoldersOnly=true");

      await user().click(filterBox());
      await screen.findByText("2 people, by last name");
      expect(screen.getByTestId("search")).toHaveTextContent("");
    });

    /*
     * The debounced write used to hand setParams a whole new object, which
     * replaced the query string outright. With the filter living there too, that
     * would have switched it off again on the next keystroke.
     */
    it("survives typing a search, and the search survives it", async () => {
      renderDirectory("/?accountHoldersOnly=true");
      await card("Boris Petrov");

      await user().type(box(), "smith");
      await vi.advanceTimersByTimeAsync(250);

      await waitFor(() => expect(calls("/directory/search")).toHaveLength(1));
      expect(queryOf("/directory/search", 0).accountHoldersOnly).toBe("true");
      expect(filterBox()).toBeChecked();

      const url = screen.getByTestId("search").textContent ?? "";
      expect(url).toContain("q=smith");
      expect(url).toContain("accountHoldersOnly=true");
    });

    it("keeps the search when it is ticked mid-search", async () => {
      renderDirectory("/?q=smith");
      await card("John Smith");

      await user().click(filterBox());
      await waitFor(() => expect(calls("/directory/search")).toHaveLength(2));

      expect(queryOf("/directory/search", 1).q).toBe("smith");
      expect(box()).toHaveValue("smith");
      expect(screen.getByTestId("search").textContent).toContain("q=smith");
    });

    it("leaves a history entry, so the back button undoes it", async () => {
      renderDirectory();
      await card("Anna Ivanova");

      await user().click(filterBox());
      await screen.findByText("1 account holder, by last name");

      await user().click(screen.getByRole("button", { name: /go back/i }));

      expect(await card("Anna Ivanova")).toBeInTheDocument();
      expect(filterBox()).not.toBeChecked();
    });

    it("narrows a search as well as the browse list", async () => {
      renderDirectory("/?q=smith");
      await card("John Smith");

      await user().click(filterBox());

      await waitFor(() => expect(calls("/directory/search")).toHaveLength(2));
      expect(queryOf("/directory/search", 1).accountHoldersOnly).toBe("true");
      expect(noCard("John Smith")).not.toBeInTheDocument();
      expect(
        await screen.findByText(/only account holders are being searched/i)
      ).toBeInTheDocument();

      // And a way back out that does not require finding the checkbox again.
      await user().click(screen.getByRole("button", { name: /search everyone/i }));
      expect(await card("John Smith")).toBeInTheDocument();
      expect(filterBox()).not.toBeChecked();
    });

    it("blames itself, not an empty directory, when it leaves nobody", async () => {
      api.mockImplementation((path: string, options?: { query?: Query }) => {
        if (path !== "/directory") throw new Error(`unexpected path ${path}`);
        const holdersOnly = options?.query?.accountHoldersOnly === "true";
        return Promise.resolve({ people: holdersOnly ? [] : [ANNA], nextCursor: null });
      });

      renderDirectory();
      await card("Anna Ivanova");

      await user().click(filterBox());

      expect(await screen.findByText("No account holders")).toBeInTheDocument();
      expect(screen.queryByText("Nobody here yet")).not.toBeInTheDocument();

      await user().click(screen.getByRole("button", { name: /show everyone/i }));

      expect(await card("Anna Ivanova")).toBeInTheDocument();
      expect(filterBox()).not.toBeChecked();
    });

    it("does not let a page of the old filter land on the new list", async () => {
      let settleStale: ((value: unknown) => void) | undefined;
      api.mockImplementation((path: string, options?: { query?: Query }) => {
        if (path !== "/directory") throw new Error(`unexpected path ${path}`);
        // "Show more" is held open until after the toggle has been answered.
        if (options?.query?.cursorId) {
          return new Promise((resolve) => {
            settleStale = resolve;
          });
        }
        const holdersOnly = options?.query?.accountHoldersOnly === "true";
        return Promise.resolve({
          people: holdersOnly ? [BORIS] : [ANNA],
          nextCursor: holdersOnly
            ? null
            : { lastName: "Ivanova", firstName: "Anna", id: "anna-id" },
        });
      });

      renderDirectory();
      await card("Anna Ivanova");

      // The button disables itself while the page is in flight; the checkbox
      // does not, which is how the two requests come to overlap.
      await user().click(screen.getByRole("button", { name: /show more/i }));
      await user().click(filterBox());
      expect(await screen.findByText("1 account holder, by last name")).toBeInTheDocument();

      await act(async () => {
        settleStale?.({ people: [SMITH], nextCursor: null });
      });

      // Appending it would have put an account-less person back on a filtered
      // list, and left a cursor from the wrong set behind.
      expect(noCard("John Smith")).not.toBeInTheDocument();
      expect(screen.getByText("1 account holder, by last name")).toBeInTheDocument();
    });
  });
});
