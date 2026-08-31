import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
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

function person(id: string, firstName: string, lastName: string): PersonSummaryDto {
  return {
    id,
    organizationId: "org-1",
    familyId: null,
    familyName: null,
    appUserId: null,
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

const ANNA = person("anna-id", "Anna", "Ivanova");
const BORIS = person("boris-id", "Boris", "Petrov");
const SMITH = person("smith-id", "John", "Smith");

/** Lets a test read the query string the page has written. */
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderDirectory(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Directory />
      <LocationProbe />
    </MemoryRouter>
  );
}

const box = () => screen.getByRole("searchbox", { name: /search the directory/i });
const calls = (path: string) => api.mock.calls.filter(([called]) => called === path);

describe("Directory", () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation((path: string, options?: { query?: { q?: string } }) => {
      if (path === "/directory") {
        return Promise.resolve({ people: [ANNA, BORIS], nextCursor: null });
      }
      if (path === "/directory/search") {
        const q = options?.query?.q ?? "";
        return Promise.resolve({ people: q === "smith" ? [SMITH] : [] });
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

    expect(await screen.findByText("Anna Ivanova")).toBeInTheDocument();
    expect(screen.getByText("Boris Petrov")).toBeInTheDocument();
    expect(screen.getByText("2 people, by last name")).toBeInTheDocument();
    expect(calls("/directory/search")).toHaveLength(0);
  });

  it("searches once the typing pauses, not on every keystroke", async () => {
    renderDirectory();
    await screen.findByText("Anna Ivanova");

    await user().type(box(), "smith");

    // Still inside the debounce window.
    expect(calls("/directory/search")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => expect(calls("/directory/search")).toHaveLength(1));
    expect(api).toHaveBeenCalledWith("/directory/search", { query: { q: "smith" } });
  });

  it("replaces the browse list with the results and puts the query in the URL", async () => {
    renderDirectory();
    await screen.findByText("Anna Ivanova");

    await user().type(box(), "smith");
    await vi.advanceTimersByTimeAsync(250);

    expect(await screen.findByText("John Smith")).toBeInTheDocument();
    expect(screen.queryByText("Anna Ivanova")).not.toBeInTheDocument();
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("?q=smith");
  });

  it("says so when nothing matches", async () => {
    renderDirectory();
    await screen.findByText("Anna Ivanova");

    await user().type(box(), "zzz");
    await vi.advanceTimersByTimeAsync(250);

    expect(await screen.findByText("Nothing matches \u201czzz\u201d")).toBeInTheDocument();
    expect(screen.getByText("0 matches")).toBeInTheDocument();
    // The live region has to carry it too, since the count above is a plain <p>.
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches zzz");
  });

  it("restores the browse list when the box is cleared, without refetching it", async () => {
    renderDirectory();
    await screen.findByText("Anna Ivanova");

    await user().type(box(), "smith");
    await vi.advanceTimersByTimeAsync(250);
    await screen.findByText("John Smith");

    expect(calls("/directory")).toHaveLength(1);

    await user().click(screen.getByRole("button", { name: /clear search/i }));
    await vi.advanceTimersByTimeAsync(250);

    expect(await screen.findByText("Anna Ivanova")).toBeInTheDocument();
    expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("");
    // The already-loaded page is reused rather than requested again.
    expect(calls("/directory")).toHaveLength(1);
  });

  it("searches straight away when the page is opened on a query", async () => {
    renderDirectory("/?q=smith");

    expect(await screen.findByText("John Smith")).toBeInTheDocument();
    expect(box()).toHaveValue("smith");
    expect(calls("/directory/search")).toHaveLength(1);
  });

  it("ignores a slow earlier response that lands after a faster later one", async () => {
    let settleStale: ((value: { people: PersonSummaryDto[] }) => void) | undefined;
    api.mockImplementation((path: string, options?: { query?: { q?: string } }) => {
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
    expect(await screen.findByText("John Smith")).toBeInTheDocument();

    // The stale request answers last, and must not be allowed to win. act() so
    // its resolution is really flushed into a render; without that this passes
    // whether or not the guard exists.
    await act(async () => {
      settleStale?.({ people: [ANNA] });
    });

    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.queryByText("Anna Ivanova")).not.toBeInTheDocument();
  });
});
