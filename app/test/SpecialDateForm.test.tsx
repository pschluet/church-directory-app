import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialDateForm } from "../src/components/SpecialDateForm";
import { renderWithProviders, chooseOption, openOptions } from "./utils";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
  uploadPhoto: vi.fn(),
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

function renderForm() {
  // Call history on this mock is otherwise shared across every test in the
  // file (`vi.restoreAllMocks` in the global setup does not clear a plain
  // `vi.fn()`'s history), which would let one test's successful POST leak
  // into a later `not.toHaveBeenCalledWith` assertion.
  api.mockClear();
  api.mockResolvedValue({ people: [] });
  return renderWithProviders(
    <SpecialDateForm personId="person-id" onSaved={vi.fn()} onCancel={vi.fn()} />
  );
}

/**
 * The year field is the only textbox on the form (month and day are selects),
 * so query it by role: a text match on /year/i also hits the age checkbox's
 * "enter a year first" help text.
 */
const yearInput = () => screen.getByRole("textbox", { name: /year/i });

/** The days the Day dropdown offers, read by opening it and closing it again. */
async function dayOptions(): Promise<string[]> {
  const list = await openOptions(screen.getByRole("combobox", { name: "Day" }));
  const days = Array.from(
    list.querySelectorAll('[role="option"]'),
    (option) => option.textContent ?? ""
  );
  await userEvent.keyboard("{Escape}");
  return days;
}

