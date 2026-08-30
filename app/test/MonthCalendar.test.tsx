import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SpecialDateOccurrenceDto } from "@shared";
import { MonthCalendar } from "../src/components/MonthCalendar";

const entry: SpecialDateOccurrenceDto = {
  id: "date-1",
  personId: "person-1",
  personName: "Paul Schlueter",
  type: "BIRTHDAY",
  month: 5,
  day: 4,
  year: 1985,
  showYearCount: true,
  relatedPersonId: null,
  relatedPersonName: null,
  patronSaint: null,
  date: "2026-05-04",
  yearCount: 41,
};

function renderCalendar(overrides: Partial<Parameters<typeof MonthCalendar>[0]> = {}) {
  const props = {
    year: 2026,
    month: 5,
    days: [{ date: "2026-05-04", dates: [entry] }],
    selectedDate: null,
    onSelectDate: vi.fn(),
    onChangeMonth: vi.fn(),
    ...overrides,
  };
  render(<MonthCalendar {...props} />);
  return props;
}

/**
 * The day cells are the buttons carrying aria-pressed; the month arrows do not.
 * Filtering on text content would miss any day that also renders entry
 * previews (those are in the DOM at every breakpoint and hidden with CSS).
 */
const dayCells = () =>
  screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));

describe("MonthCalendar", () => {
  it("renders one cell per day of the month", () => {
    renderCalendar();
    expect(dayCells()).toHaveLength(31);
  });

  it("gets February right in a leap year", () => {
    renderCalendar({ year: 2028, month: 2, days: [] });
    expect(screen.getByRole("button", { name: /february 29/i })).toBeInTheDocument();
  });

  it("gets February right in a common year", () => {
    renderCalendar({ year: 2027, month: 2, days: [] });
    expect(screen.queryByRole("button", { name: /february 29/i })).not.toBeInTheDocument();
  });

  it("announces how many dates a day has, for screen readers", () => {
    renderCalendar();
    expect(screen.getByRole("button", { name: "May 4, 1 special date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "May 5" })).toBeInTheDocument();
  });

  it("reports the day that was tapped", async () => {
    const props = renderCalendar();
    await userEvent.click(screen.getByRole("button", { name: /may 4/i }));
    expect(props.onSelectDate).toHaveBeenCalledWith("2026-05-04");
  });

  it("marks the selected day as pressed", () => {
    renderCalendar({ selectedDate: "2026-05-04" });
    expect(screen.getByRole("button", { name: /may 4/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "May 5" })).toHaveAttribute("aria-pressed", "false");
  });

  it("steps to the previous and next month, rolling over the year", async () => {
    const props = renderCalendar({ year: 2026, month: 1 });
    await userEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(props.onChangeMonth).toHaveBeenCalledWith(2025, 12);

    await userEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(props.onChangeMonth).toHaveBeenCalledWith(2026, 2);
  });

  it("keeps every day cell tappable on a phone", () => {
    renderCalendar();
    for (const cell of dayCells()) expect(cell).toHaveClass("tap-target");
  });
});
