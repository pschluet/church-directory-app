import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { SpecialDateOccurrenceDto } from "@shared";
import { SpecialDateList } from "../src/components/SpecialDateList";

function occurrence(overrides: Partial<SpecialDateOccurrenceDto>): SpecialDateOccurrenceDto {
  return {
    id: "date-1",
    personId: "person-1",
    personName: "Paul Schlueter",
    type: "BIRTHDAY",
    month: 5,
    day: 4,
    year: 1985,
    showYearCount: false,
    relatedPersonId: null,
    relatedPersonName: null,
    patronSaint: null,
    date: "2026-05-04",
    yearCount: null,
    ...overrides,
  };
}

function renderList(days: { date: string; dates: SpecialDateOccurrenceDto[] }[]) {
  return render(
    <MemoryRouter>
      <SpecialDateList days={days} />
    </MemoryRouter>
  );
}

describe("SpecialDateList", () => {
  it("shows an age only when the person opted in", () => {
    renderList([
      {
        date: "2026-05-04",
        dates: [
          occurrence({ id: "a", personName: "Paul Schlueter", yearCount: 41 }),
          occurrence({ id: "b", personName: "Maria Schlueter", yearCount: null }),
        ],
      },
    ]);

    expect(screen.getByText("Turning 41")).toBeInTheDocument();
    expect(screen.getByText("Maria Schlueter")).toBeInTheDocument();
    // Only one age is displayed, not two.
    expect(screen.queryAllByText(/turning/i)).toHaveLength(1);
  });

  it("names both people on an anniversary and links each", () => {
    renderList([
      {
        date: "2026-06-12",
        dates: [
          occurrence({
            type: "ANNIVERSARY",
            personName: "Paul Schlueter",
            relatedPersonId: "person-2",
            relatedPersonName: "Maria Schlueter",
            yearCount: 16,
          }),
        ],
      },
    ]);

    expect(screen.getByRole("link", { name: "Paul Schlueter" })).toHaveAttribute(
      "href",
      "/people/person-1"
    );
    expect(screen.getByRole("link", { name: "Maria Schlueter" })).toHaveAttribute(
      "href",
      "/people/person-2"
    );
    expect(screen.getByText("16 years married")).toBeInTheDocument();
  });

  it("labels a name day with the patron saint", () => {
    renderList([
      {
        date: "2026-07-25",
        dates: [occurrence({ type: "FEAST_DAY", year: null, patronSaint: "St. Anna" })],
      },
    ]);

    expect(screen.getByText("Name Day")).toBeInTheDocument();
    expect(screen.getByText("St. Anna")).toBeInTheDocument();
  });

  it("skips days with nothing on them", () => {
    renderList([
      { date: "2026-05-04", dates: [occurrence({})] },
      { date: "2026-05-05", dates: [] },
      { date: "2026-05-06", dates: [occurrence({ id: "c", personName: "Boris Popov" })] },
    ]);

    // Two headings, not three.
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("explains itself when the whole window is empty", () => {
    renderList([{ date: "2026-05-04", dates: [] }]);
    expect(screen.getByText(/nothing coming up/i)).toBeInTheDocument();
    expect(screen.getByText(/try a longer range/i)).toBeInTheDocument();
  });
});