describe("SpecialDateForm", () => {
  it("keeps the age checkbox disabled until a year is entered", async () => {
    renderForm();

    const checkbox = screen.getByRole("checkbox", { name: /show my age/i });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/enter a year first/i)).toBeInTheDocument();

    await userEvent.type(yearInput(), "1985");

    expect(checkbox).toBeEnabled();
    expect(screen.getByText(/off by default/i)).toBeInTheDocument();
  });

  it("clearing the year turns the age option back off", async () => {
    renderForm();
    const year = yearInput();
    await userEvent.type(year, "1985");
    await userEvent.click(screen.getByRole("checkbox", { name: /show my age/i }));
    expect(screen.getByRole("checkbox", { name: /show my age/i })).toBeChecked();

    await userEvent.clear(year);
    expect(screen.getByRole("checkbox", { name: /show my age/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /show my age/i })).toBeDisabled();
  });

  it("asks who the anniversary is with, and requires a year", async () => {
    renderForm();
    await chooseOption(screen.getByLabelText(/occasion/i), "ANNIVERSARY");

    expect(screen.getByRole("combobox", { name: /married to/i })).toBeInTheDocument();
    expect(yearInput()).toBeRequired();
    expect(screen.getByText(/links the two of you/i)).toBeInTheDocument();
  });

  /**
   * The picker is not a native `required` control any more, so the guard is the
   * shared schema -- which gives a real sentence rather than a browser tooltip.
   */
  it("refuses an anniversary with nobody on the other end", async () => {
    renderForm();
    await chooseOption(screen.getByLabelText(/occasion/i), "ANNIVERSARY");
    await userEvent.type(yearInput(), "2010");
    await userEvent.click(screen.getByRole("button", { name: /add date/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must link two people/i);
    expect(api).not.toHaveBeenCalledWith("/special-dates", expect.anything());
  });

  it("drops the year entirely for a name day", async () => {
    renderForm();
    await userEvent.type(yearInput(), "1985");
    await chooseOption(screen.getByLabelText(/occasion/i), "FEAST_DAY");

    expect(screen.queryByRole("textbox", { name: /year/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /show/i })).not.toBeInTheDocument();
    expect(screen.getByText(/patron saint/i)).toBeInTheDocument();
  });

  it("offers 29 February for a recurring date but not in a common year", async () => {
    renderForm();
    await chooseOption(screen.getByLabelText(/month/i), "2");

    // No year given: the date recurs, so the 29th is valid.
    expect(await dayOptions()).toContain("29");

    await userEvent.type(yearInput(), "2027");
    expect(await dayOptions()).not.toContain("29");

    await userEvent.clear(yearInput());
    await userEvent.type(yearInput(), "2028");
    expect(await dayOptions()).toContain("29");
  });

  it("never offers 31 April", async () => {
    renderForm();
    await chooseOption(screen.getByLabelText(/month/i), "4");
    const days = await dayOptions();
    expect(days).toContain("30");
    expect(days).not.toContain("31");
  });

  describe("a name day relative to a feast", () => {
    async function switchToFeastDay() {
      await chooseOption(screen.getByLabelText(/occasion/i), "FEAST_DAY");
    }

    it("only offers the fixed-or-relative choice for a name day", async () => {
      renderForm();
      expect(screen.queryByRole("group", { name: /how the date is set/i })).not.toBeInTheDocument();

      await switchToFeastDay();
      expect(screen.getByRole("group", { name: /how the date is set/i })).toBeInTheDocument();

      await chooseOption(screen.getByLabelText(/occasion/i), "BIRTHDAY");
      expect(screen.queryByRole("group", { name: /how the date is set/i })).not.toBeInTheDocument();
    });

    it("swaps the month and day for the rule fields, and back", async () => {
      renderForm();
      await switchToFeastDay();
      expect(screen.getByRole("combobox", { name: "Month" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /relative to a feast/i }));

      expect(screen.queryByRole("combobox", { name: "Month" })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Day" })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Feast" })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Count by" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /how many/i })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /before or after/i })).toBeInTheDocument();
      // Counting by days needs no day of the week.
      expect(screen.queryByRole("combobox", { name: /day of the week/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /^on a date$/i }));
      expect(screen.getByRole("combobox", { name: "Month" })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Feast" })).not.toBeInTheDocument();
    });

    it("shows the day-of-the-week field only when counting by weekday", async () => {
      renderForm();
      await switchToFeastDay();
      await userEvent.click(screen.getByRole("button", { name: /relative to a feast/i }));

      await chooseOption(screen.getByRole("combobox", { name: "Count by" }), "WEEKDAY");
      expect(screen.getByRole("combobox", { name: /day of the week/i })).toBeInTheDocument();

      await chooseOption(screen.getByRole("combobox", { name: "Count by" }), "DAYS");
      expect(screen.queryByRole("combobox", { name: /day of the week/i })).not.toBeInTheDocument();
    });

    it("previews the rule in words, and shows it moving across years", async () => {
      renderForm();
      await switchToFeastDay();
      await userEvent.click(screen.getByRole("button", { name: /relative to a feast/i }));
      await chooseOption(screen.getByRole("combobox", { name: "Count by" }), "WEEKDAY");

      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("1st Sunday after Pascha");
      // Three different years, so it reads as "this moves" rather than a fixed date.
      expect(status.textContent?.match(/\d{4}/g)).toHaveLength(3);
    });

    it("submits the rule with no month or day", async () => {
      renderForm();
      await switchToFeastDay();
      await userEvent.click(screen.getByRole("button", { name: /relative to a feast/i }));
      await chooseOption(screen.getByRole("combobox", { name: "Count by" }), "WEEKDAY");
      await userEvent.click(screen.getByRole("button", { name: /add date/i }));

      expect(api).toHaveBeenCalledWith(
        "/special-dates",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            personId: "person-id",
            type: "FEAST_DAY",
            month: null,
            day: null,
            rule: {
              reference: "PASCHA",
              direction: "AFTER",
              unit: "WEEKDAY",
              count: 1,
              weekday: 0,
            },
          }),
        })
      );
    });

    it('surfaces "counting starts at one" rather than posting an invalid rule', async () => {
      renderForm();
      await switchToFeastDay();
      await userEvent.click(screen.getByRole("button", { name: /relative to a feast/i }));
      await chooseOption(screen.getByRole("combobox", { name: "Count by" }), "WEEKDAY");
      const count = screen.getByRole("textbox", { name: /how many/i });
      await userEvent.clear(count);
      await userEvent.type(count, "0");
      await userEvent.click(screen.getByRole("button", { name: /add date/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/starts at one/i);
      expect(api).not.toHaveBeenCalledWith("/special-dates", expect.anything());
    });
  });
});
