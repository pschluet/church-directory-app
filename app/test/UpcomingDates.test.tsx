import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { renderWithProviders } from "./utils";
import { UpcomingDates } from "../src/pages/UpcomingDates";

/*
 * This page keeps everything about what you are looking at -- the view, the
 * range, the month, the selected day -- in the query string, so that leaving it
 * for somebody's page and pressing the back chevron brings it back as it was
 * rather than reset to the list of the next seven days. These cases are about
 * that: what the URL is read as, and which writes are undoable.
 */

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

interface Call {
  query?: { start?: string; days?: number; year?: number; month?: number };
}

function respond() {
  api.mockImplementation((path: string, options: Call = {}) => {
    if (path === "/special-dates/upcoming") {
      return Promise.resolve({
        start: "2026-09-07",
        end: "2026-09-13",
        days: [],
        requestedDays: options.query?.days,
      });
    }
    return Promise.resolve({
      year: options.query?.year,
      month: options.query?.month,
      days: [],
    });
  });
}

/** The URL the page has written, so the push/replace split can be asserted. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{`${location.pathname}${location.search}`}</output>;
}

function show(entry = "/dates") {
  respond();
  return renderWithProviders(
    <>
      <UpcomingDates />
      <Address />
    </>,
    { initialEntries: [entry] }
  );
}

const address = () => screen.getByTestId("address").textContent;

/** The query passed to whichever endpoint was called last. */
function lastQuery(path: string) {
  const call = api.mock.calls.filter((c) => c[0] === path).at(-1);
  return (call?.[1] as Call | undefined)?.query;
}

describe("UpcomingDates", () => {
  it("defaults to the list and the next seven days, with no query string at all", async () => {
    show();
    await waitFor(() => expect(lastQuery("/special-dates/upcoming")?.days).toBe(7));
    expect(address()).toBe("/dates");
    expect(screen.getByRole("button", { name: "list" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reads the view out of the URL", async () => {
    show("/dates?view=calendar");
    expect(await screen.findByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "calendar" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("reads the month out of the URL rather than showing the current one", async () => {
    show("/dates?view=calendar&month=2027-03");
    await waitFor(() =>
      expect(lastQuery("/special-dates/calendar")).toEqual({
        year: 2027,
        month: 3,
      })
    );
    expect(screen.getByText(/March 2027/)).toBeInTheDocument();
  });

  it("reads the range out of the URL, clamped to something a server will accept", async () => {
    // Hand-editable now that it is in the address bar, so `days=-4` has to mean
    // the minimum and not a negative window.
    show("/dates?days=-4");
    await waitFor(() => expect(lastQuery("/special-dates/upcoming")?.days).toBe(1));
  });

  it("falls back to the default when the range is not a number", async () => {
    show("/dates?days=banana");
    await waitFor(() => expect(lastQuery("/special-dates/upcoming")?.days).toBe(7));
  });

  it("falls back to this month when the month is malformed", async () => {
    show("/dates?view=calendar&month=2026-13");
    const now = new Date();
    await waitFor(() =>
      expect(lastQuery("/special-dates/calendar")).toEqual({
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      })
    );
  });

  it("pushes the view and the range presets, so the back button undoes them", async () => {
    show();
    await screen.findByRole("button", { name: "14 days" });

    await userEvent.click(screen.getByRole("button", { name: "14 days" }));
    expect(address()).toBe("/dates?days=14");

    // Back to the default drops the param rather than spelling it out.
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(address()).toBe("/dates");

    await userEvent.click(screen.getByRole("button", { name: "calendar" }));
    expect(address()).toBe("/dates?view=calendar");
  });

  it("clears the selected day when the month changes, in the one write", async () => {
    /*
     * The day that was selected belongs to the month being left behind. Leaving
     * it would put a date in the URL that the grid on screen does not show, and
     * a list underneath describing a day you cannot see.
     */
    show("/dates?view=calendar&month=2026-09&day=2026-09-07");
    await screen.findByRole("button", { name: "Previous month" });

    await userEvent.click(screen.getByRole("button", { name: "Next month" }));

    expect(address()).toBe("/dates?view=calendar&month=2026-10");
  });

  it("selects today when the grid is showing this month", async () => {
    // With no `day` param, today -- so opening the calendar lands on something
    // rather than on an empty selection.
    const now = new Date();
    show(
      `/dates?view=calendar&month=${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    );
    expect(await screen.findByText("Nothing on this day")).toBeInTheDocument();
  });

  it("selects nothing when today is not a day the grid is showing", async () => {
    /*
     * The other half of the rule above. Without it, paging to another month and
     * reloading selects a date the grid does not show, and the list underneath
     * describes a day you cannot see.
     */
    show("/dates?view=calendar&month=2027-03");
    await screen.findByRole("button", { name: "Previous month" });
    expect(screen.queryByText("Nothing on this day")).not.toBeInTheDocument();
  });
});
